/**
 * PocketAgent link agent.
 *
 * Runs in ANY environment with Node 22 + this repo checked out (devcontainer,
 * home PC, VPS, CI box). It spawns an adapter shim as a local child process
 * and bridges it to the orchestrator over an OUTBOUND WebSocket - no inbound
 * ports, no NAT/tunnel setup required.
 *
 * Usage:
 *   PA_SERVER=wss://orch.example.com PA_TOKEN=... npm run start -w link -- \
 *     --adapter opencode --mode ask --workdir /workspaces/myproject
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { AgentEvent, AgentMode, ServerMessage } from '@pocketagent/protocol';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

interface Args {
  server: string;
  token: string;
  adapter: string;
  mode: AgentMode;
  workDir: string;
  name: string;
  branch: string;
}

function arg(name: string, fallback: string): string {
  const flag = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(flag));
  return hit ? hit.slice(flag.length) : fallback;
}

const args: Args = {
  server: arg('server', process.env.PA_SERVER ?? ''),
  token: arg('token', process.env.PA_TOKEN ?? ''),
  adapter: arg('adapter', process.env.PA_ADAPTER ?? 'opencode'),
  mode: (['yolo', 'auto', 'acceptEdits', 'ask'] as const).includes(arg('mode', process.env.PA_MODE ?? 'ask') as AgentMode)
    ? (arg('mode', process.env.PA_MODE ?? 'ask') as AgentMode)
    : 'ask',
  workDir: resolve(arg('workdir', process.env.PA_WORKDIR ?? process.cwd())),
  name: arg('name', process.env.PA_NAME ?? hostname()),
  branch: arg('branch', process.env.PA_BRANCH ?? ''),
};

if (!args.server || !args.token) {
  console.error('usage: PA_SERVER=wss://... PA_TOKEN=... npm run start -w link -- [--adapter opencode] [--mode ask] [--workdir /path]');
  process.exit(1);
}

const ADAPTERS = ['opencode', 'kilo', 'claude', 'pi', 'junie'] as const;
if (!ADAPTERS.includes(args.adapter as (typeof ADAPTERS)[number])) {
  console.error(`unknown adapter "${args.adapter}" (supported: ${ADAPTERS.join(', ')})`);
  process.exit(1);
}

const shimPath = resolve(repoRoot, 'shims', args.adapter, 'src', 'index.ts');
if (!existsSync(shimPath)) {
  console.error(`shim not found: ${shimPath} - run the link agent from a pocketagent repo checkout`);
  process.exit(1);
}

const tsxCandidates = [
  resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs'),
  resolve(here, '../node_modules/tsx/dist/cli.mjs'),
];
const tsx = tsxCandidates.find((p) => existsSync(p));
if (!tsx) {
  console.error('tsx not found - run `npm install` in the repo root first');
  process.exit(1);
}

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

const shimToken = randomBytes(24).toString('hex');
const log = (m: string): void => console.log(`[link] ${m}`);

interface ShimProcess {
  child: ChildProcess;
  port: number;
}

async function spawnShim(): Promise<ShimProcess> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SHIM_TOKEN: shimToken,
    PORT: String(port),
    WORK_DIR: args.workDir,
    AGENT_MODE: args.mode,
    ADAPTER: args.adapter,
    SESSION_ID: args.name,
    REPO_URL: '',
    REPO_FULL_NAME: process.env.PA_REPO_FULL_NAME ?? args.name,
    AUTO_PUSH: args.mode === 'yolo' ? '1' : '0',
  };
  const child: ChildProcess = spawn(process.execPath, [tsx as string, shimPath], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = (tag: string) => (c: Buffer): void => {
    for (const line of c.toString().split('\n')) {
      if (line.trim().length > 0) console.log(`[${args.adapter}] ${line}`);
    }
    void tag;
  };
  child.stdout?.on('data', prefix('out'));
  child.stderr?.on('data', prefix('err'));
  child.on('exit', (code, signal) => {
    log(`shim exited (code=${code ?? '?'} signal=${signal ?? '?'}) - restarting in 5s`);
    setTimeout(() => void restart(), 5000);
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return { child, port };
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  child.kill('SIGTERM');
  throw new Error(`shim on ${base} not healthy within 90s (adapter deps installed?)`);
}

let shim: ShimProcess | null = null;
let shimRestarting = false;
let stopped = false;

async function restart(): Promise<void> {
  if (stopped || shimRestarting) return;
  shimRestarting = true;
  try {
    shim = await spawnShim();
    log(`shim ready on 127.0.0.1:${shim.port}`);
  } catch (e) {
    console.error(`[link] ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    shimRestarting = false;
  }
}

/* ---------------- orchestrator WS (outbound, reconnecting) ---------------- */

let ws: WebSocket | null = null;
let sessionId: string | null = null;
let lastServerMsgAt = Date.now();
const eventQueue: AgentEvent[] = [];

function wsUrl(): string {
  const u = new URL(args.server);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  return u.toString();
}

function send(m: unknown): void {
  try {
    ws?.send(JSON.stringify(m));
  } catch {
    /* closed */
  }
}

async function proxyCommand(callId: string, path: string, method: 'GET' | 'POST', body?: unknown): Promise<void> {
  if (!shim) {
    send({ type: 'agent.response', callId, status: 503, body: { ok: false, error: 'local shim not ready' } });
    return;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${shim.port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${shimToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = { ok: false, error: text.slice(0, 500) };
    }
    send({ type: 'agent.response', callId, status: res.status, body: parsed });
  } catch (e) {
    send({ type: 'agent.response', callId, status: 502, body: { ok: false, error: e instanceof Error ? e.message : String(e) } });
  }
}

function startEventStream(): void {
  if (!shim) return;
  const base = `http://127.0.0.1:${shim.port}`;
  void (async () => {
    for (;;) {
      if (stopped || !shim) return;
      try {
        const res = await fetch(`${base}/events`, {
          headers: { authorization: `Bearer ${shimToken}`, accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) throw new Error(`sse ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx = buf.indexOf('\n\n');
          while (idx >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              try {
                const ev = JSON.parse(line.slice(5).trim()) as AgentEvent;
                if (sessionId && !stopped) send({ type: 'agent.event', sessionId, event: ev });
                else if (!stopped) eventQueue.push(ev);
              } catch {
                /* malformed */
              }
            }
            idx = buf.indexOf('\n\n');
          }
        }
      } catch {
        /* reconnect */
      }
      if (stopped) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
}

function flushQueuedEvents(): void {
  while (eventQueue.length > 0) {
    const ev = eventQueue.shift();
    if (ev && sessionId) send({ type: 'agent.event', sessionId, event: ev });
  }
}

let backoff = 1000;

function dial(): void {
  if (stopped) return;
  log(`connecting ${wsUrl()}`);
  const sock = new WebSocket(wsUrl());
  ws = sock;
  sock.on('open', () => {
    send({
      type: 'agent.hello',
      token: args.token,
      name: args.name,
      adapter: args.adapter,
      mode: args.mode,
      branch: args.branch || undefined,
      workDir: args.workDir,
    });
  });
  sock.on('message', (raw) => {
    lastServerMsgAt = Date.now();
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(raw)) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === 'agent.ready') {
      sessionId = msg.sessionId;
      backoff = 1000;
      log(`registered as session ${sessionId}`);
      flushQueuedEvents();
      return;
    }
    if (msg.type === 'agent.command') {
      void proxyCommand(msg.callId, msg.path, msg.method, msg.body);
      return;
    }
    if (msg.type === 'agent.bye') {
      log('server closed the session - shutting down');
      shutdown(0);
    }
  });
  sock.on('close', () => {
    if (stopped) return;
    sessionId = null;
    log(`connection lost - retrying in ${Math.round(backoff / 1000)}s`);
    setTimeout(() => dial(), backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });
  sock.on('error', () => {
    /* close handler retries */
  });
}

setInterval(() => {
  send({ type: 'agent.ping', ts: Date.now() });
  if (Date.now() - lastServerMsgAt > 90_000) {
    log('server silent >90s - forcing reconnect');
    ws?.terminate();
  }
}, 20_000);

function shutdown(code: number): void {
  stopped = true;
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  shim?.child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main(): Promise<void> {
  log(`adapter=${args.adapter} mode=${args.mode} workDir=${args.workDir} name=${args.name}`);
  await restart();
  startEventStream();
  dial();
}

void main().catch((e) => {
  console.error(`[link] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
