import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { ServerMessage } from '@pocketagent/protocol';

process.env.DOCKER_ENABLED = '0';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'pa-smoke-'));
process.env.PORT = '0';

const { buildApp } = await import('./index.js');
const { generatePairingCode } = await import('./pairing.js');
const { validateSecret } = await import('./secret-validate.js');
const { buildPromptBody } = await import('./sessions.js');
type FetchLike = import('./secret-validate.js').FetchLike;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
}

interface Waiter {
  pred: (m: ServerMessage) => boolean;
  resolve: (m: ServerMessage) => void;
  timer: NodeJS.Timeout;
}

class Client {
  private readonly ws: WebSocket;
  private readonly queue: ServerMessage[] = [];
  private readonly waiters: Waiter[] = [];
  readonly opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    this.ws.on('message', (d) => {
      this.onMessage(JSON.parse(String(d)) as ServerMessage);
    });
  }

  private onMessage(m: ServerMessage): void {
    const i = this.waiters.findIndex((w) => w.pred(m));
    if (i >= 0) {
      const w = this.waiters[i]!;
      clearTimeout(w.timer);
      this.waiters.splice(i, 1);
      w.resolve(m);
      return;
    }
    this.queue.push(m);
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }

  wait(pred: (m: ServerMessage) => boolean, timeoutMs = 15_000): Promise<ServerMessage> {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const j = this.waiters.findIndex((w) => w.resolve === resolve);
        if (j >= 0) this.waiters.splice(j, 1);
        reject(new Error('timeout waiting for message'));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, timer });
    });
  }

  closed(): Promise<boolean> {
    return new Promise((res) => this.ws.once('close', () => res(true)));
  }
}

async function request(c: Client, msg: Record<string, unknown> & { requestId: string }) {
  c.send(msg);
  return c.wait((m) => 'requestId' in m && m.requestId === msg.requestId);
}

function listen(server: import('node:http').Server): Promise<number> {
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => res((server.address() as AddressInfo).port));
  });
}

/** Raw request against a forward proxy: request-target is the absolute URI. */
function proxyGet(
  http: typeof import('node:http'),
  proxyPort: number,
  absoluteUrl: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxyPort, method: 'GET', path: absoluteUrl },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += String(c)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Remote-runner gateway: pure routing/auth logic plus the two servers it runs,
 * all without a docker daemon. Session ids are plain DNS labels, so '127.0.0.1'
 * is a valid one and lets us point the ingress at a local fake shim.
 */
async function gatewaySmoke(): Promise<void> {
  const http = await import('node:http');
  const { routeIngress, authorize, createIngressServer } = await import('./gateway.js');
  const { createEgressProxyServer, hostAllowed } = await import('./egress-proxy.js');
  const { GATEWAY_AUTH_HEADER } = await import('./config.js');

  // --- ingress URL mapping (pure) ---
  assert(
    routeIngress('/s/abc-123/status')?.target === 'http://abc-123:8080/status',
    'routeIngress maps /s/<id>/<path> onto the session alias',
  );
  assert(
    routeIngress('/s/abc/events?tail=1')?.target === 'http://abc:8080/events?tail=1',
    'routeIngress keeps the query string',
  );
  assert(routeIngress('/s/abc')?.target === 'http://abc:8080/', 'routeIngress handles a bare session prefix');
  assert(routeIngress('/s/abc/')?.sessionId === 'abc', 'routeIngress reports the session id');
  assert(routeIngress('/status') === null, 'routeIngress rejects paths outside /s/');
  assert(routeIngress('/s/../status') === null, 'routeIngress rejects traversal in the session id');
  assert(routeIngress('/s/ab c/status') === null, 'routeIngress rejects invalid session ids');
  assert(routeIngress('/s/abc/../../x') === null, 'routeIngress rejects traversal in the path');
  assert(routeIngress('http://evil/x') === null, 'routeIngress rejects absolute request targets');

  // --- shared-secret auth (pure) ---
  const token = 'gw-smoke-token';
  assert(authorize({ [GATEWAY_AUTH_HEADER]: token }, token), 'authorize accepts the configured token');
  assert(!authorize({ [GATEWAY_AUTH_HEADER]: 'nope' }, token), 'authorize rejects a wrong token');
  assert(!authorize({}, token), 'authorize rejects a missing header');
  assert(!authorize({ [GATEWAY_AUTH_HEADER]: token }, ''), 'authorize rejects an unset gateway token');

  // --- ingress server end-to-end against a fake shim ---
  const shim = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"status"}\n\n'); // stays open on purpose
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  const shimPort = await listen(shim);
  const ingress = createIngressServer({ token, shimPort });
  const ingressPort = await listen(ingress);
  const gwBase = `http://127.0.0.1:${ingressPort}/s/127.0.0.1`;

  const noAuth = await fetch(`${gwBase}/status`);
  assert(noAuth.status === 401, 'ingress rejects requests without the gateway header');
  const badAuth = await fetch(`${gwBase}/status`, { headers: { [GATEWAY_AUTH_HEADER]: 'wrong' } });
  assert(badAuth.status === 401, 'ingress rejects a wrong gateway token');
  const ok = await fetch(`${gwBase}/status`, { headers: { [GATEWAY_AUTH_HEADER]: token } });
  assert(ok.status === 200 && (await ok.text()) === '{"ok":true}', 'ingress proxies to the session shim');
  const noRoute = await fetch(`http://127.0.0.1:${ingressPort}/status`, {
    headers: { [GATEWAY_AUTH_HEADER]: token },
  });
  assert(noRoute.status === 404, 'ingress 404s unknown paths');

  // SSE must arrive before the upstream response ends (no buffering)
  const sseAc = new AbortController();
  const sse = await fetch(`${gwBase}/events`, {
    headers: { [GATEWAY_AUTH_HEADER]: token, accept: 'text/event-stream' },
    signal: sseAc.signal,
  });
  assert(sse.ok && sse.body !== null, 'ingress SSE request succeeds');
  const first = await Promise.race([
    sse.body!.getReader().read(),
    new Promise<{ value?: Uint8Array }>((_, rej) => setTimeout(() => rej(new Error('sse timeout')), 5_000)),
  ]);
  assert(
    new TextDecoder().decode(first.value).includes('"type":"status"'),
    'ingress streams SSE frames through without buffering',
  );
  sseAc.abort();

  // --- egress allowlist proxy ---
  assert(hostAllowed('objects.githubusercontent.com', ['*.githubusercontent.com']), 'hostAllowed matches wildcards');
  assert(!hostAllowed('githubusercontent.com', ['*.githubusercontent.com']), 'hostAllowed wildcard excludes the apex');
  assert(!hostAllowed('evil.com', ['github.com']), 'hostAllowed rejects unlisted hosts');

  const upstream = http.createServer((_req, res) => res.writeHead(200).end('pong'));
  const upstreamPort = await listen(upstream);
  const egress = createEgressProxyServer(['127.0.0.1']);
  const egressPort = await listen(egress);
  const allowed = await proxyGet(http, egressPort, `http://127.0.0.1:${upstreamPort}/ping`);
  assert(allowed.status === 200 && allowed.body === 'pong', 'egress proxy forwards allowlisted hosts');
  const blocked = await proxyGet(http, egressPort, 'http://blocked.example/x');
  assert(blocked.status === 403, 'egress proxy blocks hosts outside the allowlist');

  for (const s of [shim, ingress, upstream, egress]) s.close();
}

async function main(): Promise<void> {
  const { app, store } = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  const wsBase = `ws://127.0.0.1:${addr.port}/ws`;

  const health = await fetch(`${base}/api/health`);
  assert(health.ok, 'health endpoint responds');

  const c1 = new Client(wsBase);
  await c1.opened;
  c1.send({ type: 'hello', deviceId: 'nope', token: 'bad-token' });
  assert(await c1.closed(), 'bad token closes connection');

  const code = generatePairingCode(store);
  const pairRes = await fetch(`${base}/api/pairing/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'smoke-device' }),
  });
  const paired = (await pairRes.json()) as { ok: boolean; deviceId?: string; deviceToken?: string };
  assert(pairRes.ok && paired.ok && paired.deviceId && paired.deviceToken, 'pairing confirm ok');
  const reused = await fetch(`${base}/api/pairing/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'smoke-device-2' }),
  });
  assert(!reused.ok, 'pairing code cannot be reused');

  const c2 = new Client(wsBase);
  await c2.opened;
  c2.send({ type: 'hello', deviceId: paired.deviceId, token: paired.deviceToken });
  const welcome = await c2.wait((m) => m.type === 'welcome');
  assert(welcome.type === 'welcome' && welcome.ok, 'authenticated hello gets welcome');

  const adapters = await request(c2, { type: 'adapter.list', requestId: 'adp1' });
  assert(adapters.type === 'adapter.list' && adapters.adapters.length >= 5, 'adapter.list returns at least 5 adapters');
  const adapterIds = adapters.type === 'adapter.list' ? adapters.adapters.map((a) => a.id) : [];
  for (const expected of ['opencode', 'kilo', 'claude', 'pi', 'junie']) {
    assert(adapterIds.includes(expected), `adapter.list includes "${expected}"`);
  }
  const kilo = adapters.type === 'adapter.list' ? adapters.adapters.find((a) => a.id === 'kilo') : undefined;
  assert(kilo?.credentials?.kilo?.[0] === 'KILO_AUTH_CONTENT', 'kilo manifest carries credential mapping');

  const badAdapter = await request(c2, {
    type: 'session.create',
    requestId: 'ses0',
    repoId: 'irrelevant',
    adapter: 'does-not-exist',
    provider: 'openai',
    model: 'x',
    mode: 'ask',
  });
  assert(badAdapter.type === 'error', 'session.create with unknown adapter is rejected');

  const saved = await request(c2, {
    type: 'secret.set',
    requestId: 'sec1',
    kind: 'zai',
    value: 'sk-smoke-secret-value',
  });
  assert(saved.type === 'secret.saved', 'secret.set -> secret.saved');
  assert(!JSON.stringify(saved).includes('sk-smoke-secret-value'), 'secret value never returned');

  const secretList = await request(c2, { type: 'secret.list', requestId: 'sec2' });
  assert(
    secretList.type === 'secret.list' && secretList.secrets.length === 1 && secretList.secrets[0]!.kind === 'zai',
    'secret.list returns one zai entry without value',
  );

  /* ---- secret.validate: pure offline checks with a stubbed fetch ---- */
  const stubFetch = (status: number, body: unknown, calls: string[] = []): FetchLike =>
    (url) => {
      calls.push(url);
      return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
    };

  const okCalls: string[] = [];
  const okKey = await validateSecret('openai', 'sk-does-not-matter', {
    fetchImpl: stubFetch(200, { data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] }, okCalls),
  });
  assert(okKey.ok && okKey.detail === '2 Modelle verfügbar', 'validateSecret counts models on 2xx');
  assert(okCalls[0] === 'https://api.openai.com/v1/models', 'openai check hits the models endpoint');

  const badKey = await validateSecret('anthropic', 'sk-ant-nope', { fetchImpl: stubFetch(401, {}) });
  assert(!badKey.ok && badKey.detail === 'Key ungültig oder abgelaufen', '401 -> key invalid');

  const serverErr = await validateSecret('groq', 'x', { fetchImpl: stubFetch(500, {}) });
  assert(!serverErr.ok && serverErr.detail?.includes('500') === true, 'non-2xx surfaces the status');

  const offline = await validateSecret('github', 'ghp_x', {
    fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
  });
  assert(!offline.ok && offline.detail === 'Server erreicht Provider nicht', 'network failure is reported as such');

  const ghOk = await validateSecret('github', 'ghp_x', { fetchImpl: stubFetch(200, { login: 'octocat' }) });
  assert(ghOk.ok && ghOk.detail === 'Angemeldet als octocat', 'github check reports the login');

  const orCalls: string[] = [];
  await validateSecret('openrouter', 'sk-or-x', { fetchImpl: stubFetch(200, { data: {} }, orCalls) });
  assert(orCalls[0] === 'https://openrouter.ai/api/v1/key', 'openrouter uses the key endpoint, not /models');

  const timedOut = await validateSecret('openai', 'sk-x', {
    timeoutMs: 10,
    fetchImpl: (_url, init) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      }),
  });
  assert(!timedOut.ok && timedOut.detail?.startsWith('Zeitüberschreitung') === true, 'timeout aborts the request');

  const unchecked = await validateSecret('claude_oauth', 'token', {
    fetchImpl: () => Promise.reject(new Error('must not be called')),
  });
  assert(
    unchecked.ok && unchecked.unverified === true && unchecked.detail?.startsWith('Keine Live-Prüfung') === true,
    'kinds without a known check answer unverified without any request',
  );

  // WS round-trip on an unchecked kind: stays offline, proves the wiring.
  const validated = await request(c2, {
    type: 'secret.validate',
    requestId: 'val1',
    kind: 'kilo',
    value: 'super-secret-auth-json',
  });
  assert(
    validated.type === 'secret.validated' && validated.kind === 'kilo' && validated.ok && validated.unverified === true,
    'secret.validate -> secret.validated for an unchecked kind',
  );
  assert(!JSON.stringify(validated).includes('super-secret-auth-json'), 'secret.validated never echoes the value');

  const adapterProviders =
    adapters.type === 'adapter.list' ? adapters.adapters.find((a) => a.id === 'claude')?.providers : undefined;
  assert(
    adapterProviders?.some((p) => p.id === 'claude_oauth' && p.name.length > 0) === true,
    'claude manifest carries provider display metadata',
  );

  const added = await request(c2, {
    type: 'repo.add',
    requestId: 'repo1',
    fullName: 'acme/demo',
    defaultBranch: 'main',
  });
  assert(added.type === 'repo.added' && added.repo.fullName === 'acme/demo', 'repo.add -> repo.added');
  const repoList = await request(c2, { type: 'repo.list', requestId: 'repo2' });
  assert(repoList.type === 'repo.list' && repoList.repos.length === 1, 'repo.list returns repo');

  const created = await request(c2, {
    type: 'session.create',
    requestId: 'ses1',
    repoId: added.repo.id,
    adapter: 'opencode',
    provider: 'zai',
    model: 'glm-4.6',
    mode: 'yolo',
  });
  assert(created.type === 'request.ok', 'session.create -> request.ok immediately');
  const sessionId = (created.payload as { sessionId?: string } | undefined)?.sessionId;
  assert(typeof sessionId === 'string' && sessionId.length > 0, 'request.ok carries sessionId');
  const errorStatus = await c2.wait(
    (m) => m.type === 'session.status' && m.sessionId === sessionId && m.status === 'error',
    20_000,
  );
  assert(errorStatus.type === 'session.status' && errorStatus.status === 'error', 'docker-disabled session ends in error status');
  const errEvent = await c2.wait(
    (m) => m.type === 'session.event' && m.sessionId === sessionId && m.event.type === 'error',
    5_000,
  );
  assert(errEvent.type === 'session.event', 'error event broadcast with message');

  const badUpdate = await request(c2, {
    type: 'session.update',
    requestId: 'upd0',
    sessionId,
    reasoningEffort: 'extreme',
  });
  assert(badUpdate.type === 'error', 'session.update rejects unknown reasoningEffort');

  const updated = await request(c2, {
    type: 'session.update',
    requestId: 'upd1',
    sessionId,
    mode: 'ask',
    model: 'glm-4.6-air',
    reasoningEffort: 'high',
  });
  assert(updated.type === 'request.ok', 'session.update -> request.ok');
  const listAfter = await request(c2, { type: 'session.list', requestId: 'ses2' });
  const row = listAfter.type === 'session.list' ? listAfter.sessions.find((s) => s.id === sessionId) : undefined;
  assert(
    row?.mode === 'ask' && row.model === 'glm-4.6-air' && row.reasoningEffort === 'high',
    'session.update persists mode/model/reasoningEffort',
  );

  /* ---- prompt body: model '' is the documented "adapter default" reset ---- */
  const rowWithModel = store.getSession(sessionId);
  assert(rowWithModel !== undefined, 'session row readable');
  assert(buildPromptBody(rowWithModel, 'hi').model === 'glm-4.6-air', 'prompt body carries the session model');
  const resetUpdate = await request(c2, {
    type: 'session.update',
    requestId: 'upd2',
    sessionId,
    model: '',
  });
  assert(resetUpdate.type === 'request.ok', 'session.update accepts an empty model');
  const rowReset = store.getSession(sessionId);
  assert(rowReset !== undefined && rowReset.model === '', 'empty model persisted');
  const resetBody = buildPromptBody(rowReset, 'hi');
  assert('model' in resetBody && resetBody.model === '', "prompt body sends model:'' instead of dropping the reset");
  assert(resetBody.mode === 'ask', 'prompt body carries the switched mode');

  const models = await request(c2, { type: 'session.models.get', requestId: 'mod1', sessionId });
  assert(
    models.type === 'session.models' && Array.isArray(models.models),
    'session.models.get -> session.models (empty for unprovisioned session)',
  );

  const stats = await request(c2, { type: 'server.stats', requestId: 'stats1' });
  assert(
    stats.type === 'server.stats' && stats.stats.sessionsTotal >= 1 && stats.stats.uptimeSec >= 0,
    'server.stats works',
  );

  await gatewaySmoke();

  console.log('SMOKE OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
