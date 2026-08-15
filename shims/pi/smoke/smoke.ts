import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import http, { type IncomingMessage } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentEvent } from '@pocketagent/protocol';
import { EventBroadcaster } from '../src/events';
import { buildApp, loadConfig } from '../src/index';
import { FakeRunner } from './fake';

const exec = promisify(execFile);

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function waitFor<T>(values: () => readonly T[], predicate: (value: T) => boolean, timeoutMs: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = values().find(predicate);
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timeout waiting for ${what}`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

interface SseClient {
  events: AgentEvent[];
  connected: Promise<void>;
  close(): void;
}

function openSse(base: string, token: string): SseClient {
  const events: AgentEvent[] = [];
  let markConnected: () => void = () => {};
  const connected = new Promise<void>(resolve => {
    markConnected = resolve;
  });
  const req = http.get(`${base}/events`, { headers: { authorization: `Bearer ${token}` } }, (res: IncomingMessage) => {
    expect(res.statusCode === 200, `SSE status 200, got ${res.statusCode ?? 'none'}`);
    expect(
      (res.headers['content-type'] ?? '').includes('text/event-stream'),
      'SSE content-type is text/event-stream',
    );
    let buffer = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      if (events.length === 0) markConnected();
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
  });
  req.on('error', (err: Error) => {
    throw new Error(`SSE connection failed: ${err.message}`);
  });
  return {
    events,
    connected,
    close: () => req.destroy(),
  };
}

async function main(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'pi-shim-smoke-work-'));
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-shim-smoke-agent-'));

  await exec('git', ['init', '-b', 'main'], { cwd: workDir });
  await exec('git', ['config', 'user.name', 'Smoke Test'], { cwd: workDir });
  await exec('git', ['config', 'user.email', 'smoke@test.local'], { cwd: workDir });
  await writeFile(join(workDir, 'README.md'), '# smoke repo\n', 'utf8');
  await exec('git', ['add', '-A'], { cwd: workDir });
  await exec('git', ['commit', '-m', 'init', '--no-verify'], { cwd: workDir });

  process.env.SHIM_TOKEN = 'smoke-token-123';
  process.env.WORK_DIR = workDir;
  process.env.SESSION_ID = 'smoke-sess';
  process.env.AGENT_MODE = 'yolo';
  process.env.ADAPTER = 'pi';
  process.env.AUTO_PUSH = '0';
  process.env.PI_AGENT_DIR = agentDir;
  process.env.PI_AUTO_CONTINUE = '0';
  process.env.PI_HEARTBEAT_MS = '300';

  const config = loadConfig(process.env);
  const bus = new EventBroadcaster();
  bus.startHeartbeat(config.heartbeatMs);
  const runner = new FakeRunner({
    workDir,
    mode: config.mode,
    permissionTimeoutMs: 5_000,
    emit: event => bus.publish(event),
  });
  await runner.init();
  const app = buildApp({
    config,
    runner,
    bus,
    gitCtx: { workDir, sessionId: config.sessionId },
    branch: 'agent/smoke-sess',
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const auth = { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' };

  // health is public, everything else requires the bearer token
  const health = await fetch(`${base}/health`);
  expect(health.status === 200, 'GET /health -> 200');
  const unauth = await fetch(`${base}/status`);
  expect(unauth.status === 401, `GET /status without token -> 401, got ${unauth.status}`);
  const badToken = await fetch(`${base}/status`, { headers: { authorization: 'Bearer wrong' } });
  expect(badToken.status === 401, 'GET /status with wrong token -> 401');

  const status0 = (await (await fetch(`${base}/status`, { headers: auth })).json()) as {
    adapter: string;
    busy: boolean;
    mode: string;
  };
  expect(status0.adapter === 'pi', '/status adapter is pi');
  expect(status0.busy === false, '/status initially idle');
  expect(status0.mode === 'yolo', '/status mode from env');

  const sse = openSse(base, config.token);
  await sse.connected;

  // --- turn 1: ask mode, permission flow via /permissions/:id ---
  const prompt1Body = (await (await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ text: 'write the hello file', mode: 'ask' }),
  })).json()) as { ok?: boolean };
  expect(prompt1Body.ok === true, 'POST /prompt accepted');

  const request1 = await waitFor(
    () => sse.events,
    event => event.type === 'permission.request',
    5_000,
    'permission.request',
  );
  if (request1.type !== 'permission.request') throw new Error('expected permission.request');
  expect(request1.kind === 'bash', 'permission kind bash');
  expect(
    sse.events.some(event => event.type === 'tool.call' && event.tool === 'bash'),
    'tool.call(bash) emitted before permission.request',
  );
  expect(
    sse.events.some(event => event.type === 'message.delta' && event.delta.includes('Working on it')),
    'message.delta emitted',
  );

  const answer = await fetch(`${base}/permissions/${request1.permissionId}`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ response: 'always' }),
  });
  expect(answer.status === 200, 'POST /permissions/:id accepted');

  const completed1 = await waitFor(
    () => sse.events,
    event => event.type === 'turn.completed',
    5_000,
    'turn.completed after permission grant',
  );
  expect(completed1.type === 'turn.completed' && typeof completed1.commitSha === 'string', 'turn.completed has commitSha');
  expect(
    sse.events.some(event => event.type === 'permission.resolved' && event.decision === 'always'),
    'permission.resolved always',
  );
  expect(
    sse.events.some(event => event.type === 'tool.result' && event.tool === 'bash' && event.isError !== true),
    'tool.result ok',
  );
  expect(
    sse.events.some(event => event.type === 'message.completed' && event.text.includes('Done.')),
    'message.completed final text',
  );

  const hello = await readFile(join(workDir, 'hello.txt'), 'utf8');
  expect(hello === 'hello\n', 'fake tool wrote hello.txt');
  const log = await exec('git', ['log', '--oneline'], { cwd: workDir });
  expect(log.stdout.includes('agent: turn'), 'auto-commit created');

  // --- unknown model -> synchronous 400 ---
  const badModel = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ text: 'hi', provider: 'nope', model: 'nope-model' }),
  });
  expect(badModel.status === 400, `unknown model -> 400, got ${badModel.status}`);

  // --- diff endpoint (untracked + committed state) ---
  await writeFile(join(workDir, 'uncommitted.txt'), 'extra line\n', 'utf8');
  const diff = (await (await fetch(`${base}/diff`, { headers: auth })).json()) as {
    path: string;
    patch: string;
    binary?: boolean;
  }[];
  const entry = diff.find(item => item.path === 'uncommitted.txt');
  expect(entry !== undefined, 'GET /diff lists uncommitted.txt');
  expect((entry?.patch ?? '').includes('+extra line'), 'diff patch contains +extra line');
  expect(!diff.some(item => item.path === 'hello.txt'), 'committed files are not in diff');

  // --- turn 2: "always" allowlist suppresses the second permission.request ---
  const prompt2 = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ text: 'run it again', mode: 'ask' }),
  });
  expect(prompt2.status === 200, 'second prompt accepted');
  const completed2 = await waitFor(
    () => sse.events,
    event => event.type === 'turn.completed' && event !== completed1,
    5_000,
    'turn.completed for allowlisted rerun',
  );
  expect(completed2.type === 'turn.completed', 'second turn completed');
  const permissionRequests = sse.events.filter(event => event.type === 'permission.request').length;
  expect(permissionRequests === 1, `allowlisted rerun must not re-ask (got ${permissionRequests})`);

  // --- abort flow ---
  const prompt3 = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ text: 'hang the turn' }),
  });
  expect(prompt3.status === 200, 'hang prompt accepted');
  await waitFor(() => sse.events, event => event.type === 'status' && event.busy === true, 5_000, 'busy status');
  const abort = await fetch(`${base}/abort`, { method: 'POST', headers: auth });
  expect(abort.status === 200, `POST /abort accepted (got ${abort.status}: ${await abort.text()})`);
  await waitFor(
    () => sse.events,
    event => (event.type === 'turn.completed' || event.type === 'turn.failed') && event !== completed1 && event !== completed2,
    5_000,
    'turn end after abort',
  );
  const statusAbort = (await (await fetch(`${base}/status`, { headers: auth })).json()) as { busy: boolean };
  expect(statusAbort.busy === false, 'idle again after abort');

  // --- resume ---
  const resume = await fetch(`${base}/resume`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ sessionRef: join(agentDir, 'resumed-session.jsonl') }),
  });
  expect(resume.status === 200, 'POST /resume accepted');
  const statusResume = (await (await fetch(`${base}/status`, { headers: auth })).json()) as {
    sessionRef?: string;
  };
  expect(statusResume.sessionRef === join(agentDir, 'resumed-session.jsonl'), '/status reflects resumed sessionRef');

  // --- heartbeat ---
  await waitFor(() => sse.events, event => event.type === 'ping', 5_000, 'SSE heartbeat ping');

  sse.close();
  await app.close();
  bus.stop();
  await rm(workDir, { recursive: true, force: true });
  await rm(agentDir, { recursive: true, force: true });

  console.log('SMOKE OK');
}

main().catch(error => {
  console.error('SMOKE FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
