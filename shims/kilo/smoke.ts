/**
 * Smoke test without a real opencode runtime: starts a canned fake opencode
 * HTTP/SSE server plus the shim against a throwaway git repo, exercises the
 * whole shim API and asserts normalized events. Prints "SMOKE OK" on success.
 */
import { spawn, execFile as execFileCb, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AgentEvent, DiffEntry, ShimStatus } from '@pocketagent/protocol';

const exec = promisify(execFileCb);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const root = dirname(fileURLToPath(import.meta.url));
// tsx may live in ./node_modules or be hoisted to the monorepo root
const tsxCandidate = [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')].find((p) => existsSync(p));
if (tsxCandidate === undefined) throw new Error('tsx cli not found (neither local nor hoisted)');
const tsxCli: string = tsxCandidate;
const SHIM_PORT = 8137;
const FAKE_PORT = 4137;
const SHIM_URL = `http://127.0.0.1:${SHIM_PORT}`;
const TOKEN = 'smoke-token';

const prompts: string[] = [];
const sseClients = new Set<ServerResponse>();

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function sseBroadcast(obj: unknown): void {
  const frame = `data: ${JSON.stringify(obj)}\n\n`;
  for (const client of sseClients) client.write(frame);
}

function runTurn(): void {
  // kilo 7.x SSE wire format: {id, type, properties} envelopes
  setTimeout(() => sseBroadcast({
    type: 'permission.asked',
    properties: {
      id: 'perm-1',
      sessionID: 'sess-fake',
      permission: 'bash',
      patterns: ['echo hi'],
      metadata: { command: 'echo hi' },
      always: ['bash.echo hi'],
    },
  }), 100);
  setTimeout(() => sseBroadcast({
    type: 'message.part.updated',
    properties: { sessionID: 'sess-fake', time: 1, part: { id: 'part-1', messageID: 'msg-1', type: 'text', text: 'Hello' } },
  }), 200);
  setTimeout(() => sseBroadcast({
    type: 'message.part.updated',
    properties: { sessionID: 'sess-fake', time: 2, part: { id: 'part-1', messageID: 'msg-1', type: 'text', text: 'Hello from fake agent' } },
  }), 350);
  setTimeout(() => sseBroadcast({
    type: 'message.part.updated',
    properties: {
      sessionID: 'sess-fake',
      time: 3,
      part: {
        id: 'part-2',
        messageID: 'msg-1',
        type: 'tool',
        callID: 'call-1',
        tool: 'bash',
        state: { status: 'running', input: { command: 'echo hi' }, title: 'echo hi', time: { start: 1 } },
      },
    },
  }), 450);
  setTimeout(() => sseBroadcast({
    type: 'message.part.updated',
    properties: {
      sessionID: 'sess-fake',
      time: 4,
      part: {
        id: 'part-2',
        messageID: 'msg-1',
        type: 'tool',
        callID: 'call-1',
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: 'echo hi' },
          output: 'hi\n',
          title: 'echo hi',
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    },
  }), 550);
  setTimeout(() => sseBroadcast({
    type: 'message.updated',
    properties: { sessionID: 'sess-fake', info: { id: 'msg-1', role: 'assistant', time: { created: 1, completed: 2 } } },
  }), 650);
  setTimeout(() => sseBroadcast({
    type: 'permission.replied',
    properties: { sessionID: 'sess-fake', requestID: 'perm-1', reply: 'once' },
  }), 750);
}

const fakeServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${FAKE_PORT}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && (path === '/doc' || path === '/')) return sendJson(res, 200, { ok: true });
  if (method === 'POST' && path === '/session') return sendJson(res, 200, { id: 'sess-fake', directory: '/work' });
  if (method === 'GET' && path === '/session') return sendJson(res, 200, [{ id: 'sess-fake', directory: '/work' }]);
  if (method === 'POST' && path === '/session/sess-fake/prompt_async') {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      prompts.push(body);
      res.writeHead(204);
      res.end();
      runTurn();
    });
    return;
  }
  if (method === 'POST' && path === '/session/sess-fake/message') {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      prompts.push(body);
      sendJson(res, 200, { id: 'msg-1' });
      runTurn();
    });
    return;
  }
  if (method === 'POST' && path === '/session/sess-fake/abort') return sendJson(res, 200, {});
  if (method === 'POST' && path === '/session/sess-fake/permissions/perm-ok') return sendJson(res, 200, { ok: true });
  if (method === 'POST' && path === '/session/sess-fake/permissions/perm-missing') return sendJson(res, 404, {});
  if (method === 'GET' && path === '/session/sess-fake/diff') {
    // kilo Snapshot.FileDiff shape: {file, patch, ...}
    return sendJson(res, 200, [
      { file: 'a.txt', patch: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-hi\n+hello\n', additions: 1, deletions: 1, status: 'modified' },
    ]);
  }
  if (method === 'GET' && path === '/session/sess-fake/message') return sendJson(res, 200, []);
  if (method === 'GET' && path === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': hello\n\n');
    sseClients.add(res);
    res.on('close', () => sseClients.delete(res));
    return;
  }
  return sendJson(res, 404, { error: 'not found', path });
});

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`assert failed: ${label}`);
}

async function api<T>(method: string, path: string, body?: unknown, token = TOKEN): Promise<{ status: number; data: T | undefined }> {
  const res = await fetch(SHIM_URL + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
    },
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
  return { status: res.status, data };
}

const collected: AgentEvent[] = [];

async function startEventCollector(): Promise<void> {
  const res = await fetch(`${SHIM_URL}/events`, { headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' } });
  const body = res.body;
  if (!res.ok || body === null) throw new Error(`/events HTTP ${res.status}`);
  void (async () => {
    const reader = body.getReader();
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
        const data = chunk
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
        if (data.length > 0) {
          try {
            collected.push(JSON.parse(data) as AgentEvent);
          } catch {
            // ignore
          }
        }
      }
    }
  })();
}

async function waitFor(predicate: (event: AgentEvent) => boolean, label: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (collected.some(predicate)) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for "${label}"; events so far: ${collected.map((e) => e.type).join(', ')}`);
}

async function main(): Promise<void> {
  const workDir = await mkdtempSync(join(tmpdir(), 'pa-smoke-'));
  let shim: ChildProcess | undefined;

  try {
    await exec('git', ['-C', workDir, 'init', '-b', 'main']);
    await exec('git', ['-C', workDir, 'config', 'user.name', 'SmokeTest']);
    await exec('git', ['-C', workDir, 'config', 'user.email', 'smoke@test.local']);
    writeFileSync(join(workDir, 'a.txt'), 'hi\n');
    writeFileSync(join(workDir, 'README.md'), '# smoke\n');
    await exec('git', ['-C', workDir, 'add', '-A']);
    await exec('git', ['-C', workDir, 'commit', '-m', 'init']);

    await new Promise<void>((resolve) => fakeServer.listen(FAKE_PORT, '127.0.0.1', resolve));
    console.log(`[smoke] fake opencode on :${FAKE_PORT}, work dir ${workDir}`);

    const shimProc = spawn(
      process.execPath,
      [tsxCli, 'src/index.ts'],
      {
        cwd: root,
        env: {
          ...process.env,
          SHIM_TOKEN: TOKEN,
          WORK_DIR: workDir,
          AGENT_MODE: 'yolo',
          ADAPTER: 'kilo',
          SESSION_ID: 'smoke-sess',
          REPO_URL: '',
          REPO_FULL_NAME: 'acme/demo',
          AUTO_PUSH: '0',
          OPENCODE_SPAWN: '0',
          OPENCODE_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
          PORT: String(SHIM_PORT),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    shim = shimProc;
    const shimOutput: string[] = [];
    shimProc.stdout?.on('data', (chunk: Buffer) => shimOutput.push(chunk.toString()));
    shimProc.stderr?.on('data', (chunk: Buffer) => shimOutput.push(chunk.toString()));
    shimProc.on('exit', (code) => {
      if (code !== null && code !== 0) console.error(`[smoke] shim exited early (${code}):\n${shimOutput.join('')}`);
    });

    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try {
        const res = await fetch(`${SHIM_URL}/health`);
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {
        // retry
      }
      await sleep(500);
    }
    assert(healthy, `shim healthy on :${SHIM_PORT} (output: ${shimOutput.join('').slice(-2000)})`);

    // auth: every route except /health requires the bearer token
    const noToken = await api<unknown>('GET', '/status', undefined, '');
    assert(noToken.status === 401, 'GET /status without token -> 401');
    const badToken = await api<unknown>('GET', '/status', undefined, 'wrong');
    assert(badToken.status === 401, 'GET /status with wrong token -> 401');
    const health = await fetch(`${SHIM_URL}/health`);
    assert(health.ok, 'GET /health without token -> 200');

    const status = await api<ShimStatus>('GET', '/status');
    assert(status.status === 200 && status.data !== undefined, 'GET /status -> 200');
    assert(status.data?.adapter === 'kilo', 'status.adapter === kilo');
    assert(status.data?.mode === 'yolo', 'status.mode === yolo');
    assert(status.data?.sessionRef === 'sess-fake', 'status.sessionRef === sess-fake');
    assert(status.data?.busy === false, 'status.busy === false');

    await startEventCollector();
    await sleep(300);

    const prompt = await api<{ ok: boolean }>('POST', '/prompt', { text: 'say hi' });
    assert(prompt.status === 200 && prompt.data?.ok === true, 'POST /prompt -> {ok:true}');
    assert(prompts.length === 1 && prompts[0] !== undefined && prompts[0].includes('say hi'), 'prompt forwarded to opencode');

    await waitFor((e) => e.type === 'permission.request', 'permission.request');
    const permReq = collected.find((e): e is Extract<AgentEvent, { type: 'permission.request' }> => e.type === 'permission.request');
    assert(permReq !== undefined && permReq.kind === 'bash', 'permission.request kind bash');
    assert(permReq?.permissionId === 'perm-1', 'permission.request id');

    const permOk = await api<{ ok: boolean }>('POST', '/permissions/perm-ok', { response: 'once' });
    assert(permOk.status === 200 && permOk.data?.ok === true, 'POST /permissions/perm-ok -> ok');
    const permMissing = await api<{ ok: boolean }>('POST', '/permissions/perm-missing', { response: 'once' });
    assert(permMissing.status === 200 && permMissing.data?.ok === true, 'POST /permissions/perm-missing -> ok (warning path)');
    await waitFor((e) => e.type === 'error' && e.message.startsWith('warning:'), 'warning event for unavailable permission route');

    await waitFor((e) => e.type === 'message.delta', 'message.delta');
    await waitFor((e) => e.type === 'tool.call', 'tool.call');
    const toolCall = collected.find((e): e is Extract<AgentEvent, { type: 'tool.call' }> => e.type === 'tool.call');
    assert(toolCall?.tool === 'bash', 'tool.call tool bash');
    await waitFor((e) => e.type === 'tool.result', 'tool.result');
    await waitFor((e) => e.type === 'message.completed', 'message.completed');
    const completed = collected.find((e): e is Extract<AgentEvent, { type: 'message.completed' }> => e.type === 'message.completed');
    assert(completed?.text === 'Hello from fake agent', 'message.completed text');
    await waitFor((e) => e.type === 'permission.resolved', 'permission.resolved');
    await waitFor((e) => e.type === 'turn.completed', 'turn.completed');
    const turn = collected.find((e): e is Extract<AgentEvent, { type: 'turn.completed' }> => e.type === 'turn.completed');
    assert(typeof turn?.commitSha === 'string' && (turn?.commitSha ?? '').length > 0, 'turn.completed commitSha');

    const gitLog = await exec('git', ['-C', workDir, 'log', '-1', '--pretty=%s']);
    assert(gitLog.stdout.startsWith('agent: turn '), `auto-commit on branch (${gitLog.stdout.trim()})`);
    const branch = await exec('git', ['-C', workDir, 'branch', '--show-current']);
    assert(branch.stdout.trim() === 'agent/smoke-sess', 'branch agent/smoke-sess');

    const diff = await api<DiffEntry[]>('GET', '/diff');
    assert(diff.status === 200 && Array.isArray(diff.data), 'GET /diff -> 200 array');
    assert(diff.data?.[0]?.path === 'a.txt', 'diff[0].path');
    assert((diff.data?.[0]?.patch ?? '').includes('@@'), 'diff[0].patch');

    const abort = await api<{ ok: boolean }>('POST', '/abort', {});
    assert(abort.status === 200 && abort.data?.ok === true, 'POST /abort -> ok');

    const resume = await api<{ ok: boolean }>('POST', '/resume', { sessionRef: 'sess-fake' });
    assert(resume.status === 200 && resume.data?.ok === true, 'POST /resume -> ok');
    const statusAfter = await api<ShimStatus>('GET', '/status');
    assert(statusAfter.data?.sessionRef === 'sess-fake', 'sessionRef preserved after resume');

    assert(!collected.some((e) => e.type === 'pushed'), 'no pushed event with AUTO_PUSH=0');
    assert(collected.some((e) => e.type === 'status'), 'status event received');

    console.log('SMOKE OK');
  } finally {
    shim?.kill('SIGTERM');
    fakeServer.close();
    await sleep(200);
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
    console.error('SMOKE FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
