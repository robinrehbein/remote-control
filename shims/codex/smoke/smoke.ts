import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import http, { type IncomingMessage } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import type { AgentEvent } from '@pocketagent/protocol';
import { EventBroadcaster } from '../src/events.js';
import { buildApp, loadConfig, splitModelRef, autoPushForMode } from '../src/index.js';
import {
  RealCodexRunner,
  mapMode,
  normalizeCodexNotification,
  parseDeviceCodePrompt,
  normItemType,
} from '../src/codex.js';
import { JsonRpcEndpoint } from '../src/jsonrpc.js';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const FAKE_APP_SERVER = join(here, 'fake-app-server.js');

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function waitFor<T>(
  values: () => readonly T[],
  predicate: (value: T) => boolean,
  timeoutMs: number,
  what: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
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
    let buffer = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      markConnected();
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
  return { events, connected, close: () => req.destroy() };
}

/* ------------------------------------------------------------------ */
/* Pure-function unit checks (normalization / mapping / parsing)       */
/* ------------------------------------------------------------------ */

function unitChecks(): void {
  // mode -> policy
  expect(mapMode('yolo').approvalPolicy === 'never' && mapMode('yolo').sandboxMode === 'danger-full-access', 'yolo maps to never + danger-full-access');
  expect(mapMode('auto').approvalPolicy === 'never' && mapMode('auto').sandboxMode === 'workspace-write' && mapMode('auto').networkAccess, 'auto maps to never + workspace-write + network');
  expect(mapMode('acceptEdits').approvalPolicy === 'on-request' && mapMode('acceptEdits').sandboxMode === 'workspace-write', 'acceptEdits maps to on-request + workspace-write');
  expect(mapMode('ask').approvalPolicy === 'untrusted' && mapMode('ask').sandboxMode === 'workspace-write', 'ask maps to untrusted + workspace-write');

  // item type normalization (snake vs camel)
  expect(normItemType('command_execution') === normItemType('commandExecution'), 'snake and camel item types normalize alike');

  // event normalization
  const types = new Map<string, string>();
  const started = normalizeCodexNotification('item/started', { item: { id: 'c1', type: 'command_execution', command: 'ls -la' } }, types);
  expect(started.length === 1 && started[0]?.type === 'tool.call' && (started[0] as { tool: string }).tool === 'shell', 'command_execution started -> tool.call shell');
  const delta = normalizeCodexNotification('item/agentMessage/delta', { itemId: 'm1', delta: 'hi' }, types);
  expect(delta.length === 1 && delta[0]?.type === 'message.delta', 'agentMessage delta -> message.delta');
  const done = normalizeCodexNotification('item/completed', { item: { id: 'c1', type: 'command_execution', aggregatedOutput: 'x', exitCode: 2 } }, types);
  expect(done.length === 1 && done[0]?.type === 'tool.result' && (done[0] as { isError?: boolean }).isError === true, 'nonzero exit -> tool.result isError');
  const reasoning = normalizeCodexNotification('item/reasoning/delta', { itemId: 'r1', delta: 'think' }, types);
  expect(reasoning.length === 0, 'reasoning delta is dropped (no thinking channel)');
  const unknown = normalizeCodexNotification('turn/something-new', {}, types);
  expect(unknown.length === 0, 'unknown notification ignored tolerantly');

  // device-code parsing
  const prompt = parseDeviceCodePrompt('Visit https://auth.openai.com/device and enter ABCD-1234');
  expect(prompt?.userCode === 'ABCD-1234' && prompt?.verificationUrl === 'https://auth.openai.com/device', 'device-code prompt parsed');
  expect(parseDeviceCodePrompt('nothing to see here') === undefined, 'non-code line yields undefined');

  // model ref + autopush helpers
  expect(splitModelRef('openai/gpt-x') === 'gpt-x', 'splitModelRef strips provider segment');
  expect(splitModelRef('gpt-x') === 'gpt-x', 'splitModelRef keeps bare model');
  expect(autoPushForMode('yolo', false) === true && autoPushForMode('ask', true) === false, 'autoPushForMode follows the turn mode');
}

/* ------------------------------------------------------------------ */
/* Sequenced broadcaster: seq ids + Last-Event-ID replay (W2.1)        */
/* ------------------------------------------------------------------ */

function broadcasterReplayCheck(): void {
  const bus = new EventBroadcaster();
  const seqOf = (event: AgentEvent): number | undefined => bus.publish(event);

  const s1 = seqOf({ type: 'notice', message: 'e1' });
  const s2 = seqOf({ type: 'notice', message: 'e2' });
  const s3 = seqOf({ type: 'notice', message: 'e3' });
  expect(s1 === 1 && s2 === 2 && s3 === 3, 'publish stamps monotone seq ids');
  expect(bus.publish({ type: 'ping', ts: 1 }) === undefined, 'ping is unsequenced (consumes no id)');

  // A reconnecting client with Last-Event-ID=1 replays only e2 + e3.
  const frames: string[] = [];
  const sink = { write: (s: string) => frames.push(s), writableEnded: false, on: () => {} };
  bus.add(sink as unknown as import('node:http').ServerResponse, 1);
  expect(frames.length === 2, 'reconnect replays exactly the events after the cursor');
  expect(frames[0]?.includes('id: 2') === true && frames[0]?.includes('e2') === true, 'first replayed frame is e2 with its id');
  expect(frames[1]?.includes('id: 3') === true && frames[1]?.includes('e3') === true, 'second replayed frame is e3 with its id');

  // A live event after the reconnect reaches the same client.
  bus.publish({ type: 'notice', message: 'e4' });
  expect(frames.some((f) => f.includes('e4') && f.includes('id: 4')), 'live event after replay keeps the sequence going');
  expect(bus.lastId === 4, 'lastId tracks the highest sequenced event');

  // A fresh client (no cursor) gets no replay, only future events.
  const fresh: string[] = [];
  const freshSink = { write: (s: string) => fresh.push(s), writableEnded: false, on: () => {} };
  bus.add(freshSink as unknown as import('node:http').ServerResponse);
  expect(fresh.length === 0, 'a fresh client without Last-Event-ID replays nothing');
}

/* ------------------------------------------------------------------ */
/* JSON-RPC overload backoff (-32001) unit check                       */
/* ------------------------------------------------------------------ */

async function overloadCheck(): Promise<void> {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const ep = new JsonRpcEndpoint(toServer, toClient, { overloadRetries: 3, overloadBackoffMs: 5, onLog: () => {} });
  let attempts = 0;
  let sbuf = '';
  toServer.on('data', (chunk: Buffer) => {
    sbuf += chunk.toString('utf8');
    let nl = sbuf.indexOf('\n');
    while (nl !== -1) {
      const line = sbuf.slice(0, nl).trim();
      sbuf = sbuf.slice(nl + 1);
      if (line) {
        const msg = JSON.parse(line) as { id: number; method: string };
        if (msg.method === 'load') {
          attempts += 1;
          if (attempts < 3) {
            toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'overloaded' } })}\n`);
          } else {
            toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } })}\n`);
          }
        }
      }
      nl = sbuf.indexOf('\n');
    }
  });
  const result = await ep.request<{ ok: boolean }>('load', {}, { retryOnOverload: true, timeoutMs: 5_000 });
  expect(result.ok === true && attempts === 3, `overload retried to success (attempts=${attempts})`);
  ep.close();
}

/* ------------------------------------------------------------------ */
/* End-to-end shim <-> fake app-server                                 */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  unitChecks();
  broadcasterReplayCheck();
  await overloadCheck();

  const workDir = await mkdtemp(join(tmpdir(), 'codex-shim-smoke-work-'));
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-shim-smoke-home-'));

  await exec('git', ['init', '-b', 'main'], { cwd: workDir });
  await exec('git', ['config', 'user.name', 'Smoke Test'], { cwd: workDir });
  await exec('git', ['config', 'user.email', 'smoke@test.local'], { cwd: workDir });
  await writeFile(join(workDir, 'README.md'), '# smoke repo\n', 'utf8');
  await exec('git', ['add', '-A'], { cwd: workDir });
  await exec('git', ['commit', '-m', 'init', '--no-verify'], { cwd: workDir });

  process.env.SHIM_TOKEN = 'smoke-token-123';
  process.env.WORK_DIR = workDir;
  process.env.SESSION_ID = 'smoke-sess';
  process.env.AGENT_MODE = 'ask';
  process.env.ADAPTER = 'codex';
  process.env.AUTO_PUSH = '0';
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_HEARTBEAT_MS = '300';

  const config = loadConfig(process.env);
  const bus = new EventBroadcaster();
  bus.startHeartbeat(config.heartbeatMs);
  const runner = new RealCodexRunner({
    workDir,
    codexHome,
    mode: config.mode,
    permissionTimeoutMs: 5_000,
    emit: event => bus.publish(event),
    // Spawn the fake app-server as the child, exercising the real JSON-RPC path.
    command: process.execPath,
    args: [FAKE_APP_SERVER],
  });
  await runner.init();

  const app = buildApp({ config, runner, bus, gitCtx: { workDir, sessionId: config.sessionId }, branch: 'agent/smoke-sess' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const auth = { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' };

  // --- auth: health public, everything else bearer-gated ---
  expect((await fetch(`${base}/health`)).status === 200, 'GET /health -> 200');
  expect((await fetch(`${base}/status`)).status === 401, 'GET /status without token -> 401');
  expect((await fetch(`${base}/status`, { headers: { authorization: 'Bearer wrong' } })).status === 401, 'GET /status wrong token -> 401');

  // --- handshake succeeded: thread bound ---
  const status0 = (await (await fetch(`${base}/status`, { headers: auth })).json()) as {
    adapter: string; busy: boolean; mode: string; provider?: string; sessionRef?: string;
  };
  expect(status0.adapter === 'codex', '/status adapter is codex');
  expect(status0.busy === false, '/status initially idle');
  expect(status0.mode === 'ask', '/status mode from env');
  expect(status0.provider === 'openai', '/status provider is openai');
  expect(status0.sessionRef === 'thread-fake-1', 'handshake bound thread id from thread/start');

  const models = (await (await fetch(`${base}/models`, { headers: auth })).json()) as { models: unknown[] };
  expect(Array.isArray(models.models) && models.models.length === 0, 'GET /models is an empty catalog');

  const sse = openSse(base, config.token);
  await sse.connected;

  // --- turn 1 (ask): forward BOTH approvals; accept edit, reject command ---
  const p1 = await fetch(`${base}/prompt`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ text: 'please edit hello and run the cmd', mode: 'ask' }),
  });
  expect(p1.status === 200, 'POST /prompt accepted');

  const editReq = await waitFor(() => sse.events, e => e.type === 'permission.request' && e.kind === 'edit', 5_000, 'edit permission.request');
  if (editReq.type !== 'permission.request') throw new Error('unreachable');
  expect(sse.events.some(e => e.type === 'tool.call' && e.tool === 'apply_patch'), 'file_change emitted tool.call before its approval');
  await fetch(`${base}/permissions/${editReq.permissionId}`, { method: 'POST', headers: auth, body: JSON.stringify({ response: 'once' }) });

  const cmdReq = await waitFor(() => sse.events, e => e.type === 'permission.request' && e.kind === 'bash', 5_000, 'bash permission.request');
  if (cmdReq.type !== 'permission.request') throw new Error('unreachable');
  await fetch(`${base}/permissions/${cmdReq.permissionId}`, { method: 'POST', headers: auth, body: JSON.stringify({ response: 'reject' }) });

  const done1 = await waitFor(() => sse.events, e => e.type === 'turn.completed', 5_000, 'turn.completed (turn 1)');
  expect(done1.type === 'turn.completed' && typeof done1.commitSha === 'string', 'turn.completed carries commitSha');
  expect(done1.type === 'turn.completed' && done1.usage?.input === 10 && done1.usage?.output === 20, 'usage normalized from turn/completed');
  expect(sse.events.some(e => e.type === 'message.delta' && e.delta.includes('Working on it')), 'assistant delta emitted');
  expect(sse.events.some(e => e.type === 'message.completed' && e.text.includes('Done.')), 'final assistant message emitted');
  expect(sse.events.some(e => e.type === 'tool.result' && e.tool === 'apply_patch'), 'file_change tool.result emitted');
  expect(sse.events.some(e => e.type === 'tool.result' && e.tool === 'shell' && e.isError === true), 'declined command surfaced as errored tool.result');
  expect(sse.events.some(e => e.type === 'permission.resolved' && e.decision === 'reject'), 'command rejection resolved');

  const hello = await readFile(join(workDir, 'hello.txt'), 'utf8');
  expect(hello.includes('hello from codex'), 'accepted file_change wrote hello.txt');
  const log = await exec('git', ['log', '--oneline'], { cwd: workDir });
  expect(log.stdout.includes('agent: turn'), 'auto-commit created after the turn');

  const editPermsAfterTurn1 = sse.events.filter(e => e.type === 'permission.request' && e.kind === 'edit').length;

  // --- turn 2 (acceptEdits): file_change auto-accepted, command still forwarded ---
  const p2 = await fetch(`${base}/prompt`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ text: 'edit hello again and run the cmd', mode: 'acceptEdits' }),
  });
  expect(p2.status === 200, 'second prompt accepted');

  const cmdReq2 = await waitFor(() => sse.events, e => e.type === 'permission.request' && e.kind === 'bash' && e !== cmdReq, 5_000, 'bash permission.request (turn 2)');
  if (cmdReq2.type !== 'permission.request') throw new Error('unreachable');
  await fetch(`${base}/permissions/${cmdReq2.permissionId}`, { method: 'POST', headers: auth, body: JSON.stringify({ response: 'once' }) });

  const done2 = await waitFor(() => sse.events, e => e.type === 'turn.completed' && e !== done1, 5_000, 'turn.completed (turn 2)');
  expect(done2.type === 'turn.completed', 'second turn completed');
  const editPermsAfterTurn2 = sse.events.filter(e => e.type === 'permission.request' && e.kind === 'edit').length;
  expect(editPermsAfterTurn2 === editPermsAfterTurn1, 'acceptEdits auto-accepts file_change (no new edit approval)');

  // --- abort: hanging turn is interrupted, session returns to idle ---
  const p3 = await fetch(`${base}/prompt`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'hang the turn', mode: 'ask' }) });
  expect(p3.status === 200, 'hang prompt accepted');
  await waitFor(() => sse.events, e => e.type === 'status' && e.busy === true, 5_000, 'busy status');
  const abort = await fetch(`${base}/abort`, { method: 'POST', headers: auth });
  expect(abort.status === 200, `POST /abort accepted (got ${abort.status})`);
  await waitFor(() => sse.events, e => (e.type === 'turn.completed' || e.type === 'turn.failed') && e !== done1 && e !== done2, 5_000, 'turn end after abort');
  const statusAbort = (await (await fetch(`${base}/status`, { headers: auth })).json()) as { busy: boolean };
  expect(statusAbort.busy === false, 'idle again after abort');

  // --- resume: thread id from the runtime state ---
  const resume = await fetch(`${base}/resume`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionRef: 'thread-resumed-xyz' }) });
  expect(resume.status === 200, 'POST /resume accepted');
  const statusResume = (await (await fetch(`${base}/status`, { headers: auth })).json()) as { sessionRef?: string };
  expect(statusResume.sessionRef === 'thread-resumed-xyz', '/status reflects the resumed thread id');

  // --- diff endpoint sees the untracked/committed state ---
  await writeFile(join(workDir, 'uncommitted.txt'), 'extra line\n', 'utf8');
  const diff = (await (await fetch(`${base}/diff`, { headers: auth })).json()) as { path: string; patch: string }[];
  expect(diff.some(entry => entry.path === 'uncommitted.txt' && entry.patch.includes('+extra line')), 'GET /diff lists the new file');

  // --- heartbeat ---
  await waitFor(() => sse.events, e => e.type === 'ping', 5_000, 'SSE heartbeat ping');

  sse.close();
  await runner.dispose();
  await app.close();
  bus.stop();

  await rm(workDir, { recursive: true, force: true });
  await rm(codexHome, { recursive: true, force: true });

  console.log('SMOKE OK');
}

main().catch(error => {
  console.error('SMOKE FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
