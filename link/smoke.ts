/**
 * Integration smoke for the link agent path:
 *   device (WS) <-> orchestrator (HTTP+WS) <-> link agent (outbound WS)
 *                                               -> local opencode shim -> real `opencode serve`
 *
 * Verifies: link registration creates a session, device sees it, prompt is
 * proxied through the outbound WS, events flow back, diff works, stop sends
 * agent.bye. No API keys needed (model call fails cleanly).
 *
 * Run: npm run smoke -w link   (from repo root; needs workspace deps installed)
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import WebSocket from 'ws';
import type { AgentEvent, ServerMessage } from '@pocketagent/protocol';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const GLOBAL_TIMEOUT_MS = 240_000;
const LINK_TOKEN = `smoke-link-${randomBytes(8).toString('hex')}`;

const unhandled: unknown[] = [];
process.on('unhandledRejection', (r) => unhandled.push(r));

function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') return rej(new Error('no port'));
      const { port } = addr;
      srv.close(() => res(port));
    });
  });
}

async function waitFor<T>(fn: () => T | undefined, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = fn();
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(250);
  }
}

interface DeviceSock {
  ws: WebSocket;
  messages: ServerMessage[];
  send(m: unknown): void;
  wait(pred: (m: ServerMessage) => boolean, what: string, timeoutMs?: number): Promise<ServerMessage>;
}

function deviceSock(url: string, token: { deviceId: string; deviceToken: string }): Promise<DeviceSock> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: ServerMessage[] = [];
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMessage;
      messages.push(msg);
      if (msg.type === 'welcome') {
        resolve({
          ws,
          messages,
          send: (m) => ws.send(JSON.stringify(m)),
          wait: (pred, what, timeoutMs = 20_000) =>
            waitFor(() => messages.find(pred), what, timeoutMs),
        });
      }
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', deviceId: token.deviceId, token: token.deviceToken }));
    });
  });
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'link-smoke-data-'));
  const workDir = mkdtempSync(join(tmpdir(), 'link-smoke-work-'));
  const serverPort = await freePort();
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const wsUrl = `ws://127.0.0.1:${serverPort}/ws`;

  let server: ChildProcess | undefined;
  let link: ChildProcess | undefined;
  let device: DeviceSock | undefined;

  try {
    // temp git repo as the "devcontainer workspace"
    await exec('git', ['init', '-b', 'main'], { cwd: workDir });
    await exec('git', ['config', 'user.name', 'LinkSmoke'], { cwd: workDir });
    await exec('git', ['config', 'user.email', 'link@test.local'], { cwd: workDir });
    writeFileSync(join(workDir, 'README.md'), '# link smoke\n');
    await exec('git', ['add', '-A'], { cwd: workDir });
    await exec('git', ['commit', '-m', 'init', '--no-verify'], { cwd: workDir });

    // seed DB directly (same sqlite file the server will open)
    const { Store, sha256 } = await import(`${repoRoot}/server/src/db.js`);
    const { generatePairingCode } = await import(`${repoRoot}/server/src/pairing.js`);
    const store = new Store(dataDir);
    const pairingCode = generatePairingCode(store);
    const { randomUUID } = await import('node:crypto');
    store.createLink(randomUUID(), 'default', 'smoke-box', sha256(LINK_TOKEN));
    store.close();

    // orchestrator (docker disabled, adapters registry from ../shims)
    const tsx = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
    server = spawn(process.execPath, [tsx, 'src/index.ts'], {
      cwd: resolve(repoRoot, 'server'),
      env: { ...process.env, PORT: String(serverPort), DATA_DIR: dataDir, DOCKER_ENABLED: '0', ADAPTERS_DIR: resolve(repoRoot, 'shims') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (c: Buffer) => process.stdout.write(`[server] ${c}`));
    server.stderr?.on('data', (c: Buffer) => process.stderr.write(`[server:err] ${c}`));
    let healthy = false;
    const healthDeadline = Date.now() + 60_000;
    while (!healthy && Date.now() < healthDeadline) {
      try {
        const res = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
        healthy = res.ok;
      } catch {
        healthy = false;
      }
      if (!healthy) await sleep(500);
    }
    expect(healthy, 'server healthy');

    // pair a device over REST
    const pairRes = await fetch(`${serverUrl}/api/pairing/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pairingCode, deviceName: 'smoke-phone' }),
    });
    const paired = (await pairRes.json()) as { ok: boolean; deviceId: string; deviceToken: string };
    expect(paired.ok, 'pairing confirm ok');
    device = await deviceSock(wsUrl, paired);

    // no sessions yet
    device.send({ type: 'session.list', requestId: 'r1' });
    const empty = await device.wait((m) => m.type === 'session.list' && m.requestId === 'r1', 'empty session.list');
    expect(empty.type === 'session.list' && empty.sessions.length === 0, 'no sessions before link connects');

    // link agent (spawns the opencode shim + real `opencode serve`)
    link = spawn(process.execPath, [tsx, 'link/src/index.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PA_SERVER: wsUrl,
        PA_TOKEN: LINK_TOKEN,
        PA_ADAPTER: 'opencode',
        PA_MODE: 'ask',
        PA_NAME: 'smoke-link',
        PA_WORKDIR: workDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    link.stdout?.on('data', (c: Buffer) => process.stdout.write(`[link] ${c}`));
    link.stderr?.on('data', (c: Buffer) => process.stderr.write(`[link:err] ${c}`));

    // device sees the linked session appear (status broadcast)
    const statusMsg = await device.wait(
      (m) => m.type === 'session.status' && (m.session?.repoFullName?.startsWith('link:') ?? false),
      'link session status broadcast',
      120_000,
    );
    const linkSessionId = statusMsg.type === 'session.status' ? statusMsg.sessionId : '';
    expect(linkSessionId.length > 0, 'link sessionId present');
    const sessionRow = statusMsg.type === 'session.status' ? statusMsg.session : undefined;
    expect(sessionRow?.status === 'idle', 'link session idle');
    expect(sessionRow?.adapter === 'opencode', 'link session adapter opencode');

    // prompt through the outbound link
    device.send({ type: 'session.prompt', sessionId: linkSessionId, text: 'say hi' });
    const terminal = await device.wait(
      (m) =>
        m.type === 'session.event' &&
        m.sessionId === linkSessionId &&
        (m.event.type === 'turn.failed' || m.event.type === 'turn.completed'),
      'turn terminal event via link',
      120_000,
    );
    const ev = (terminal as { event: AgentEvent }).event;
    console.log(`[smoke] terminal event: ${JSON.stringify(ev).slice(0, 200)}`);

    // diff via link proxy
    device.send({ type: 'session.diff.get', requestId: 'r2', sessionId: linkSessionId });
    const diffMsg = await device.wait((m) => m.type === 'session.diff' && m.requestId === 'r2', 'diff via link');
    expect(diffMsg.type === 'session.diff' && Array.isArray(diffMsg.diff), 'diff array via link');

    // stop => agent.bye => link agent exits, session stopped
    device.send({ type: 'session.stop', sessionId: linkSessionId });
    await device.wait(
      (m) => m.type === 'session.status' && m.sessionId === linkSessionId && m.status === 'stopped',
      'link session stopped',
      30_000,
    );
    const linkExit = await new Promise<number>((res) => {
      if (link?.exitCode !== null && link?.exitCode !== undefined) res(link.exitCode);
      else link?.on('exit', (c) => res(c ?? 0));
    });
    expect(linkExit === 0, `link agent exits cleanly on bye (code=${linkExit})`);

    console.log('\nLINK SMOKE OK');
    process.exit(unhandled.length === 0 ? 0 : 1);
  } finally {
    device?.ws.close();
    link?.kill('SIGTERM');
    server?.kill('SIGTERM');
    await sleep(500);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

const watchdog = setTimeout(() => {
  console.error('LINK SMOKE FAILED: global timeout');
  process.exit(1);
}, GLOBAL_TIMEOUT_MS);
watchdog.unref();

main().catch((e) => {
  console.error('LINK SMOKE FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
