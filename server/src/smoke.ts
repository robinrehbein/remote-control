import { mkdtempSync } from 'node:fs';
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
const vault = await import('./vault.js');
const admin = await import('./admin.js');
const { sha256 } = await import('./db.js');

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

  const stats = await request(c2, { type: 'server.stats', requestId: 'stats1' });
  assert(
    stats.type === 'server.stats' && stats.stats.sessionsTotal >= 1 && stats.stats.uptimeSec >= 0,
    'server.stats works',
  );

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
  const row = store.db.prepare('SELECT attempts FROM pairing_codes WHERE code = ?').get(hammered) as
    | { attempts: number }
    | undefined;
  assert(row?.attempts === 5, '5 failed submissions burned 5 attempts');
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
