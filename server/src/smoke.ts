import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { ServerMessage } from '@pocketagent/protocol';

process.env.DOCKER_ENABLED = '0';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'pa-smoke-'));
process.env.PORT = '0';

const { buildApp } = await import('./index.js');
const { generatePairingCode, SlidingWindowRateLimiter } = await import('./pairing.js');
const { validateSecret } = await import('./secret-validate.js');
const { buildPromptBody, isNoticePhase } = await import('./sessions.js');
type SessionManager = import('./sessions.js').SessionManager;
type Store = import('./db.js').Store;
type FetchLike = import('./secret-validate.js').FetchLike;
const vault = await import('./vault.js');
const admin = await import('./admin.js');
const { sha256 } = await import('./db.js');
const { config } = await import('./config.js');

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

  closeCode(): Promise<number> {
    return new Promise((res) => this.ws.once('close', (code: number) => res(code)));
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
  token?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: absoluteUrl,
        // same shape git/curl send from the proxy URL's userinfo
        headers: token
          ? { 'proxy-authorization': `Basic ${Buffer.from(`pa:${token}`).toString('base64')}` }
          : {},
      },
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
 * Raw CONNECT against the proxy (the path an https request takes), resolved
 * with the status code of the response line. 407 = refused by a gate, anything
 * else means both gates passed and the tunnel was attempted.
 */
function proxyConnect(
  net: typeof import('node:net'),
  proxyPort: number,
  hostPort: string,
  token?: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      const auth = token ? `Proxy-Authorization: Basic ${Buffer.from(`pa:${token}`).toString('base64')}\r\n` : '';
      sock.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n${auth}\r\n`);
    });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('proxy did not answer the CONNECT'));
    }, 10_000);
    let buf = '';
    sock.on('data', (c) => {
      buf += String(c);
      const status = /^HTTP\/1\.\d (\d{3})/.exec(buf.split('\r\n')[0] ?? '');
      if (!status) return;
      clearTimeout(timer);
      sock.destroy();
      resolve(Number(status[1]));
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * A CONNECT whose caller vanishes before the answer is written: the request
 * goes out, then the connection is reset instead of closed. That is what a
 * client does when it gives up on a refused tunnel, and it leaves the proxy
 * holding a socket whose next read fails with ECONNRESET.
 */
function proxyConnectAndReset(
  net: typeof import('node:net'),
  proxyPort: number,
  hostPort: string,
): Promise<void> {
  return new Promise((resolve) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`);
      // RST, not FIN - a clean close is the case that always worked.
      sock.resetAndDestroy();
      resolve();
    });
    sock.on('error', () => resolve());
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

  // Denial reasons must stay distinguishable: an unauthenticated caller gets
  // 407 (so it can authenticate), everything else 403.
  const { denyReason } = await import('./egress-proxy.js');
  assert(denyReason(false, '127.0.0.1', 443, ['127.0.0.1']) === 'auth', 'missing auth is reported as auth');
  assert(denyReason(true, '127.0.0.1', 8443, ['127.0.0.1']) === 'port', 'CONNECT to a foreign port is refused');
  assert(denyReason(true, '127.0.0.1', null, ['127.0.0.1']) === null, 'forwarded HTTP is not port-gated');
  assert(denyReason(true, 'evil.example', 443, ['127.0.0.1']) === 'host', 'unlisted host is reported as host');

  // A session token that the validator knows must tunnel; the same request
  // without credentials must not - this is the exact path a shim's git clone
  // takes, which previously failed with an opaque 403.
  const gated = createEgressProxyServer(['127.0.0.1'], (t) => t === 'live-session-token');
  const gatedPort = await listen(gated);
  const authed = await proxyGet(http, gatedPort, `http://127.0.0.1:${upstreamPort}/ping`, 'live-session-token');
  assert(authed.status === 200, 'egress proxy accepts a live session token');
  const unauthed = await proxyGet(http, gatedPort, `http://127.0.0.1:${upstreamPort}/ping`);
  assert(unauthed.status === 407, 'egress proxy answers 407 (not 403) without credentials');
  const staleToken = await proxyGet(http, gatedPort, `http://127.0.0.1:${upstreamPort}/ping`, 'not-a-session');
  assert(staleToken.status === 407, 'egress proxy rejects an unknown token');

  // A refused CONNECT followed by a reset used to end the whole orchestrator:
  // node hands the socket to the 'connect' handler without its own error
  // listener, so the ECONNRESET arriving while the 403 is written became an
  // unhandled 'error' event. The proxy has to stay usable afterwards - and if
  // it does not survive at all, this smoke run dies with it, which is the
  // assertion. Repeated because the reset has to race the write.
  const net = await import('node:net');
  for (let i = 0; i < 20; i++) {
    await proxyConnectAndReset(net, egressPort, 'blocked.example:443');
    await proxyConnectAndReset(net, egressPort, `127.0.0.1:${upstreamPort}`);
  }
  await new Promise((r) => setTimeout(r, 100));
  const afterReset = await proxyGet(http, egressPort, `http://127.0.0.1:${upstreamPort}/ping`);
  assert(afterReset.status === 200, 'the egress proxy still serves after a reset CONNECT');

  gated.close();

  for (const s of [shim, ingress, upstream, egress]) s.close();
}

/**
 * Session start against a fake docker daemon: the phased progress notices the
 * app renders while a session boots, plus the ordering invariant behind them -
 * a session's egress token must already be valid when its container starts,
 * otherwise the shim's first clone runs into a 407 on the allowlist proxy.
 */
async function startProgressSmoke(store: Store, manager: SessionManager, c2: Client, repoId: string): Promise<void> {
  const http = await import('node:http');
  const dockerMod = await import('./docker.js');
  const cfg = config as unknown as { dockerEnabled: boolean; dockerHost: string | null; dockerHostIsLocal: boolean };

  const CID = 'fake-container-id';
  const SECRET_LOOKING = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
  const LOG = [
    '[shim] boot',
    '[git] cloning https://github.com/acme/demo.git (branch main) -> /work',
    `Cloning into '/work'... token ${SECRET_LOOKING}`,
    '',
  ].join('\n');

  let createdEnv: string[] = [];
  let tokenValidAtStart: boolean | null = null;

  const daemon = http.createServer((req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';
    const send = (code: number, body: string, type = 'application/json'): void => {
      res.writeHead(code, { 'content-type': type }).end(body);
    };
    if (method === 'POST' && url.startsWith('/containers/create')) {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        createdEnv = (JSON.parse(body) as { Env?: string[] }).Env ?? [];
        send(201, JSON.stringify({ Id: CID, Warnings: [] }));
      });
      return;
    }
    req.resume();
    if (method === 'POST' && url === `/containers/${CID}/start`) {
      const token = createdEnv.find((e) => e.startsWith('SHIM_TOKEN='))?.slice('SHIM_TOKEN='.length) ?? '';
      tokenValidAtStart = token.length > 0 && manager.egressTokenAllowed(token);
      res.writeHead(204).end();
      return;
    }
    if (method === 'GET' && url.startsWith(`/containers/${CID}/logs`)) return send(200, LOG, 'application/octet-stream');
    if (method === 'POST' && url.startsWith('/volumes/create')) return send(201, '{"Name":"v"}');
    send(200, '{}'); // network inspect/connect, image inspect, everything else
  });
  const daemonPort = await listen(daemon);

  const hostnameBefore = process.env.HOSTNAME;
  process.env.HOSTNAME = 'smoke-orchestrator';
  cfg.dockerHost = `http://127.0.0.1:${daemonPort}`;
  cfg.dockerHostIsLocal = true; // socket-proxy semantics: local behaviour, no published ports
  cfg.dockerEnabled = true;
  dockerMod.resetDockerClient();

  // The egress setup of a starting session has to be readable from the server
  // log alone - "denied ... no proxy credentials" says nothing about which side
  // of the container boundary lost the credentials.
  const logged: string[] = [];
  const logBefore = console.log;
  console.log = (...args: unknown[]): void => {
    logged.push(args.map((a) => String(a)).join(' '));
    logBefore(...args);
  };

  let sessionId = '';
  try {
    const created = await request(c2, {
      type: 'session.create',
      requestId: 'prog1',
      repoId,
      adapter: 'opencode',
      provider: 'zai',
      model: 'glm-4.6',
      mode: 'ask',
    });
    assert(created.type === 'request.ok', 'progress session created');
    sessionId = (created.payload as { sessionId: string }).sessionId;

    const isNoticeFor = (m: ServerMessage, phase: string): boolean =>
      m.type === 'session.event' && m.sessionId === sessionId && m.event.type === 'notice' && m.event.phase === phase;

    const starting = await c2.wait((m) => isNoticeFor(m, 'container-start'), 20_000);
    assert(
      starting.type === 'session.event' &&
        starting.event.type === 'notice' &&
        starting.event.message === 'Container startet',
      'the app is told when the container starts',
    );

    const booting = await c2.wait((m) => isNoticeFor(m, 'shim-start'), 20_000);
    const bootNotice = booting.type === 'session.event' && booting.event.type === 'notice' ? booting.event : null;
    assert(bootNotice?.message === 'Repo wird geklont', 'a clone line in the container log becomes "Repo wird geklont"');
    assert(bootNotice?.detail?.includes('[git] cloning') === true, 'the shim-start notice carries the log tail');
    assert(bootNotice?.detail?.includes(SECRET_LOOKING) === false, 'token-shaped words are masked in a live detail');

    assert(tokenValidAtStart === true, 'the egress token is valid before the container starts (proxy 407 race)');
    assert(
      createdEnv.some((e) => e.startsWith('HTTP_PROXY=http://pa:')),
      'allowlist sessions reach the network through the authenticated egress proxy',
    );
    assert(store.getSession(sessionId)?.container_id === CID, 'the container id is recorded before the start');

    const setupLine = logged.find((l) => l.startsWith(`[docker] session ${sessionId.slice(0, 8)} `));
    assert(setupLine !== undefined, 'the container creation logs the session egress setup');
    assert(
      setupLine?.includes('policy=allowlist') === true &&
        setupLine.includes('egress=orchestrator:') &&
        setupLine.endsWith('auth=yes'),
      `the egress setup line names policy, proxy and whether credentials are set: ${String(setupLine)}`,
    );
    assert(!logged.some((l) => l.includes(String(store.getSession(sessionId)?.shim_token))), 'the log never carries the token');
  } finally {
    console.log = logBefore;
    cfg.dockerEnabled = false;
    cfg.dockerHost = null;
    cfg.dockerHostIsLocal = false;
    dockerMod.resetDockerClient();
    if (hostnameBefore === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = hostnameBefore;
    daemon.close();
    // The shim never answers here, so provisioning keeps polling in the
    // background until its timeout - dropping the session ends it cleanly.
    if (sessionId) await manager.deleteSession(sessionId).catch(() => {});
  }
}

/**
 * Egress authorization that does not depend on the HTTP client: an 'allowlist'
 * session reaches the network when its source IP belongs to a live session
 * container, even without Proxy-Authorization (node/undici drop the userinfo of
 * HTTP(S)_PROXY, git sends it). The token gate stays the second path, and the
 * only caller that could ever build a proxy URL without credentials - a push on
 * a session without shim_token - is refused before the container exists.
 */
async function egressPeerSmoke(store: Store, manager: SessionManager, repoId: string): Promise<void> {
  const http = await import('node:http');
  const dockerMod = await import('./docker.js');
  const { createEgressProxyServer, normalizePeerIp } = await import('./egress-proxy.js');
  const cfg = config as unknown as { dockerEnabled: boolean; dockerHost: string | null; dockerHostIsLocal: boolean };

  /* ---- peer address normalization (pure) ---- */

  assert(normalizePeerIp('::ffff:10.0.0.5') === '10.0.0.5', 'an IPv4-mapped IPv6 peer normalizes to its IPv4 form');
  assert(normalizePeerIp('10.0.0.5') === '10.0.0.5', 'a plain IPv4 peer stays as it is');
  assert(normalizePeerIp('FE80::1%eth0') === 'fe80::1', 'the zone id of a link-local peer is stripped');
  assert(normalizePeerIp(undefined) === '', 'a socket without a peer address normalizes to empty');

  /* ---- the two gates on a live proxy ---- */

  const upstream = http.createServer((_req, res) => res.writeHead(200).end('pong'));
  const upstreamPort = await listen(upstream);
  const peers = new Set(['127.0.0.1']);
  const proxy = createEgressProxyServer(
    ['127.0.0.1'],
    (t) => t === 'live-session-token',
    (ip) => peers.has(ip),
  );
  const proxyPort = await listen(proxy);
  const target = `http://127.0.0.1:${upstreamPort}/ping`;

  const byPeer = await proxyGet(http, proxyPort, target);
  assert(byPeer.status === 200, 'a request from a live session container passes without any credentials');
  peers.clear();
  const unknownPeer = await proxyGet(http, proxyPort, target);
  assert(unknownPeer.status === 407, 'an unknown peer without credentials is refused with 407');
  const byToken = await proxyGet(http, proxyPort, target, 'live-session-token');
  assert(byToken.status === 200, 'a valid token still passes when the peer is unknown');
  const badBoth = await proxyGet(http, proxyPort, target, 'stale-token');
  assert(badBoth.status === 407, 'an unknown token from an unknown peer stays refused');

  // CONNECT reads the peer from the tunnel socket, not from the request - the
  // https path every LLM call takes, and the one that failed in production.
  const net = await import('node:net');
  const blindConnect = await proxyConnect(net, proxyPort, '127.0.0.1:443');
  assert(blindConnect === 407, 'CONNECT without credentials from an unknown peer is refused');
  peers.add('127.0.0.1');
  const peerConnect = await proxyConnect(net, proxyPort, '127.0.0.1:443');
  assert(peerConnect !== 407, 'CONNECT from a live session container needs no credentials');
  peers.clear();

  /* ---- push without a shim token: refused before a container exists ---- */

  const tokenless = randomUUID();
  const now = new Date().toISOString();
  store.insertSession({
    id: tokenless,
    tenant_id: 'default',
    repo_id: repoId,
    repo_full_name: 'acme/demo',
    adapter: 'opencode',
    provider: 'zai',
    model: 'glm-4.6',
    mode: 'ask',
    status: 'idle',
    branch: `agent/${tokenless}`,
    session_ref: null,
    container_id: null,
    volume_name: `pocketagent-sess-${tokenless}`,
    shim_token: null,
    pr_url: null,
    shim_endpoint: null,
    link_id: null,
    network_policy: 'allowlist',
    reasoning_effort: null,
    title: null,
    archived: 0,
    created_at: now,
    last_active_at: now,
  });
  let pushError = '';
  await manager.push(tokenless).catch((e: unknown) => {
    pushError = e instanceof Error ? e.message : String(e);
  });
  assert(pushError.includes('not provisioned'), 'a push without a shim token is refused instead of run without proxy credentials');
  await manager.deleteSession(tokenless).catch(() => {});

  /* ---- ip -> session lookup against a fake daemon (cache, failures) ---- */

  let listCalls = 0;
  let daemonBroken = false;
  const daemon = http.createServer((req, res) => {
    req.resume();
    if ((req.url ?? '').startsWith('/containers/json')) {
      listCalls++;
      if (daemonBroken) return void res.writeHead(500).end('{"message":"daemon down"}');
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify([
          {
            Id: 'cid-peer',
            NetworkSettings: { Networks: { 'pocketagent-s-1': { IPAddress: '10.9.0.7' } } },
          },
        ]),
      );
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  const daemonPort = await listen(daemon);

  cfg.dockerHost = `http://127.0.0.1:${daemonPort}`;
  cfg.dockerHostIsLocal = true;
  cfg.dockerEnabled = true;
  dockerMod.resetDockerClient();
  try {
    await dockerMod.refreshSessionPeers();
    assert(listCalls === 1, 'the peer set is loaded with a single daemon call');
    assert(manager.egressPeerAllowed('10.9.0.7'), 'the IP of a live session container authorizes');
    assert(manager.egressPeerAllowed('::ffff:10.9.0.7'), 'the same IP as IPv4-mapped IPv6 authorizes');
    assert(!manager.egressPeerAllowed('10.9.0.8'), 'an IP outside the session containers does not authorize');
    assert(!manager.egressPeerAllowed(''), 'an empty peer address never authorizes');
    assert(listCalls === 1, 'the lookup is cached - no daemon call per proxied request');

    daemonBroken = true;
    await dockerMod.refreshSessionPeers();
    assert(!manager.egressPeerAllowed('10.9.0.7'), 'a failing daemon denies conservatively instead of crashing');
  } finally {
    cfg.dockerEnabled = false;
    cfg.dockerHost = null;
    cfg.dockerHostIsLocal = false;
    dockerMod.resetDockerClient();
    daemon.close();
    proxy.close();
    upstream.close();
  }
}

/**
 * Startup reconcile + request-path self healing against a fake docker daemon
 * and a fake shim. Both model the production case behind them: a redeploy
 * replaces the orchestrator container, so it hangs on no session network any
 * more and holds no event stream, while the session containers keep running.
 */
async function reconcileSmoke(store: Store, manager: SessionManager, c2: Client, repoId: string): Promise<void> {
  const http = await import('node:http');
  const dockerMod = await import('./docker.js');
  const cfg = config as unknown as {
    dockerEnabled: boolean;
    dockerHost: string | null;
    dockerHostIsLocal: boolean;
    gatewayToken: string | null;
  };

  const now = new Date().toISOString();
  const rowFor = (id: string, policy: string | null, status: string, containerId: string): import('./db.js').SessionRow => ({
    id,
    tenant_id: 'default',
    repo_id: repoId,
    repo_full_name: 'acme/demo',
    adapter: 'opencode',
    provider: 'zai',
    model: 'glm-4.6',
    mode: 'ask',
    status,
    branch: `agent/${id}`,
    session_ref: null,
    container_id: containerId,
    volume_name: `pocketagent-sess-${id}`,
    shim_token: `token-${id.slice(0, 8)}`,
    pr_url: null,
    shim_endpoint: null,
    link_id: null,
    network_policy: policy,
    reasoning_effort: null,
    title: null,
    archived: 0,
    created_at: now,
    last_active_at: now,
  });

  /* ---- sessionNetworkFor: policy -> network name, mode -> relay (pure) ---- */

  const probe = rowFor(randomUUID(), 'allowlist', 'idle', 'cid-probe');
  assert(
    dockerMod.sessionNetworkFor(probe).name === dockerMod.sessionNetworkName(probe.id),
    'allowlist sessions live on their own per-session network',
  );
  assert(
    dockerMod.sessionNetworkFor({ ...probe, network_policy: 'isolated' }).name === dockerMod.sessionNetworkName(probe.id),
    'isolated sessions live on their own per-session network',
  );
  assert(
    dockerMod.sessionNetworkFor({ ...probe, network_policy: 'open' }).name === config.networkName,
    'open sessions share the main network',
  );
  assert(
    dockerMod.sessionNetworkFor({ ...probe, network_policy: 'nonsense' }).name === dockerMod.sessionNetworkName(probe.id),
    'an unreadable policy falls back to the configured default (allowlist)',
  );
  assert(dockerMod.sessionNetworkFor(probe).relay === 'orchestrator', 'locally the orchestrator itself is the relay');
  cfg.dockerHost = 'tcp://runner.example:2375';
  cfg.dockerHostIsLocal = false;
  assert(dockerMod.sessionNetworkFor(probe).relay === 'none', 'remote without gateway reaches the shim via a published port');
  cfg.gatewayToken = 'gw-smoke';
  assert(dockerMod.sessionNetworkFor(probe).relay === 'gateway', 'remote with a gateway relays through the gateway container');
  assert(
    dockerMod.sessionNetworkFor({ ...probe, network_policy: 'open' }).name === config.networkName,
    'gateway mode keeps open sessions on the main network',
  );
  cfg.gatewayToken = null;
  cfg.dockerHost = null;

  /* ---- fake shim: SSE stream + a /prompt that can fail at the transport ---- */

  let shimMode: 'ok' | 'fail-once' | 'dead' = 'ok';
  let promptCalls = 0;
  const shim = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"notice","message":"stream-live"}\n\n'); // stays open
      return;
    }
    if (url.startsWith('/prompt')) {
      promptCalls++;
      if (shimMode === 'dead' || (shimMode === 'fail-once' && promptCalls === 1)) return void res.destroy();
      return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  const shimPort = await listen(shim);
  const shimBase = `http://127.0.0.1:${shimPort}`;

  /* ---- fake daemon: container states + a log of every network connect ---- */

  const RUNNING = new Set(['cid-run-a', 'cid-run-b']);
  const STOPPED = new Set(['cid-stopped']);
  const connects: { network: string; container: string; aliases: string[] }[] = [];
  const daemon = http.createServer((req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';
    const send = (code: number, body: string, type = 'application/json'): void => {
      res.writeHead(code, { 'content-type': type }).end(body);
    };
    const connect = /^\/networks\/([^/]+)\/connect/.exec(url);
    if (method === 'POST' && connect) {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { Container?: string; EndpointConfig?: { Aliases?: string[] } };
        connects.push({
          network: decodeURIComponent(connect[1] as string),
          container: parsed.Container ?? '',
          aliases: parsed.EndpointConfig?.Aliases ?? [],
        });
        send(200, '{}');
      });
      return;
    }
    req.resume();
    const inspect = /^\/containers\/([^/]+)\/json/.exec(url);
    if (method === 'GET' && inspect) {
      const cid = inspect[1] as string;
      if (RUNNING.has(cid)) return send(200, '{"State":{"Running":true,"Status":"running"}}');
      if (STOPPED.has(cid)) return send(200, '{"State":{"Running":false,"Status":"exited","ExitCode":0}}');
      return send(404, '{"message":"No such container"}');
    }
    if (method === 'GET' && /^\/containers\/[^/]+\/logs/.test(url)) {
      return send(200, '[shim] listening on :8080\n', 'application/octet-stream');
    }
    send(200, '{}'); // network inspect, volume/container removal, everything else
  });
  const daemonPort = await listen(daemon);

  const hostnameBefore = process.env.HOSTNAME;
  process.env.HOSTNAME = 'smoke-orchestrator';
  cfg.dockerHost = `http://127.0.0.1:${daemonPort}`;
  cfg.dockerHostIsLocal = true;
  cfg.dockerEnabled = true;
  dockerMod.resetDockerClient();

  const running = randomUUID(); // allowlist, mid-turn during the restart
  const idle = randomUUID(); // open, idle
  const gone = randomUUID(); // container removed behind our back
  const stopped = randomUUID(); // container still there, but not running
  try {
    store.insertSession({ ...rowFor(running, 'allowlist', 'running', 'cid-run-a'), shim_endpoint: shimBase });
    store.insertSession({ ...rowFor(idle, 'open', 'idle', 'cid-run-b'), shim_endpoint: shimBase });
    store.insertSession(rowFor(gone, 'allowlist', 'running', 'cid-gone'));
    store.insertSession(rowFor(stopped, 'open', 'idle', 'cid-stopped'));

    await manager.reconcile();

    const attached = (network: string): boolean =>
      connects.some((c) => c.network === network && c.container === 'smoke-orchestrator' && c.aliases.includes('orchestrator'));
    assert(attached(dockerMod.sessionNetworkName(running)), 'reconcile re-attaches the orchestrator to a per-session network');
    assert(attached(config.networkName), 'reconcile re-attaches the orchestrator to the shared network of an open session');
    assert(
      !connects.some((c) => c.network === dockerMod.sessionNetworkName(gone)),
      'a session whose container is gone is not re-attached',
    );

    assert(store.getSession(running)?.status === 'idle', 'a turn interrupted by the restart ends as idle, not running');
    assert(store.getSession(idle)?.status === 'idle', 'an idle session with a live container stays idle');
    assert(store.getSession(gone)?.status === 'error', 'a session whose container vanished ends in error');
    assert(store.getSession(stopped)?.status === 'stopped', 'a session with a stopped container ends as stopped');

    const goneErr = await c2.wait(
      (m) => m.type === 'session.event' && m.sessionId === gone && m.event.type === 'error',
      5_000,
    );
    assert(
      goneErr.type === 'session.event' &&
        goneErr.event.type === 'error' &&
        goneErr.event.message.includes('existiert nicht mehr'),
      'the vanished container is reported with its cause',
    );
    const restored = await c2.wait(
      (m) =>
        m.type === 'session.event' &&
        m.sessionId === running &&
        m.event.type === 'notice' &&
        m.event.message.includes('neu gestartet'),
      5_000,
    );
    assert(
      restored.type === 'session.event' &&
        restored.event.type === 'notice' &&
        restored.event.message.includes('abgebrochen'),
      'the interrupted turn is called out in the timeline',
    );

    const streamed = await c2.wait(
      (m) =>
        m.type === 'session.event' &&
        m.sessionId === running &&
        m.event.type === 'notice' &&
        m.event.message === 'stream-live',
      10_000,
    );
    assert(streamed.type === 'session.event', 'reconcile reconnects the shim event stream');

    /* ---- self healing: a transport failure re-attaches and retries once ---- */

    shimMode = 'fail-once';
    promptCalls = 0;
    const connectsBefore = connects.length;
    await manager.prompt(idle, 'hallo');
    assert(promptCalls === 2, 'a prompt that fails at the transport is retried exactly once');
    assert(connects.length > connectsBefore, 'the retry happens only after the session network was re-attached');
    assert(store.getSession(idle)?.status === 'running', 'the healed prompt leaves the session running');

    shimMode = 'dead';
    promptCalls = 0;
    await manager.prompt(idle, 'nochmal');
    const failed = await c2.wait(
      (m) => m.type === 'session.event' && m.sessionId === idle && m.event.type === 'error',
      5_000,
    );
    const failMsg = failed.type === 'session.event' && failed.event.type === 'error' ? failed.event.message : '';
    assert(promptCalls === 2, 'a permanently unreachable shim is tried twice, not endlessly');
    assert(failMsg.includes('Der Agent-Container ist nicht erreichbar'), 'the app is told the container is unreachable');
    assert(failMsg.includes('Container: running') && failMsg.includes('[shim] listening'), 'the message carries the container diagnostics');
    assert(store.getSession(idle)?.status === 'error', 'a failed prompt leaves the session in error');
  } finally {
    for (const id of [running, idle, gone, stopped]) await manager.deleteSession(id).catch(() => {});
    cfg.dockerEnabled = false;
    cfg.dockerHost = null;
    cfg.dockerHostIsLocal = false;
    dockerMod.resetDockerClient();
    if (hostnameBefore === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = hostnameBefore;
    shim.close();
    daemon.close();
  }
}

/**
 * Session containers run compiled JS on plain node and load the protocol
 * package as TypeScript source (node type stripping). Unlike tsx/tsc, node does
 * not map a './x.js' import onto './x.ts', so a protocol package split across
 * files loads fine in every dev tool and crashes every container at startup.
 * This check runs the same way a shim does: plain node, no loader.
 */
async function protocolLoadsOnPlainNode(): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      ['-e', "import('@pocketagent/protocol').then(m => { if (typeof m.selectModel !== 'function') process.exit(2); })"],
      { cwd: repoRoot },
      (err, _stdout, stderr) => {
        assert(!err, `protocol package must import on plain node (no tsx): ${String(stderr).trim()}`);
        resolve();
      },
    );
  });
}

/**
 * Event history, rename and archive: everything a client needs to bring a
 * timeline back after the screen was left, plus the two list gestures. Runs
 * against the real store and the real WS handlers, without a shim.
 */
async function historySmoke(store: Store, manager: SessionManager, c2: Client, repoId: string): Promise<void> {
  const { clampEventLimit, sanitizeSessionTitle, MAX_TITLE_LEN, EVENTS_DEFAULT_LIMIT, EVENTS_MAX_LIMIT } =
    await import('./sessions.js');

  /* ---- pure helpers: limit clamping and title normalization ---- */

  assert(clampEventLimit(undefined) === EVENTS_DEFAULT_LIMIT, 'a missing limit falls back to the default');
  assert(clampEventLimit('50') === EVENTS_DEFAULT_LIMIT, 'a non-numeric limit falls back to the default');
  assert(clampEventLimit(Number.NaN) === EVENTS_DEFAULT_LIMIT, 'NaN falls back to the default');
  assert(clampEventLimit(50_000) === EVENTS_MAX_LIMIT, 'an oversized limit is capped');
  assert(clampEventLimit(0) === 1 && clampEventLimit(-9) === 1, 'a limit below 1 becomes 1');
  assert(clampEventLimit(10.7) === 10, 'a fractional limit is floored');

  assert(sanitizeSessionTitle('  Mein  Feature  ') === 'Mein Feature', 'a title is trimmed and collapsed');
  assert(sanitizeSessionTitle('a\nb\tc\u0000d') === 'a b c d', 'control characters never survive a title');
  assert(sanitizeSessionTitle('   ') === null, 'a blank title clears the title');
  const long = sanitizeSessionTitle('x'.repeat(200));
  assert(long !== null && long.length === MAX_TITLE_LEN, `a title is cut to ${MAX_TITLE_LEN} chars`);

  /* ---- a session with a timeline ---- */

  const id = randomUUID();
  const now = new Date().toISOString();
  store.insertSession({
    id,
    tenant_id: 'default',
    repo_id: repoId,
    repo_full_name: 'acme/demo',
    adapter: 'opencode',
    provider: 'zai',
    model: 'glm-4.6',
    mode: 'ask',
    status: 'idle',
    branch: `agent/${id}`,
    session_ref: null,
    container_id: 'cid-history',
    volume_name: `pocketagent-sess-${id}`,
    shim_token: null,
    pr_url: null,
    shim_endpoint: null,
    link_id: null,
    network_policy: 'allowlist',
    reasoning_effort: null,
    title: null,
    archived: 0,
    created_at: now,
    last_active_at: now,
  });

  // The prompt path stores the user's own message. Without a shim the send
  // fails right after - the message still belongs in the timeline.
  await manager.prompt(id, 'Bitte den Bug fixen').catch(() => {});
  manager.handleLinkEvent(id, { type: 'ping', ts: Date.now() });
  manager.handleLinkEvent(id, { type: 'notice', message: 'Image wird gebaut', phase: 'image-build' });
  manager.handleLinkEvent(id, { type: 'notice', message: 'Agent gewechselt: kilo → claude' });
  for (let i = 0; i < 2; i++) {
    manager.handleLinkEvent(id, { type: 'message.completed', role: 'assistant', text: `Antwort ${i}` });
  }
  // a row no longer readable as JSON (truncated write, older format...), right
  // in the middle of the conversation
  store.appendEvent(id, 'message.completed', '{"type":"message.completed",');
  for (let i = 2; i < 5; i++) {
    manager.handleLinkEvent(id, { type: 'message.completed', role: 'assistant', text: `Antwort ${i}` });
  }

  const stored = store.db
    .prepare('SELECT type, payload FROM session_events WHERE session_id = ?')
    .all(id) as Array<{ type: string; payload: string }>;
  assert(!stored.some((r) => r.type === 'ping'), 'ping frames never reach the stored history');
  assert(
    !stored.some((r) => r.payload.includes('"phase"')),
    'progress notices never reach the stored history',
  );

  const full = await request(c2, { type: 'session.events.get', requestId: 'ev1', sessionId: id });
  assert(full.type === 'session.events' && full.sessionId === id, 'session.events.get -> session.events');
  const events = full.type === 'session.events' ? full.events : [];
  assert(
    events.length === 7,
    `history carries prompt + notice + 5 answers, broken row skipped (got ${events.length})`,
  );
  const first = events[0];
  assert(
    first?.type === 'message.completed' && first.role === 'user' && first.text === 'Bitte den Bug fixen',
    'the history starts with the user prompt (no shim reports it back)',
  );
  assert(
    events[1]?.type === 'notice' && events[1].message.includes('Agent gewechselt'),
    'a notice without a phase stays an ordinary timeline entry',
  );
  assert(
    events.map((e) => (e.type === 'message.completed' && e.role === 'assistant' ? e.text : '')).join('|') ===
      '||Antwort 0|Antwort 1|Antwort 2|Antwort 3|Antwort 4',
    'the history is chronological, oldest first',
  );
  assert(!events.some((e) => e.type === 'ping'), 'no ping frame in the answer');
  assert(!events.some((e) => e.type === 'notice' && e.phase !== undefined), 'no progress notice in the answer');

  const limited = await request(c2, { type: 'session.events.get', requestId: 'ev2', sessionId: id, limit: 3 });
  const tail = limited.type === 'session.events' ? limited.events : [];
  assert(tail.length === 3, 'the limit is honoured');
  assert(
    tail.map((e) => (e.type === 'message.completed' ? e.text : '')).join('|') === 'Antwort 2|Antwort 3|Antwort 4',
    'the limit keeps the youngest events, still oldest first',
  );

  const capped = await request(c2, {
    type: 'session.events.get',
    requestId: 'ev3',
    sessionId: id,
    limit: 10_000,
  });
  assert(capped.type === 'session.events' && capped.events.length === 7, 'an oversized limit is capped, not refused');

  const unknownSession = await request(c2, {
    type: 'session.events.get',
    requestId: 'ev4',
    sessionId: 'no-such-session',
  });
  assert(unknownSession.type === 'error', 'history of an unknown session is an error, not an empty answer');

  /* ---- rename: trim, length cap, broadcast, reset ---- */

  const renamed = await request(c2, {
    type: 'session.rename',
    requestId: 'ren1',
    sessionId: id,
    title: '  Login\n  Bugfix  ',
  });
  assert(renamed.type === 'request.ok', 'session.rename -> request.ok');
  assert(store.getSession(id)?.title === 'Login Bugfix', 'the title is stored normalized');
  const renameStatus = await c2.wait(
    (m) => m.type === 'session.status' && m.sessionId === id && m.session?.title === 'Login Bugfix',
  );
  assert(renameStatus.type === 'session.status', 'the renamed session is broadcast to every device');

  await request(c2, { type: 'session.rename', requestId: 'ren2', sessionId: id, title: 'y'.repeat(300) });
  assert(store.getSession(id)?.title?.length === MAX_TITLE_LEN, 'an overlong title is cut');

  const cleared = await request(c2, { type: 'session.rename', requestId: 'ren3', sessionId: id, title: '   ' });
  assert(cleared.type === 'request.ok', 'an empty title is accepted');
  assert(store.getSession(id)?.title === null, 'an empty title removes the stored title');
  const clearedInfo = (cleared.type === 'request.ok' ? cleared.payload : undefined) as
    | { session?: { title?: string } }
    | undefined;
  assert(clearedInfo?.session !== undefined && clearedInfo.session.title === undefined, 'a session without a title carries none');

  const badTitle = await request(c2, { type: 'session.rename', requestId: 'ren4', sessionId: id, title: 42 });
  assert(badTitle.type === 'error', 'a non-string title is refused');

  /* ---- archive: flag, container stop, broadcast, list ---- */

  const archived = await request(c2, { type: 'session.archive', requestId: 'arc1', sessionId: id, archived: true });
  assert(archived.type === 'request.ok', 'session.archive -> request.ok');
  const archivedRow = store.getSession(id);
  assert(archivedRow?.archived === 1, 'the archive flag is stored');
  assert(archivedRow?.status === 'stopped', 'archiving stops the session container (volume kept)');
  assert(archivedRow?.volume_name === `pocketagent-sess-${id}`, 'archiving keeps the volume');
  const archiveStatus = await c2.wait(
    (m) => m.type === 'session.status' && m.sessionId === id && m.session?.archived === true,
  );
  assert(
    archiveStatus.type === 'session.status' && archiveStatus.status === 'stopped',
    'the archived session is broadcast as stopped',
  );

  const listWithArchived = await request(c2, { type: 'session.list', requestId: 'arc2' });
  const listed = listWithArchived.type === 'session.list' ? listWithArchived.sessions.find((s) => s.id === id) : undefined;
  assert(listed?.archived === true, 'session.list still contains archived sessions (the app filters)');

  const unarchived = await request(c2, { type: 'session.archive', requestId: 'arc3', sessionId: id, archived: false });
  assert(unarchived.type === 'request.ok', 'unarchiving is acked');
  assert(store.getSession(id)?.archived === 0, 'the archive flag is cleared');
  assert(store.getSession(id)?.status === 'stopped', 'unarchiving does not restart anything (session.resume does)');

  const badArchive = await request(c2, {
    type: 'session.archive',
    requestId: 'arc4',
    sessionId: id,
    archived: 'yes',
  });
  assert(badArchive.type === 'error', 'a non-boolean archived flag is refused');

  /* ---- delete removes the stored events with the session ---- */

  await manager.deleteSession(id);
  const leftover = store.db
    .prepare('SELECT COUNT(*) AS c FROM session_events WHERE session_id = ?')
    .get(id) as { c: number };
  assert(leftover.c === 0, 'session.delete removes the stored events too');
  assert(store.getSession(id) === undefined, 'session.delete removes the row');
}

/**
 * WS heartbeat: a socket that stops answering has to be terminated by the
 * server. Runs on its own ws server with a 40ms round, so the check costs
 * milliseconds instead of the production minute.
 */
async function heartbeatSmoke(): Promise<void> {
  const { WebSocketServer } = await import('ws');
  const { Heartbeat, WS_HEARTBEAT_MS } = await import('./ws.js');
  assert(WS_HEARTBEAT_MS === 25_000, 'production pings every 25s');

  const hb = new Heartbeat(40);
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  wss.on('connection', (s) => hb.track(s));

  const alive = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => alive.once('open', () => resolve()));
  // autoPong off = the client never answers a ping, exactly like a phone whose
  // network is gone while the socket still looks open here
  const mute = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: false });
  const muteClosed = new Promise<boolean>((resolve) => {
    mute.once('close', () => resolve(true));
    setTimeout(() => resolve(false), 5_000);
  });
  await new Promise<void>((resolve) => mute.once('open', () => resolve()));

  assert(await muteClosed, 'a socket that misses two pong rounds is terminated');
  assert(alive.readyState === WebSocket.OPEN, 'a socket that answers pongs stays connected');
  assert(hb.size() === 1, 'the heartbeat forgets terminated sockets');

  hb.stop();
  assert(hb.size() === 0, 'shutdown clears the heartbeat');
  alive.close();
  wss.close();
}

async function main(): Promise<void> {
  await protocolLoadsOnPlainNode();
  const { app, store, manager } = await buildApp();
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

  /* ---- session.prompt ack: requestId gets an error echoed back, none stays silent ---- */
  // The session never got a shim_token (docker disabled), so manager.prompt()
  // deterministically rejects with 'session not provisioned' - this exercises
  // the same error-ack path a real client hits while its container is booting.
  const promptAck = await request(c2, {
    type: 'session.prompt',
    requestId: 'prm1',
    sessionId,
    text: 'hallo',
  });
  assert(
    promptAck.type === 'error' && promptAck.requestId === 'prm1' && promptAck.sessionId === sessionId,
    'session.prompt with a requestId is acked with error + the same requestId',
  );
  c2.send({ type: 'session.prompt', sessionId, text: 'ohne requestId' });
  const silentPrompt = await c2.wait(
    (m) => m.type === 'error' && m.sessionId === sessionId && !('requestId' in m),
    5_000,
  );
  assert(silentPrompt.type === 'error', 'session.prompt without a requestId still reports the failure');
  assert(!('requestId' in silentPrompt), 'session.prompt without a requestId gets no requestId back (fire-and-forget)');

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

  /* ---- shim self build: context, content-hash tag, daemon-less failure ---- */

  const imageBuild = await import('./image-build.js');
  const adapters2 = await import('./adapters.js');
  const cfg = config as unknown as { dockerEnabled: boolean; adapterImageTagPinned: boolean };

  const ctxRoot = imageBuild.shimContextRoot();
  assert(typeof ctxRoot === 'string', 'shim build context bundled with the server');
  const ctxFiles = imageBuild.shimContextFiles('kilo');
  assert(Array.isArray(ctxFiles) && ctxFiles.includes('shims/kilo/Dockerfile'), 'kilo context carries its Dockerfile');
  assert(
    ctxFiles!.includes('tsconfig.base.json') && ctxFiles!.some((f) => f.startsWith('packages/protocol/')),
    'context has the repo-root layout the shim Dockerfiles COPY from',
  );
  assert(!ctxFiles!.some((f) => f.includes('node_modules')), 'context never carries node_modules');
  assert(imageBuild.shimContextFiles('does-not-exist') === null, 'unknown adapter has no build context');

  // deterministic + content sensitive (on a throwaway copy, never the repo)
  const ctxCopy = mkdtempSync(join(tmpdir(), 'pa-smoke-ctx-'));
  for (const rel of ctxFiles!) cpSync(join(ctxRoot as string, rel), join(ctxCopy, rel));
  const h1 = imageBuild.hashContext(ctxCopy, ctxFiles!);
  assert(h1 === imageBuild.hashContext(ctxCopy, ctxFiles!), 'context hash is deterministic');
  assert(/^[0-9a-f]{12}$/.test(h1), 'context hash is 12 hex chars');
  writeFileSync(join(ctxCopy, 'shims/kilo/src/index.ts'), '// changed\n', { flag: 'a' });
  assert(imageBuild.hashContext(ctxCopy, ctxFiles!) !== h1, 'context hash changes when a source file changes');
  rmSync(ctxCopy, { recursive: true, force: true });

  assert(
    adapters2.adapterImage('kilo') === `pocketagent/kilo-shim:c${imageBuild.shimContextHash('kilo') as string}`,
    'unpinned deployments tag shim images with the context hash',
  );
  cfg.adapterImageTagPinned = true;
  assert(adapters2.adapterImage('kilo') === 'pocketagent/kilo-shim:latest', 'an explicit ADAPTER_IMAGE_TAG wins');
  cfg.adapterImageTagPinned = false;

  /**
   * Build failures arrive as an `error` frame on a stream that ends normally
   * (followProgress' callback error only covers transport faults), and parallel
   * callers of one tag must share a single build.
   */
  let buildCalls = 0;
  const fakeDocker = {
    buildImage: () => {
      buildCalls++;
      return Promise.resolve({} as NodeJS.ReadableStream);
    },
    modem: {
      followProgress: (
        _s: unknown,
        onFinished: (e: Error | null, o: unknown[]) => void,
        onProgress: (ev: Record<string, unknown>) => void,
      ) => {
        setTimeout(() => {
          onProgress({ stream: 'Step 1/12 : FROM node:22-bookworm-slim' });
          onProgress({ stream: 'npm ci: ENOSPC no space left on device' });
          onProgress({ error: 'The command /bin/sh -c npm ci returned a non-zero code: 1' });
          onFinished(null, []);
        }, 10);
      },
    },
  };
  let buildErr = '';
  const buildNotices: { message: string; phase?: string; detail?: string }[] = [];
  await Promise.all([
    imageBuild
      .buildShimImage(fakeDocker as never, 'kilo', 'pa-smoke/kilo-shim:test', (message, p) => {
        buildNotices.push({ message, ...p });
      })
      .catch((e: unknown) => {
        buildErr = e instanceof Error ? e.message : String(e);
      }),
    imageBuild.buildShimImage(fakeDocker as never, 'kilo', 'pa-smoke/kilo-shim:test').catch(() => {}),
  ]);
  assert(buildCalls === 1, 'parallel builds of one tag are deduped into a single build');
  assert(buildErr.includes('non-zero code: 1'), 'build error frame becomes the exception cause');
  assert(buildErr.includes('ENOSPC'), 'exception carries the last build log lines');

  /* ---- build progress: phase, docker step, throttling ---- */

  assert(
    buildNotices[0]?.phase === 'image-build' && buildNotices[0].message.includes('Agent-Image wird gebaut'),
    'the build announces itself as image-build progress',
  );
  const stepNotices = buildNotices.filter((n) => n.message.startsWith('Image wird gebaut'));
  assert(stepNotices.length === 1, 'build log lines within one interval produce a single notice (throttled)');
  assert(stepNotices[0]?.message === 'Image wird gebaut (Schritt 1/12)', 'the docker step becomes the progress message');
  assert(stepNotices[0]?.phase === 'image-build', 'build progress carries the image-build phase');
  assert(
    stepNotices[0]?.detail?.includes('FROM node:22-bookworm-slim') === true,
    'the build notice carries the log tail as detail',
  );

  /* ---- start progress: pure derivation, dedupe, detail clamping ---- */

  const progress = await import('./progress.js');

  assert(isNoticePhase('image-build') && isNoticePhase('ready'), 'the contract phases are accepted');
  assert(!isNoticePhase('done') && !isNoticePhase(undefined), 'unknown notice phases are rejected');

  assert(
    progress.buildProgressMessage(['Step 7/14 : RUN npm ci']) === 'Image wird gebaut (Schritt 7/14)',
    'classic builder step lines become a step message',
  );
  assert(
    progress.buildProgressMessage(['#9 [3/8] RUN apk add git']) === 'Image wird gebaut (Schritt 3/8)',
    'buildkit step lines become a step message',
  );
  assert(
    progress.buildProgressMessage(['Step 2/14 : RUN a', 'Step 9/14 : RUN b', ' ---> cached']) ===
      'Image wird gebaut (Schritt 9/14)',
    'the newest step wins',
  );
  assert(progress.buildProgressMessage(['pulling fs layer']) === 'Image wird gebaut', 'unknown build output stays generic');

  assert(
    progress.shimProgressMessage(['[git] cloning https://github.com/acme/demo.git (branch main) -> /work']) ===
      'Repo wird geklont',
    'a clone line is recognized',
  );
  assert(
    progress.shimProgressMessage(['[git] cloning x', '[git] on branch agent/1']) === 'Branch wird vorbereitet',
    'the newest shim marker wins',
  );
  assert(
    progress.shimProgressMessage(['[shim] listening on :8080 (opencode spawned :4096)']).startsWith('Agent-Prozess läuft'),
    'a listening shim is recognized',
  );
  assert(progress.shimProgressMessage(['some unrelated output']) === 'Agent-Container startet', 'unknown lines stay generic');

  const tail1 = ['a', 'b', 'c'];
  assert(progress.newTailLines([], tail1).length === 3, 'the first poll reports every line');
  assert(progress.newTailLines(tail1, tail1).length === 0, 'an unchanged tail reports nothing');
  assert(
    JSON.stringify(progress.newTailLines(tail1, ['b', 'c', 'd'])) === JSON.stringify(['d']),
    'a scrolled window reports only the new line',
  );
  assert(
    JSON.stringify(progress.newTailLines(['a', 'b'], ['a', 'b', 'c', 'd'])) === JSON.stringify(['c', 'd']),
    'a growing tail reports only its new lines',
  );
  assert(
    JSON.stringify(progress.newTailLines(['a'], ['x', 'y'])) === JSON.stringify(['x', 'y']),
    'a window without overlap counts as entirely new',
  );

  const gate = progress.createThrottle(2_000);
  assert(gate(1_000), 'the first progress notice always passes');
  assert(!gate(1_500), 'a notice within the interval is dropped');
  assert(gate(3_000) && !gate(3_500), 'the next notice passes only after the interval');

  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
  const detail = progress.detailFrom(['fetching origin', `remote: token ${secret} used`]);
  assert(!detail.includes(secret) && detail.includes('[gekürzt]'), 'token-shaped words are masked in a detail');
  const clamped = progress.detailFrom(Array.from({ length: 20 }, (_, i) => `line ${i}`));
  assert(clamped.split('\n').length === 6 && clamped.endsWith('line 19'), 'a detail keeps at most the 6 youngest lines');
  const wide = 'ab '.repeat(150).trim();
  const dropped = progress.detailFrom([wide, wide]);
  assert(dropped.length <= 600 && !dropped.includes('\n'), 'oldest lines are dropped until the detail fits');
  const single = progress.detailFrom(['ab '.repeat(300).trim()]);
  assert(single.length === 600 && single.startsWith('…'), 'one oversized line is cut from the front');

  assert(
    progress.splitLogLines('  a  \n\n b \r\n') .join('|') === 'a|b',
    'log blobs become trimmed, non-empty lines',
  );

  /* ---- harness switch: session.update { adapter } ---------------------- */

  const noDocker = await request(c2, { type: 'session.update', requestId: 'sw0', sessionId, adapter: 'kilo' });
  assert(
    noDocker.type === 'error' && noDocker.message.includes('Docker'),
    'adapter switch is refused (not half-applied) when docker is disabled',
  );
  assert(store.getSession(sessionId)?.adapter === 'opencode', 'refused switch left the row untouched');

  // link sessions carry no container: the switch must be refused with a reason
  const linkSessionId = randomUUID();
  const opencodeRow = store.getSession(sessionId)!;
  store.insertSession({ ...opencodeRow, id: linkSessionId, status: 'idle' });
  store.setLinkId(linkSessionId, 'smoke-link');
  let linkRefused = '';
  try {
    manager.updateSession({ type: 'session.update', requestId: 'sw-link', sessionId: linkSessionId, adapter: 'kilo' });
  } catch (e) {
    linkRefused = e instanceof Error ? e.message : String(e);
  }
  assert(linkRefused.includes('Link-Sessions'), 'adapter switch on a link session is refused');
  await manager.deleteSession(linkSessionId);

  // provisioned session + docker "available": the switch is applied and the
  // container work runs asynchronously (no daemon here -> clean error event).
  store.setProvisioned(sessionId, 'smoke-container', 'pocketagent-sess-smoke', 'smoke-shim-token');
  store.setSessionRef(sessionId, 'runtime-session-ref');
  store.updateSessionStatus(sessionId, 'idle');
  cfg.dockerEnabled = true;
  // The orchestrator identifies its own container by HOSTNAME to join session
  // networks; docker always sets it, this run has to emulate that.
  const hostnameBefore = process.env.HOSTNAME;
  process.env.HOSTNAME = 'smoke-orchestrator';
  try {
    const unknownAdapter = await request(c2, {
      type: 'session.update',
      requestId: 'sw1',
      sessionId,
      adapter: 'does-not-exist',
    });
    assert(unknownAdapter.type === 'error', 'session.update rejects an unknown adapter');

    const switched = await request(c2, { type: 'session.update', requestId: 'sw2', sessionId, adapter: 'kilo' });
    assert(switched.type === 'request.ok', 'adapter switch is acked immediately (build may take minutes)');
    const swRow = store.getSession(sessionId);
    assert(swRow?.adapter === 'kilo', 'adapter switched in the row');
    assert(swRow?.session_ref === null, 'harness session ref dropped (not transferable)');
    assert(swRow?.model === '', 'model reset to the adapter default');
    assert(swRow?.reasoning_effort === null, 'reasoning effort reset');
    assert(swRow?.provider === 'zai', 'provider reset to the new adapter default');
    assert(swRow?.volume_name === 'pocketagent-sess-smoke', 'volume kept across the switch');
    assert(swRow?.branch === opencodeRow.branch, 'session branch kept across the switch');

    const notice = await c2.wait(
      (m) => m.type === 'session.event' && m.sessionId === sessionId && m.event.type === 'notice',
    );
    assert(
      notice.type === 'session.event' &&
        notice.event.type === 'notice' &&
        notice.event.message.includes('Agent gewechselt'),
      'switch emits a notice event (unknown types are ignored by older apps)',
    );

    // no docker daemon in CI: the self build must fail with its real cause
    const buildFailed = await c2.wait(
      (m) =>
        m.type === 'session.event' &&
        m.sessionId === sessionId &&
        m.event.type === 'error' &&
        m.event.message.includes('kilo-shim'),
      30_000,
    );
    assert(
      buildFailed.type === 'session.event' &&
        buildFailed.event.type === 'error' &&
        buildFailed.event.message.includes('konnte nicht gebaut werden'),
      'a failing self build surfaces the real cause instead of a generic message',
    );

    // Without HOSTNAME nothing can reach the shim; that has to be said, not
    // waited out until the readiness timeout.
    delete process.env.HOSTNAME;
    const switchedAgain = await request(c2, {
      type: 'session.update',
      requestId: 'sw3',
      sessionId,
      adapter: 'opencode',
    });
    assert(switchedAgain.type === 'request.ok', 'switch back is acked');
    const hostnameErr = await c2.wait(
      (m) =>
        m.type === 'session.event' &&
        m.sessionId === sessionId &&
        m.event.type === 'error' &&
        m.event.message.includes('HOSTNAME'),
      30_000,
    );
    assert(
      hostnameErr.type === 'session.event' && hostnameErr.event.type === 'error',
      'a missing HOSTNAME fails the session with its real cause',
    );
  } finally {
    cfg.dockerEnabled = false;
    if (hostnameBefore === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = hostnameBefore;
  }

  await startProgressSmoke(store, manager, c2, added.repo.id);
  await egressPeerSmoke(store, manager, added.repo.id);
  await reconcileSmoke(store, manager, c2, added.repo.id);
  await historySmoke(store, manager, c2, added.repo.id);
  await heartbeatSmoke();

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

  /* ---------------- pairing hardening (via inject, distinct IPs to isolate limiter buckets) -------- */

  const confirmInject = (code: string, ip: string) =>
    app.inject({
      method: 'POST',
      url: '/api/pairing/confirm',
      headers: { 'content-type': 'application/json' },
      remoteAddress: ip,
      payload: { code, deviceName: 'smoke-inject' },
    });

  // 5 wrong codes: unknown codes never burn the real row...
  const liveCode = generatePairingCode(store);
  for (let i = 0; i < 5; i++) {
    const r = await confirmInject(`deadbeef000${i}`, '10.0.0.1');
    assert(r.statusCode === 400, `wrong code #${i + 1} rejected`);
  }
  // ...so the correct code still works while attempts remain.
  const stillWorks = await confirmInject(liveCode, '10.0.0.1');
  assert(stillWorks.statusCode === 200, 'correct code still works when attempts remain');
  assert(generatePairingCode(store).length === 12 && /^[0-9a-f]{12}$/.test(liveCode), 'codes are 12 hex chars');

  // Attempt exhaustion: 5 failed submissions against one code burn its attempts...
  const hammered = generatePairingCode(store, 'default', -60_000); // born expired
  for (let i = 0; i < 5; i++) {
    const r = await confirmInject(hammered, '10.0.0.2');
    assert(r.statusCode === 400, `failed submission #${i + 1} rejected`);
  }
  const attemptsRow = store.db.prepare('SELECT attempts FROM pairing_codes WHERE code = ?').get(hammered) as
    | { attempts: number }
    | undefined;
  assert(attemptsRow?.attempts === 5, '5 failed submissions burned 5 attempts');
  // ...then the code stays locked even if made unexpired again (attempts >= 5).
  store.db
    .prepare('UPDATE pairing_codes SET expires_at = ? WHERE code = ?')
    .run(new Date(Date.now() + 600_000).toISOString(), hammered);
  const exhausted = await confirmInject(hammered, '10.0.0.2');
  assert(exhausted.statusCode === 400, '6th attempt with the CORRECT code rejected (attempt exhaustion)');

  // Expired (never hammered) code rejected.
  const expiredCode = generatePairingCode(store, 'default', -1_000);
  const expiredRes = await confirmInject(expiredCode, '10.0.0.3');
  assert(expiredRes.statusCode === 400, 'expired code rejected');

  /* ---------------- rate limiter ------------------------------------------------------------------- */

  const rl = new SlidingWindowRateLimiter(60_000, 3);
  assert(rl.allow('k') && rl.allow('k') && rl.allow('k'), 'limiter allows first 3');
  assert(!rl.allow('k'), 'limiter blocks 4th in window');
  assert(rl.allow('other'), 'limiter keys are independent');
  rl.dispose();

  for (let i = 0; i < 10; i++) {
    const r = await confirmInject('000000000000', '10.9.9.9');
    assert(r.statusCode === 400, `request ${i + 1} passes limiter (invalid code)`);
  }
  const limited = await confirmInject('000000000000', '10.9.9.9');
  assert(limited.statusCode === 429, '11th request from same IP within a minute -> 429');
  assert(JSON.stringify(limited.json()).includes('rate limited'), '429 body says rate limited');

  /* ---------------- vault AAD + legacy migration --------------------------------------------------- */

  const aad = 'secret:default:smoke-aad';
  const encRound = vault.encrypt('roundtrip-value', aad);
  assert(vault.decryptStrict(encRound, aad) === 'roundtrip-value', 'vault AAD roundtrip');
  assert(vault.decrypt(encRound, aad) === 'roundtrip-value', 'decrypt with matching AAD works');
  let aadMismatch = false;
  try {
    vault.decryptStrict(encRound, 'secret:default:other');
  } catch {
    aadMismatch = true;
  }
  assert(aadMismatch, 'AAD mismatch fails strict decrypt');

  const legacyKind = 'smoke-legacy';
  const legacyEnc = vault.encrypt('legacy-value'); // no AAD (pre-migration row)
  store.saveSecret(randomUUID(), 'default', legacyKind, legacyEnc.ciphertext, legacyEnc.nonce);
  const firstRead = store.getSecretValue(legacyKind, 'default');
  assert(firstRead === 'legacy-value', 'legacy secret decrypts via new API');
  const reEncrypted = store.getSecretByKind(legacyKind, 'default');
  assert(!!reEncrypted && reEncrypted.ciphertext !== legacyEnc.ciphertext, 'legacy row re-encrypted');
  assert(
    !!reEncrypted && vault.decryptStrict(
      { ciphertext: reEncrypted.ciphertext, nonce: reEncrypted.nonce },
      `secret:default:${legacyKind}`,
    ) === 'legacy-value',
    'second read decrypts with AAD strictly',
  );
  const secondRead = store.getSecretValue(legacyKind, 'default');
  assert(secondRead === 'legacy-value', 're-encrypted value stable on second read');
  assert(store.getSecretValue('no-such-kind', 'default') === null, 'missing secret returns null');

  /* ---------------- revocation --------------------------------------------------------------------- */

  const code2 = generatePairingCode(store);
  const pairRes2 = await fetch(`${base}/api/pairing/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code2, deviceName: 'smoke-device-2' }),
  });
  const paired2 = (await pairRes2.json()) as { ok: boolean; deviceId?: string; deviceToken?: string };
  assert(pairRes2.ok && paired2.ok && paired2.deviceId && paired2.deviceToken, 'second device paired');

  const c3 = new Client(wsBase);
  await c3.opened;
  c3.send({ type: 'hello', deviceId: paired2.deviceId, token: paired2.deviceToken });
  const w3 = await c3.wait((m) => m.type === 'welcome');
  assert(w3.type === 'welcome' && w3.ok === true, 'second device authenticated');

  const devList = await request(c2, { type: 'device.list', requestId: 'dev1' });
  const devices = devList.type === 'device.list' ? devList.devices : [];
  assert(devices.length >= 2, 'device.list returns paired devices');
  const d1 = devices.find((d) => d.id === paired.deviceId);
  const d2 = devices.find((d) => d.id === paired2.deviceId);
  assert(!!d1 && d1.online, 'device.list marks live socket online (device 1)');
  assert(!!d2 && d2.online, 'device.list marks live socket online (device 2)');

  const c3Closed = c3.closeCode();
  const rev = await request(c2, { type: 'device.revoke', requestId: 'dev2', deviceId: paired2.deviceId });
  assert(rev.type === 'device.revoked' && rev.deviceId === paired2.deviceId, 'device.revoke confirmed');
  assert((await c3Closed) === 4001, 'revoked device socket closed with 4001');

  const c4 = new Client(wsBase);
  await c4.opened;
  const c4Closed = c4.closeCode();
  c4.send({ type: 'hello', deviceId: paired2.deviceId, token: paired2.deviceToken });
  assert((await c4Closed) === 4001, 'hello with revoked token -> 4001');
  const devList2 = await request(c2, { type: 'device.list', requestId: 'dev3' });
  assert(
    devList2.type === 'device.list' && !devList2.devices.some((d) => d.id === paired2.deviceId),
    'revoked device gone from device.list',
  );

  const linkList = await request(c2, { type: 'link.list', requestId: 'lnk1' });
  assert(linkList.type === 'link.list' && Array.isArray(linkList.links), 'link.list works');
  const linkRev = await request(c2, { type: 'link.revoke', requestId: 'lnk2', linkId: 'no-such-link' });
  assert(linkRev.type === 'link.revoked', 'link.revoke confirms (idempotent for unknown id)');

  /* ---------------- repo.add validation ------------------------------------------------------------ */

  const badRepo = await request(c2, {
    type: 'repo.add',
    requestId: 'repo3',
    fullName: 'bad name!',
    defaultBranch: 'main',
  });
  assert(badRepo.type === 'error', 'repo.add with invalid fullName rejected');
  const badBranch = await request(c2, {
    type: 'repo.add',
    requestId: 'repo4',
    fullName: 'acme/ok',
    defaultBranch: 'ma in!',
  });
  assert(badBranch.type === 'error', 'repo.add with invalid defaultBranch rejected');

  /* ---------------- appendEvent pruning ------------------------------------------------------------ */

  store.db.transaction(() => {
    for (let i = 0; i < 5005; i++) store.appendEvent('smoke-prune-session', 'tick', '{}');
  })();
  const cnt = store.db
    .prepare('SELECT COUNT(*) AS c FROM session_events WHERE session_id = ?')
    .get('smoke-prune-session') as { c: number };
  assert(cnt.c <= 5000, `session_events pruned to <= 5000 (got ${cnt.c})`);

  /* ---------------- admin CLI functions ------------------------------------------------------------ */

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  };
  try {
    admin.listDevices(store);
    admin.listLinks(store);
  } finally {
    console.log = origLog;
  }
  assert(logs.join('\n').includes(paired.deviceId as string), 'admin list-devices prints paired device');
  store.createDevice('smoke-admin-dev', 'default', 'admin-test', sha256('x'));
  admin.revokeDevice(store, 'smoke-admin-dev');
  assert(!store.getDevice('smoke-admin-dev'), 'admin revokeDevice removes the row');

  console.log('SMOKE OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
