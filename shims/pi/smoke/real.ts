/**
 * Real-SDK check (no API keys): boots RealPiRunner against the actual
 * @earendil-works/pi-coding-agent SDK and verifies boot wiring + clean error
 * paths. Run with: npm run smoke:real
 *
 * Phase A (runner level):
 *  - temp git repo, RealPiRunner.init() with DefaultResourceLoader
 *    ({noExtensions:true, extensionFactories:[gate]}) + createAgentSession
 *  - gate extension actually registered (tool_call handlers present)
 *  - session dir under <work>/.pi-sessions exists, sessionRef points into it
 *  - validateModel with unknown model -> PromptError (400 path)
 *  - prompt() without credentials -> caught, readable rejection (no hang,
 *    no unhandled rejection)
 *
 * Phase B (shim level): main() boot, GET /status, POST /prompt -> SSE
 * turn.failed with readable auth error within 60s, /status idle afterwards.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http, { type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import type { AgentEvent } from '@pocketagent/protocol';
import { main } from '../src/index';
import { PromptError, PermissionGate, RealPiRunner } from '../src/pi';

const exec = promisify(execFile);
const GLOBAL_TIMEOUT_MS = 110_000;
const PROMPT_TIMEOUT_MS = 45_000;
const SHIM_TURN_TIMEOUT_MS = 60_000;

const unhandled: unknown[] = [];
process.on('unhandledRejection', reason => {
  unhandled.push(reason);
});

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Race a promise against a timeout so a hanging SDK path fails loudly. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms (hanging promise?)`)), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function waitFor<T>(values: () => readonly T[], predicate: (value: T) => boolean, timeoutMs: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const found = values().find(predicate);
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timeout waiting for ${what}; got: ${values().map(v => JSON.stringify(v)).join(', ')}`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function readSse(res: IncomingMessage, events: AgentEvent[]): void {
  let buffer = '';
  res.setEncoding('utf8');
  res.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          events.push(JSON.parse(line.slice(6)) as AgentEvent);
        } catch {
          /* ignore malformed frame */
        }
      }
      index = buffer.indexOf('\n\n');
    }
  });
}

function openSse(base: string, token: string, events: AgentEvent[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}/events`, { headers: { authorization: `Bearer ${token}` } }, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE connect -> ${res.statusCode ?? 'none'}`));
        return;
      }
      readSse(res, events);
      resolve();
    });
    req.on('error', reject);
  });
}

async function makeTempRepo(): Promise<{ workDir: string; agentDir: string; sessionDir: string }> {
  const workDir = await mkdtemp(join(tmpdir(), 'pi-real-work-'));
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-real-agent-'));
  await exec('git', ['init', '-b', 'main'], { cwd: workDir });
  await exec('git', ['config', 'user.name', 'Real Check'], { cwd: workDir });
  await exec('git', ['config', 'user.email', 'real@test.local'], { cwd: workDir });
  await writeFile(join(workDir, 'README.md'), '# real check\n', 'utf8');
  await exec('git', ['add', '-A'], { cwd: workDir });
  await exec('git', ['commit', '-m', 'init', '--no-verify'], { cwd: workDir });
  return { workDir, agentDir, sessionDir: join(workDir, '.pi-sessions') };
}

/** Mirrors RealPiRunner.attach()/gateExtension() wiring 1:1 to probe the session directly. */
async function verifyGateRegistration(
  workDir: string,
  agentDir: string,
  sessionDir: string,
  runtime: ModelRuntime,
  events: AgentEvent[],
): Promise<void> {
  const gate = new PermissionGate(event => events.push(event), () => 'ask', 5_000);
  const loader = new DefaultResourceLoader({
    cwd: workDir,
    agentDir,
    noExtensions: true,
    noThemes: true,
    extensionFactories: [
      {
        name: 'pocketagent-permissions',
        factory: pi => {
          pi.on('tool_call', async event => {
            const input = (event.input ?? {}) as Record<string, unknown>;
            const verdict = await gate.decide(event.toolName, input);
            if (verdict.block) {
              return { block: true, reason: verdict.reason, terminate: false };
            }
            return undefined;
          });
        },
      },
    ],
  });
  await loader.reload();
  const extensions = loader.getExtensions();
  expect(
    extensions.errors.length === 0,
    `inline gate extension loaded without errors (got: ${JSON.stringify(extensions.errors)})`,
  );
  const { session } = await withTimeout(
    createAgentSession({
      cwd: workDir,
      agentDir,
      modelRuntime: runtime,
      sessionManager: SessionManager.create(workDir, sessionDir),
      resourceLoader: loader,
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
    }),
    30_000,
    'createAgentSession with noExtensions+extensionFactories',
  );
  expect(
    session.hasExtensionHandlers('tool_call'),
    'gate extension registered tool_call handlers despite noExtensions:true',
  );
  const inline = extensions.extensions.filter(extension => extension.path.startsWith('<inline:'));
  expect(inline.length === 1, `exactly one inline extension loaded (got ${inline.length})`);
  session.dispose();
}

async function phaseA(): Promise<{ workDir: string; agentDir: string; sessionDir: string }> {
  console.log('[A] runner-level check against real pi SDK');
  const { workDir, agentDir, sessionDir } = await makeTempRepo();
  const events: AgentEvent[] = [];

  // 1. boot exactly like src/pi.ts does
  const runtime = await withTimeout(ModelRuntime.create({ authPath: join(agentDir, 'auth.json') }), 30_000, 'ModelRuntime.create');
  await verifyGateRegistration(workDir, agentDir, sessionDir, runtime, events);

  const runner = new RealPiRunner({
    workDir,
    agentDir,
    sessionDir,
    mode: 'ask',
    authPath: join(agentDir, 'auth.json'),
    autoContinue: false,
    permissionTimeoutMs: 5_000,
    emit: event => events.push(event),
  });
  await withTimeout(runner.init(), 30_000, 'RealPiRunner.init()');

  // 2. session dir exists; sessionRef points into <work>/.pi-sessions
  expect(existsSync(sessionDir), `session dir ${sessionDir} exists`);
  const status = runner.status();
  expect(typeof status.sessionRef === 'string', 'status has sessionRef');
  expect(
    (status.sessionRef ?? '').startsWith(sessionDir),
    `sessionRef ${status.sessionRef} is inside ${sessionDir}`,
  );
  // pi persists the .jsonl lazily (first assistant message); without creds it
  // legitimately may not exist yet -- report, don't assert.
  console.log(`[A] sessionRef=${status.sessionRef} fileExists=${existsSync(status.sessionRef ?? '')}`);

  // 3. invalid model -> clean PromptError (maps to HTTP 400 in the shim)
  let modelError: unknown;
  try {
    await runner.validateModel('nope', 'nope-model');
    modelError = new Error('validateModel did not throw');
  } catch (error) {
    modelError = error;
  }
  expect(modelError instanceof PromptError, `validateModel throws PromptError (got ${errorMessage(modelError)})`);
  expect(errorMessage(modelError) === 'unknown model nope/nope-model', `validateModel message (got ${errorMessage(modelError)})`);

  // 4. prompt without credentials -> caught, readable, fast (no hang)
  let promptError: unknown;
  try {
    await withTimeout(runner.prompt('hello'), PROMPT_TIMEOUT_MS, 'prompt without credentials');
    promptError = new Error('prompt without credentials did not fail');
  } catch (error) {
    promptError = error;
  }
  const message = errorMessage(promptError);
  console.log(`[A] no-creds prompt error: ${message.split('\n')[0]}`);
  expect(!message.includes('timed out'), 'no-creds prompt must not hang');
  expect(
    /No API key found|No model selected|Authentication failed|login/i.test(message),
    `readable auth/model error (got: ${message})`,
  );
  expect(runner.status().busy === false, 'runner idle after failed prompt');
  expect(unhandled.length === 0, `no unhandled rejections (got ${unhandled.length})`);

  runner.dispose();
  return { workDir, agentDir, sessionDir };
}

async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no ephemeral port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function phaseB(): Promise<void> {
  console.log('[B] shim-level check (real runner, no fake, no credentials)');
  const { workDir, agentDir } = await makeTempRepo();
  const token = 'real-check-token';
  const port = await freePort();
  Object.assign(process.env, {
    SHIM_TOKEN: token,
    SESSION_ID: 'real-check',
    WORK_DIR: workDir,
    AGENT_MODE: 'ask',
    ADAPTER: 'pi',
    AUTO_PUSH: '0',
    PORT: String(port),
    PI_AGENT_DIR: agentDir,
    PI_AUTO_CONTINUE: '0',
    PI_HEARTBEAT_MS: '300',
    PI_AUTH_JSON: '',
  });

  const app = await withTimeout(main(process.env), 30_000, 'shim boot');
  try {
    const address = app.server.address();
    expect(address !== null && typeof address === 'object', 'shim has tcp address');
    const base = `http://127.0.0.1:${address.port}`;
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const statusResponse = await fetch(`${base}/status`, { headers: auth });
    expect(statusResponse.status === 200, `GET /status -> 200 (got ${statusResponse.status})`);
    const status = (await statusResponse.json()) as { adapter: string; busy: boolean };
    expect(status.adapter === 'pi', '/status adapter is pi');
    expect(status.busy === false, '/status busy=false after boot');

    // unknown model -> synchronous 400 via validateModel
    const badModel = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: 'hi', provider: 'nope', model: 'nope-model' }),
    });
    expect(badModel.status === 400, `unknown model -> 400 (got ${badModel.status})`);

    const events: AgentEvent[] = [];
    await openSse(base, token, events);
    const accepted = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(accepted.status === 200, `POST /prompt accepted (got ${accepted.status})`);

    const failure = await waitFor(
      () => events,
      (event): event is AgentEvent & { type: 'turn.failed'; error: string } =>
        event.type === 'turn.failed' && typeof event.error === 'string' && event.error.length > 0,
      SHIM_TURN_TIMEOUT_MS,
      'turn.failed within 60s',
    );
    console.log(`[B] turn.failed: ${failure.error.split('\n')[0]}`);
    expect(
      /No API key found|No model selected|Authentication failed|login/i.test(failure.error),
      `readable auth/model error via SSE (got: ${failure.error})`,
    );

    const after = (await (await fetch(`${base}/status`, { headers: auth })).json()) as { busy: boolean };
    expect(after.busy === false, '/status busy=false after failed turn');
    expect(unhandled.length === 0, `no unhandled rejections (got ${unhandled.length})`);
  } finally {
    await app.close();
    await rm(workDir, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
}

async function mainCheck(): Promise<void> {
  const watchdog = setTimeout(() => {
    console.error('REAL CHECK FAILED: global timeout');
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);
  watchdog.unref();
  let dirs: { workDir: string; agentDir: string; sessionDir: string } | undefined;
  try {
    dirs = await phaseA();
    await rm(dirs.workDir, { recursive: true, force: true });
    await rm(dirs.agentDir, { recursive: true, force: true });
    await phaseB();
    console.log('REAL CHECK OK');
  } finally {
    if (dirs) {
      await rm(dirs.workDir, { recursive: true, force: true });
      await rm(dirs.agentDir, { recursive: true, force: true });
    }
  }
  process.exit(unhandled.length === 0 ? 0 : 1);
}

mainCheck().catch(error => {
  console.error('REAL CHECK FAILED:', errorMessage(error));
  process.exit(1);
});
