/**
 * Smoke test without a real opencode runtime: starts a canned fake opencode
 * HTTP/SSE server plus the shim against a throwaway git repo, exercises the
 * whole shim API and asserts normalized events. Prints "SMOKE OK" on success.
 */
import { spawn, execFile as execFileCb, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AgentEvent, DiffEntry, ShimStatus } from '@pocketagent/protocol';
import { askpassEnv, ensureRepo, git as gitRun, readGithubPat } from './src/gitops';

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

/** PAT resolution contract: PA_CREDS_FILE JSON .githubPat with GITHUB_PAT fallback. */
async function credentialChecks(): Promise<void> {
  const credsDir = mkdtempSync(join(tmpdir(), 'pa-creds-'));
  const credsFile = join(credsDir, 'creds.json');
  writeFileSync(credsFile, JSON.stringify({ githubPat: 'pat-from-creds-file' }));
  const savedFile = process.env.PA_CREDS_FILE;
  const savedPat = process.env.GITHUB_PAT;
  try {
    delete process.env.GITHUB_PAT;
    process.env.PA_CREDS_FILE = credsFile;
    assert(readGithubPat() === 'pat-from-creds-file', 'readGithubPat reads githubPat from PA_CREDS_FILE');
    writeFileSync(credsFile, '{ this is not json');
    assert(readGithubPat() === undefined, 'readGithubPat tolerant of malformed creds file (no env fallback set)');
    process.env.GITHUB_PAT = 'pat-from-env';
    assert(readGithubPat() === 'pat-from-env', 'readGithubPat falls back to GITHUB_PAT on bad creds file');
    delete process.env.PA_CREDS_FILE;
    assert(readGithubPat() === 'pat-from-env', 'readGithubPat uses GITHUB_PAT when no creds file is set');
    delete process.env.GITHUB_PAT;
    assert(readGithubPat() === undefined, 'readGithubPat returns undefined when nothing is configured');
  } finally {
    if (savedFile === undefined) delete process.env.PA_CREDS_FILE;
    else process.env.PA_CREDS_FILE = savedFile;
    if (savedPat === undefined) delete process.env.GITHUB_PAT;
    else process.env.GITHUB_PAT = savedPat;
    rmSync(credsDir, { recursive: true, force: true });
  }

  const pat = 'ghp_smoke_askpass_secret_literal';
  const env = askpassEnv(pat);
  if (env === undefined) throw new Error('assert failed: askpassEnv returns env for a pat');
  const scriptPath = env.GIT_ASKPASS;
  if (typeof scriptPath !== 'string' || scriptPath.length === 0) throw new Error('assert failed: askpassEnv sets GIT_ASKPASS');
  const script = readFileSync(scriptPath, 'utf8');
  assert(!script.includes(pat), 'askpass script must not contain the PAT literal');
  assert(script.includes('x-access-token'), 'askpass script answers Username prompts with x-access-token');
  assert(script.includes('PA_GIT_PAT'), 'askpass script reads the PAT from PA_GIT_PAT env, not inline');
  assert((statSync(scriptPath).mode & 0o777) === 0o700, 'askpass script has mode 0700');
  assert(env.PA_GIT_PAT === pat, 'askpassEnv passes the PAT via PA_GIT_PAT');
  assert(env.GIT_TERMINAL_PROMPT === '0', 'askpassEnv disables git terminal prompts');
  rmSync(scriptPath, { force: true });
  assert(askpassEnv(undefined) === undefined, 'askpassEnv returns undefined without a pat');
  console.log('[smoke] credential checks ok');
}

/** Local git end-to-end: bare repo + clone, push via plain URL + askpass; no PAT in .git/config. */
async function gitEndToEnd(): Promise<void> {
  try {
    await exec('git', ['--version']);
  } catch {
    console.log('SKIP git end-to-end: git binary not available');
    return;
  }
  const base = mkdtempSync(join(tmpdir(), 'pa-git-e2e-'));
  const pat = 'ghp_smoke_e2e_secret';
  try {
    const bare = join(base, 'remote.git');
    const remote = `file://${bare}`;
    const seed = join(base, 'seed');
    await exec('git', ['init', '--bare', '-b', 'main', bare]);
    await exec('git', ['init', '-b', 'main', seed]);
    await exec('git', ['-C', seed, 'config', 'user.name', 'SmokeTest']);
    await exec('git', ['-C', seed, 'config', 'user.email', 'smoke@test.local']);
    writeFileSync(join(seed, 'README.md'), '# seed\n');
    await exec('git', ['-C', seed, 'add', '-A']);
    await exec('git', ['-C', seed, 'commit', '-m', 'init']);
    await exec('git', ['-C', seed, 'push', remote, 'HEAD:refs/heads/main']);

    // clone through the shim code path: plain URL + askpass env, PAT supplied
    const work = join(base, 'clone');
    await ensureRepo({ workDir: work, repoUrl: remote, sessionId: 'smoke-git', githubPat: pat });
    writeFileSync(join(work, 'change.txt'), 'change\n');
    await exec('git', ['-C', work, 'add', '-A']);
    await exec('git', ['-C', work, 'commit', '-m', 'change']);
    const askpass = askpassEnv(pat);
    if (askpass === undefined) throw new Error('assert failed: askpass env for e2e push');
    await gitRun(work, ['push', remote, 'HEAD:refs/heads/agent/smoke-git'], askpass);

    const cfg = readFileSync(join(work, '.git', 'config'), 'utf8');
    assert(!cfg.includes(pat), 'no PAT in .git/config after clone+push');
    assert(!cfg.includes('x-access-token'), 'no embedded credentials in .git/config');
    const head = await exec('git', ['-C', bare, 'rev-parse', '--verify', 'refs/heads/agent/smoke-git']);
    assert(head.stdout.trim().length > 0, 'pushed branch exists on the bare remote');
    rmSync(askpass.GIT_ASKPASS ?? '', { force: true });
    console.log('[smoke] git end-to-end (plain URL + askpass) ok');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const workDir = await mkdtempSync(join(tmpdir(), 'pa-smoke-'));
  let shim: ChildProcess | undefined;

  try {
    await credentialChecks();
    await gitEndToEnd();

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
