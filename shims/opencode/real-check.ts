/**
 * Live verification of the opencode adapter shim against a REAL `opencode serve`
 * runtime (opencode-ai 1.18.18 from node_modules). No API key required: model
 * calls are expected to fail, but everything else (serve boot, session create,
 * event bus, status, diff, abort, resume) must work, and model failures must
 * surface as clean error/turn.failed events instead of crashes.
 *
 * Run: npm run smoke:real
 */
import { spawn, execFile as execFileCb, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AgentEvent, ShimStatus } from '@pocketagent/protocol';

const exec = promisify(execFileCb);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const root = dirname(fileURLToPath(import.meta.url));
const tsxCandidate = [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')].find((p) => existsSync(p));
if (tsxCandidate === undefined) throw new Error('tsx cli not found (neither local nor hoisted)');
const tsxCli: string = tsxCandidate;

const OC_PORT = 4197;
const SHIM_PORT = 8091;
const OC_URL = `http://127.0.0.1:${OC_PORT}`;
const SHIM_URL = `http://127.0.0.1:${SHIM_PORT}`;
const TOKEN = 'testtoken';
const HEADERS = { authorization: `Bearer ${TOKEN}` };

function resolveOpenCodeBin(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('opencode-ai/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin?: string | Record<string, string> };
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.opencode ?? pkg.bin?.['opencode-ai'];
  if (typeof rel !== 'string') throw new Error('opencode-ai bin entry not found');
  return resolve(dirname(pkgPath), rel);
}

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`assert failed: ${label}`);
}

async function api<T>(method: string, path: string, body?: unknown, baseUrl = SHIM_URL, headers: Record<string, string> = HEADERS): Promise<{ status: number; data: T | undefined; text: string }> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: T | undefined;
  if (text.length > 0) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = undefined;
    }
  }
  return { status: res.status, data, text };
}

/** Reads one SSE endpoint, pushing parsed `data:` frames into `out`. */
async function sseTap(url: string, out: unknown[], headers: Record<string, string> = {}): Promise<() => void> {
  const controller = new AbortController();
  void (async () => {
    try {
      const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: controller.signal });
      if (!res.ok || res.body === null) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const chunk = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (data.length > 0) {
            try {
              out.push(JSON.parse(data));
            } catch {
              out.push(data);
            }
          }
        }
      }
    } catch {
      // aborted or dropped
    }
  })();
  await sleep(300); // let the initial connection + server.connected frame land
  return () => controller.abort();
}

const agentEvents: AgentEvent[] = [];
const rawBusEvents: unknown[] = [];

function waitFor<T>(list: T[], predicate: (item: T) => boolean, label: string, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise) => {
    const poll = (): void => {
      const hit = list.find(predicate);
      if (hit !== undefined) return resolvePromise(hit);
      if (Date.now() > deadline) {
        console.error(`[real-check] timeout waiting for "${label}"`);
        return resolvePromise(undefined);
      }
      setTimeout(poll, 150);
    };
    poll();
  });
}

function printRawEventSamples(): void {
  const seen = new Set<string>();
  const samples: unknown[] = [];
  for (const event of rawBusEvents) {
    const type = typeof event === 'object' && event !== null && 'type' in event ? String((event as { type: unknown }).type) : '?';
    if (seen.has(type)) continue;
    seen.add(type);
    samples.push(event);
  }
  console.log(`\n[real-check] real /event bus: ${rawBusEvents.length} frames, types: ${[...seen].join(', ') || '(none)'}`);
  for (const sample of samples.slice(0, 5)) {
    console.log(`  ${JSON.stringify(sample).slice(0, 400)}`);
  }
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'opencode-real-work-'));
  let server: ChildProcess | undefined;
  let shim: ChildProcess | undefined;
  let stopBusTap: (() => void) | undefined;

  try {
    // 1. temp repo with one commit
    await exec('git', ['-C', workDir, 'init', '-b', 'main']);
    await exec('git', ['-C', workDir, 'config', 'user.name', 'RealCheck']);
    await exec('git', ['-C', workDir, 'config', 'user.email', 'real@test.local']);
    writeFileSync(join(workDir, 'README.md'), '# real check\n');
    await exec('git', ['-C', workDir, 'add', '-A']);
    await exec('git', ['-C', workDir, 'commit', '-m', 'init']);
    console.log(`[real-check] temp repo: ${workDir}`);

    // 2. real opencode server (no OPENCODE_SERVER_PASSWORD -> unsecured, exactly what we want)
    const bin = resolveOpenCodeBin();
    const serverEnv = { ...process.env };
    delete serverEnv.OPENCODE_SERVER_PASSWORD;
    server = spawn(bin, ['serve', '--port', String(OC_PORT), '--hostname', '127.0.0.1'], {
      cwd: workDir,
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const serverLog: string[] = [];
    server.stdout?.on('data', (c: Buffer) => {
      const text = c.toString();
      serverLog.push(text);
      process.stdout.write(`[opencode-serve] ${text}`);
    });
    server.stderr?.on('data', (c: Buffer) => {
      const text = c.toString();
      serverLog.push(text);
      process.stderr.write(`[opencode-serve:err] ${text}`);
    });

    // 3. readiness: /doc (OpenAPI) and /health; also probe /openapi.json
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      try {
        const res = await fetch(`${OC_URL}/doc`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) ready = true;
      } catch {
        // retry
      }
      if (!ready) await sleep(500);
    }
    assert(ready, `opencode serve ready on ${OC_URL} (log: ${serverLog.join('').slice(-1500)})`);
    const docProbe = await api<unknown>('GET', '/doc', undefined, OC_URL, {});
    const openapiProbe = await api<unknown>('GET', '/openapi.json', undefined, OC_URL, {});
    const healthProbe = await api<{ healthy?: boolean }>('GET', '/health', undefined, OC_URL, {});
    console.log(`[real-check] readiness: /doc HTTP ${docProbe.status}, /openapi.json HTTP ${openapiProbe.status}, /health HTTP ${healthProbe.status} ${JSON.stringify(healthProbe.data)}`);

    // 4. direct tap on the REAL event bus (raw frames, printed at the end)
    stopBusTap = await sseTap(`${OC_URL}/event`, rawBusEvents);

    // 5. shim in external mode against the real server
    shim = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
      cwd: root,
      env: {
        ...process.env,
        OPENCODE_SPAWN: '0',
        OPENCODE_BASE_URL: OC_URL,
        SHIM_TOKEN: TOKEN,
        WORK_DIR: workDir,
        SESSION_ID: 'real-sess',
        AGENT_MODE: 'ask',
        AUTO_PUSH: '0',
        REPO_URL: '',
        REPO_FULL_NAME: 'test/repo',
        PORT: String(SHIM_PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const shimLog: string[] = [];
    shim.stdout?.on('data', (c: Buffer) => shimLog.push(c.toString()));
    shim.stderr?.on('data', (c: Buffer) => shimLog.push(c.toString()));
    shim.on('exit', (code) => {
      if (code !== null && code !== 0) console.error(`[real-check] shim exited early (${code}):\n${shimLog.join('').slice(-1500)}`);
    });

    let shimHealthy = false;
    for (let i = 0; i < 80 && !shimHealthy; i++) {
      try {
        const res = await fetch(`${SHIM_URL}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) shimHealthy = true;
      } catch {
        // retry
      }
      if (!shimHealthy) await sleep(500);
    }
    assert(shimHealthy, `shim healthy on :${SHIM_PORT} (log: ${shimLog.join('').slice(-1500)})`);

    // 6. auth + boot state
    const noToken = await api<unknown>('GET', '/status', undefined, SHIM_URL, {});
    assert(noToken.status === 401, 'GET /status without token -> 401');
    const status = await api<ShimStatus>('GET', '/status');
    assert(status.status === 200 && status.data !== undefined, 'GET /status -> 200');
    assert(status.data?.adapter === 'opencode', 'status.adapter === opencode');
    assert(status.data?.busy === false, 'status.busy === false after boot');
    assert(typeof status.data?.sessionRef === 'string' && (status.data?.sessionRef ?? '').length > 0, `boot createSession worked against real server (sessionRef=${String(status.data?.sessionRef)})`);
    const sessionRef = status.data?.sessionRef;
    if (sessionRef === undefined) throw new Error('unreachable');
    console.log(`[real-check] shim sessionRef: ${sessionRef} (mode=${status.data?.mode})`);

    // 7. diff must be [] on a clean session
    const diff = await api<unknown[]>('GET', '/diff');
    assert(diff.status === 200 && Array.isArray(diff.data), 'GET /diff -> 200 array');
    assert((diff.data ?? []).length === 0, 'GET /diff -> []');

    // 8. prompt without API key: model call must fail, but as a CLEAN error event
    const stopShimTap = await sseTap(`${SHIM_URL}/events`, agentEvents, HEADERS);
    const prompt = await api<{ ok?: boolean; error?: string }>('POST', '/prompt', { text: 'say hi' });
    console.log(`[real-check] POST /prompt -> HTTP ${prompt.status} ${prompt.text.slice(0, 200)}`);
    const terminal = await waitFor(
      agentEvents,
      (e) => e.type === 'turn.failed' || e.type === 'turn.completed',
      'turn.failed|turn.completed',
      45_000,
    );
    assert(terminal !== undefined, `terminal event after failed model call (events: ${agentEvents.map((e) => e.type).join(', ')})`);
    const errorEvent = agentEvents.find((e) => e.type === 'error');
    assert(errorEvent !== undefined, 'error event emitted for failed model call');
    if (errorEvent !== undefined && errorEvent.type === 'error') {
      console.log(`[real-check] error event: ${errorEvent.message.slice(0, 300)}`);
    }
    if (terminal !== undefined && terminal.type === 'turn.failed') {
      console.log(`[real-check] turn.failed: ${terminal.error.slice(0, 300)}`);
    } else if (terminal !== undefined && terminal.type === 'turn.completed') {
      console.log('[real-check] NOTE: turn ended as turn.completed (no explicit failure event) — inspect logs');
    }
    const failed = terminal !== undefined && terminal.type === 'turn.failed';
    assert(failed || prompt.status === 502, 'failure surfaced as turn.failed event and/or HTTP 502');

    // shim must survive the failed turn
    const statusAfter = await api<ShimStatus>('GET', '/status');
    assert(statusAfter.status === 200 && statusAfter.data?.busy === false, 'status.busy === false after failed turn');
    assert(statusAfter.data?.sessionRef === sessionRef, 'sessionRef preserved after failed turn');

    // 9. abort + resume with the real sessionRef
    const abort = await api<{ ok?: boolean }>('POST', '/abort', {});
    assert(abort.status === 200 && abort.data?.ok === true, 'POST /abort -> ok');
    const resume = await api<{ ok?: boolean }>('POST', '/resume', { sessionRef });
    assert(resume.status === 200 && resume.data?.ok === true, `POST /resume(sessionRef) -> ok`);
    const statusFinal = await api<ShimStatus>('GET', '/status');
    assert(statusFinal.data?.sessionRef === sessionRef, 'sessionRef still the real opencode session after resume');
    assert(agentEvents.some((e) => e.type === 'status'), 'shim emitted status events');

    printRawEventSamples();
    stopShimTap();
    console.log('\nREAL CHECK OK');
  } finally {
    stopBusTap?.();
    shim?.kill('SIGTERM');
    server?.kill('SIGTERM');
    await sleep(300);
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('REAL CHECK FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
