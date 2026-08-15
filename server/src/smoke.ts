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

  console.log('SMOKE OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
