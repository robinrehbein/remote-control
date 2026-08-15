/**
 * Smoke test without a real opencode runtime: starts a canned fake opencode
 * HTTP/SSE server plus the shim against a throwaway git repo, exercises the
 * whole shim API and asserts normalized events. Prints "SMOKE OK" on success.
 */
import { spawn, execFile as execFileCb, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AgentEvent, DiffEntry, ShimStatus } from '@pocketagent/protocol';
import { askpassEnv, pushAndDraftPR, readGithubPat } from './src/gitops.ts';

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

const assistantInfo = { sessionID: 'sess-fake', messageID: 'msg-1', role: 'assistant' };

function runTurn(): void {
  setTimeout(() => sseBroadcast({
    type: 'permission.ask',
    sessionID: 'sess-fake',
    messageID: 'msg-1',
    permissionID: 'perm-1',
    title: 'bash: echo hi',
    patterns: ['bash.echo *'],
    metadata: { type: 'bash', command: 'echo hi' },
  }), 100);
  setTimeout(() => sseBroadcast({ type: 'message.part.updated', info: assistantInfo, part: { id: 'part-1', type: 'text', text: 'Hello' } }), 200);
  setTimeout(() => sseBroadcast({ type: 'message.part.updated', info: assistantInfo, part: { id: 'part-1', type: 'text', text: 'Hello from fake agent' } }), 350);
  setTimeout(() => sseBroadcast({
    type: 'message.part.updated',
    info: assistantInfo,
    part: { id: 'part-2', type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'echo hi' }, title: 'echo hi' } },
  }), 450);
  setTimeout(() => sseBroadcast({
    type: 'message.part.updated',
    info: assistantInfo,
    part: { id: 'part-2', type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi\n', title: 'echo hi' } },
  }), 550);
  setTimeout(() => sseBroadcast({
    type: 'message.updated',
    info: { id: 'msg-1', sessionID: 'sess-fake', role: 'assistant', time: { start: 1, end: 2 } },
  }), 650);
  setTimeout(() => sseBroadcast({ type: 'permission.update', permissionID: 'perm-1', status: 'once' }), 750);
}

const fakeServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${FAKE_PORT}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && (path === '/doc' || path === '/')) return sendJson(res, 200, { ok: true });
  if (method === 'POST' && path === '/session') return sendJson(res, 200, { id: 'sess-fake', directory: '/work' });
  if (method === 'GET' && path === '/session') return sendJson(res, 200, [{ id: 'sess-fake', directory: '/work' }]);
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
    return sendJson(res, 200, [
      { path: 'a.txt', content: { type: 'patch', patch: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-hi\n+hello\n' } },
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

async function hasGit(): Promise<boolean> {
  try {
    await exec('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Credential-handling checks (no docker, no real credentials):
 *  - readGithubPat resolves the PAT from a temp PA_CREDS_FILE and falls back
 *    to GITHUB_PAT on missing/malformed creds files
 *  - askpassEnv writes an askpass script that contains no PAT literal
 *  - the new push path pushes to a file:// remote without ever embedding the
 *    PAT in a remote URL or .git/config
 */
async function credentialChecks(): Promise<void> {
  const prevCredsFile = process.env.PA_CREDS_FILE;
  const prevPat = process.env.GITHUB_PAT;

  // (a) readGithubPat: creds file, then env fallbacks
  const credsDir = mkdtempSync(join(tmpdir(), 'pa-creds-'));
  try {
    const credsFile = join(credsDir, 'creds.json');
    writeFileSync(credsFile, JSON.stringify({ githubPat: 'pat-from-creds-file' }));
    process.env.PA_CREDS_FILE = credsFile;
    delete process.env.GITHUB_PAT;
    assert(readGithubPat() === 'pat-from-creds-file', 'readGithubPat reads PA_CREDS_FILE');

    process.env.GITHUB_PAT = 'pat-from-env';
    writeFileSync(credsFile, '{ not json');
    assert(readGithubPat() === 'pat-from-env', 'readGithubPat falls back to GITHUB_PAT on bad JSON');
    process.env.PA_CREDS_FILE = join(credsDir, 'missing.json');
    assert(readGithubPat() === 'pat-from-env', 'readGithubPat falls back to GITHUB_PAT on missing file');
    delete process.env.GITHUB_PAT;
    assert(readGithubPat() === undefined, 'readGithubPat undefined without any source');
  } finally {
    if (prevCredsFile === undefined) delete process.env.PA_CREDS_FILE;
    else process.env.PA_CREDS_FILE = prevCredsFile;
    if (prevPat === undefined) delete process.env.GITHUB_PAT;
    else process.env.GITHUB_PAT = prevPat;
    rmSync(credsDir, { recursive: true, force: true });
  }

  // (b) askpassEnv: script must not contain the PAT, must echo $PA_GIT_PAT
  assert(askpassEnv(undefined) === undefined, 'askpassEnv(undefined) -> undefined');
  const pat = 'smoke-pat-never-leak';
  const env = askpassEnv(pat);
  assert(env !== undefined, 'askpassEnv(pat) returns env');
  const scriptPath = env?.GIT_ASKPASS;
  assert(typeof scriptPath === 'string' && scriptPath.length > 0, 'GIT_ASKPASS path set');
  const script = readFileSync(scriptPath as string, 'utf8');
  assert(!script.includes(pat), 'askpass script contains no PAT literal');
  assert(script.includes('"$PA_GIT_PAT"'), 'askpass script echoes $PA_GIT_PAT');
  assert(script.includes('x-access-token'), 'askpass script answers username');
  assert((statSync(scriptPath as string).mode & 0o777) === 0o700, 'askpass script mode 0700');
  assert(env?.PA_GIT_PAT === pat, 'PA_GIT_PAT env carries the PAT');
  assert(env?.GIT_TERMINAL_PROMPT === '0', 'GIT_TERMINAL_PROMPT=0');

  // (c) end-to-end push path against a local file:// remote
  if (!(await hasGit())) {
    console.log('SKIP: git binary not available for push-path check');
    return;
  }
  const gitDir = mkdtempSync(join(tmpdir(), 'pa-git-'));
  try {
    const bare = join(gitDir, 'remote.git');
    const clone = join(gitDir, 'clone');
    await exec('git', ['init', '--bare', '-b', 'main', bare]);
    await exec('git', ['clone', `file://${bare}`, clone]);
    await exec('git', ['-C', clone, 'config', 'user.name', 'SmokeTest']);
    await exec('git', ['-C', clone, 'config', 'user.email', 'smoke@test.local']);
    writeFileSync(join(clone, 'change.txt'), 'push me\n');
    await exec('git', ['-C', clone, 'add', '-A']);
    await exec('git', ['-C', clone, 'commit', '-m', 'init']);

    process.env.PA_CREDS_FILE = join(gitDir, 'missing-creds.json');
    process.env.GITHUB_PAT = pat;
    try {
      const outcome = await pushAndDraftPR({
        workDir: clone,
        repoUrl: `file://${bare}`,
        sessionId: 'push-check',
        repoFullName: '', // no GitHub API call from smoke
      });
      assert(outcome.ok, `push path ok (${outcome.ok ? '' : outcome.error})`);
      await exec('git', ['-C', bare, 'rev-parse', '--verify', 'refs/heads/agent/push-check']);
      const remoteUrl = await exec('git', ['-C', clone, 'config', '--get', 'remote.origin.url']);
      assert(!remoteUrl.stdout.includes(pat), 'remote.origin.url contains no PAT');
      const gitConfig = readFileSync(join(clone, '.git', 'config'), 'utf8');
      assert(!gitConfig.includes(pat), '.git/config contains no PAT');
    } finally {
      if (prevCredsFile === undefined) delete process.env.PA_CREDS_FILE;
      else process.env.PA_CREDS_FILE = prevCredsFile;
      if (prevPat === undefined) delete process.env.GITHUB_PAT;
      else process.env.GITHUB_PAT = prevPat;
    }
    console.log('[smoke] push-path check ok (file:// remote, no PAT in URLs/config)');
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await credentialChecks();
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
          ADAPTER: 'opencode',
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
    assert(status.data?.adapter === 'opencode', 'status.adapter === opencode');
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
