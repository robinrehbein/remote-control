import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import http, { type IncomingMessage } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentEvent } from '@pocketagent/protocol';
import { EventBroadcaster } from '../src/events';
import { buildApp, loadConfig } from '../src/index';
import { FakeJunieRunner } from '../src/junie';
import { askpassEnv, commitTurn, ensureRepo, pushBranch, readGithubPat, type GitContext } from '../src/gitops';

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
  const workDir = await mkdtemp(join(tmpdir(), 'junie-shim-smoke-work-'));

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
  process.env.ADAPTER = 'junie';
  process.env.AUTO_PUSH = '0';
  process.env.JUNIE_HEARTBEAT_MS = '300';

  const config = loadConfig(process.env);
  const bus = new EventBroadcaster();
  bus.startHeartbeat(config.heartbeatMs);
  const runner = new FakeJunieRunner({
    workDir,
    mode: config.mode,
    emit: event => bus.publish(event),
    hangMarker: 'hang',
  });
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
  expect(status0.adapter === 'junie', '/status adapter is junie');
  expect(status0.busy === false, '/status initially idle');
  expect(status0.mode === 'yolo', '/status mode from env');

  const sse = openSse(base, config.token);
  await sse.connected;

  // --- turn 1: ask mode emits the documented no-approvals warning once, still runs ---
  const prompt1Body = (await (await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      text: 'write the hello file',
      mode: 'ask',
      provider: 'openai',
      model: 'fake-model',
    }),
  })).json()) as { ok?: boolean };
  expect(prompt1Body.ok === true, 'POST /prompt accepted');

  await waitFor(() => sse.events, event => event.type === 'status' && event.busy === true, 5_000, 'busy status');
  const warning = await waitFor(
    () => sse.events,
    event => event.type === 'error' && event.message.includes('keine Remote-Approvals'),
    5_000,
    'no-approvals warning event',
  );
  expect(warning.type === 'error' && warning.message.includes('ohne Gates'), 'warning mentions missing gates');
  expect(
    sse.events.filter(event => event.type === 'error' && event.message.includes('keine Remote-Approvals')).length === 1,
    'exactly one no-approvals warning per turn',
  );
  expect(
    sse.events.some(event => event.type === 'message.delta' && event.delta.includes('starting work')),
    'plain stdout line forwarded as message.delta',
  );
  expect(
    sse.events.some(event => event.type === 'message.delta' && event.delta.includes('writing hello.txt')),
    'JSON stdout line text extracted as message.delta',
  );

  const completed1 = await waitFor(
    () => sse.events,
    event => event.type === 'turn.completed',
    5_000,
    'turn.completed',
  );
  expect(completed1.type === 'turn.completed' && typeof completed1.commitSha === 'string', 'turn.completed has commitSha');
  expect(
    completed1.type === 'turn.completed' &&
      completed1.usage !== undefined && completed1.usage.input === 120 && completed1.usage.output === 64,
    'turn.completed carries usage from junie output file',
  );
  expect(
    sse.events.some(event => event.type === 'message.completed' && event.text.includes('hello.txt')),
    'message.completed final text from output file',
  );

  const hello = await readFile(join(workDir, 'hello.txt'), 'utf8');
  expect(hello === 'hello fake junie\n', 'fake run wrote hello.txt');
  const log = await exec('git', ['log', '--oneline'], { cwd: workDir });
  expect(log.stdout.includes('agent: turn'), 'auto-commit created');

  const status1 = (await (await fetch(`${base}/status`, { headers: auth })).json()) as {
    busy: boolean;
    provider?: string;
    model?: string;
  };
  expect(status1.busy === false, 'idle again after turn');
  expect(status1.provider === 'openai', '/status provider from prompt override');
  expect(status1.model === 'fake-model', '/status model from prompt override');

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

  // --- abort flow (fake runner hangs until abort) ---
  const prompt3 = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ text: 'hang the turn' }),
  });
  expect(prompt3.status === 200, 'hang prompt accepted');
  await waitFor(() => sse.events, event => event.type === 'status' && event.busy === true, 5_000, 'busy before abort');
  const abort = await fetch(`${base}/abort`, { method: 'POST', headers: auth });
  expect(abort.status === 200, `POST /abort accepted (got ${abort.status}: ${await abort.text()})`);
  const failed = await waitFor(
    () => sse.events,
    event => event.type === 'turn.failed' && event.error === 'aborted',
    5_000,
    'turn.failed aborted',
  );
  expect(failed.type === 'turn.failed', 'abort produced turn.failed');
  const statusAbort = (await (await fetch(`${base}/status`, { headers: auth })).json()) as { busy: boolean };
  expect(statusAbort.busy === false, 'idle again after abort');

  // --- permissions: acknowledged with a warning, never blocking ---
  const badPermission = await fetch(`${base}/permissions/perm-1`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ response: 'nope' }),
  });
  expect(badPermission.status === 400, 'invalid permission response -> 400');
  const permission = await fetch(`${base}/permissions/perm-1`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ response: 'once' }),
  });
  expect(permission.status === 200, 'POST /permissions/:id -> 200');
  expect(((await permission.json()) as { ok?: boolean }).ok === true, 'POST /permissions/:id ok envelope');
  await waitFor(
    () => sse.events,
    event => event.type === 'error' && event.message.includes('nicht unterstützt'),
    5_000,
    'permission reply warning event',
  );

  // --- resume: degraded no-op, ref surfaced via /status ---
  const resume = await fetch(`${base}/resume`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ sessionRef: 'junie-session-abc' }),
  });
  expect(resume.status === 200, 'POST /resume accepted');
  const statusResume = (await (await fetch(`${base}/status`, { headers: auth })).json()) as {
    sessionRef?: string;
  };
  expect(statusResume.sessionRef === 'junie-session-abc', '/status reflects stored sessionRef');

  // --- heartbeat ---
  await waitFor(() => sse.events, event => event.type === 'ping', 5_000, 'SSE heartbeat ping');

  // --- readGithubPat: PA_CREDS_FILE creds.json with GITHUB_PAT fallback ---
  {
    const prevCredsFile = process.env.PA_CREDS_FILE;
    const prevPat = process.env.GITHUB_PAT;
    const credsDir = await mkdtemp(join(tmpdir(), 'junie-shim-smoke-creds-'));
    try {
      const credsFile = join(credsDir, 'creds.json');
      await writeFile(credsFile, JSON.stringify({ githubPat: 'pat-from-file-123' }), 'utf8');
      process.env.PA_CREDS_FILE = credsFile;
      process.env.GITHUB_PAT = 'pat-from-env-456';
      expect(readGithubPat() === 'pat-from-file-123', 'readGithubPat prefers PA_CREDS_FILE over GITHUB_PAT');

      process.env.PA_CREDS_FILE = join(credsDir, 'missing.json');
      expect(readGithubPat() === 'pat-from-env-456', 'readGithubPat falls back to GITHUB_PAT when file missing');

      await writeFile(credsFile, '{not json', 'utf8');
      process.env.PA_CREDS_FILE = credsFile;
      expect(readGithubPat() === 'pat-from-env-456', 'readGithubPat tolerates a malformed creds file');

      delete process.env.GITHUB_PAT;
      expect(readGithubPat() === undefined, 'readGithubPat is undefined without any source');
    } finally {
      if (prevCredsFile === undefined) delete process.env.PA_CREDS_FILE;
      else process.env.PA_CREDS_FILE = prevCredsFile;
      if (prevPat === undefined) delete process.env.GITHUB_PAT;
      else process.env.GITHUB_PAT = prevPat;
      await rm(credsDir, { recursive: true, force: true });
    }
  }

  // --- askpass helper: PAT lives in env, never inside the script ---
  const askpassScriptPath = join(tmpdir(), `pocketagent-askpass-${process.pid}.sh`);
  try {
    expect(askpassEnv(undefined) === undefined, 'askpassEnv returns undefined without a PAT');
    const askpass = askpassEnv('askpass-pat-xyz-987');
    expect(askpass !== undefined, 'askpassEnv returns an env object for a PAT');
    expect(typeof askpass?.GIT_ASKPASS === 'string', 'askpassEnv sets GIT_ASKPASS');
    expect(askpass?.GIT_TERMINAL_PROMPT === '0', 'askpassEnv disables terminal prompts');
    expect(askpass?.PA_GIT_PAT === 'askpass-pat-xyz-987', 'askpassEnv passes the PAT via env var');
    const script = await readFile(askpassScriptPath, 'utf8');
    expect(script.includes('x-access-token'), 'askpass script answers username prompts');
    expect(script.includes('$PA_GIT_PAT'), 'askpass script reads the PAT from the environment');
    expect(!script.includes('askpass-pat-xyz-987'), 'askpass script contains no PAT literal');
    const mode = (await stat(askpassScriptPath)).mode & 0o777;
    expect(mode === 0o700, `askpass script mode is 0700, got ${mode.toString(8)}`);
  } finally {
    await rm(askpassScriptPath, { force: true });
  }

  // --- local git end-to-end: clone + push via plain URL + askpass helper ---
  let gitAvailable = true;
  try {
    await exec('git', ['--version']);
  } catch {
    gitAvailable = false;
  }
  if (!gitAvailable) {
    console.log('SKIP: git binary not available for askpass push e2e test');
  } else {
    const e2eDir = await mkdtemp(join(tmpdir(), 'junie-shim-smoke-git-'));
    try {
      // seed repo -> bare remote with one commit on main
      const seed = join(e2eDir, 'seed');
      const bare = join(e2eDir, 'origin.git');
      await exec('git', ['init', '-b', 'main', seed]);
      await exec('git', ['config', 'user.name', 'Smoke Test'], { cwd: seed });
      await exec('git', ['config', 'user.email', 'smoke@test.local'], { cwd: seed });
      await writeFile(join(seed, 'README.md'), '# e2e\n', 'utf8');
      await exec('git', ['add', '-A'], { cwd: seed });
      await exec('git', ['commit', '-m', 'init', '--no-verify'], { cwd: seed });
      await exec('git', ['init', '--bare', '-b', 'main', bare]);
      await exec('git', ['push', `file://${bare}`, 'main:main'], { cwd: seed });

      // new push path: plain file:// URL, PAT only via askpass env
      const ctx: GitContext = {
        workDir: join(e2eDir, 'clone'),
        sessionId: 'smoke-git',
        repoUrl: `file://${bare}`,
        repoBranch: 'main',
        githubPat: 'e2e-pat-321',
      };
      const pushedBranch = await ensureRepo(ctx);
      expect(pushedBranch === 'agent/smoke-git', 'ensureRepo clones and creates the agent branch');
      await writeFile(join(ctx.workDir, 'note.txt'), 'e2e\n', 'utf8');
      const sha = await commitTurn(ctx, new Date().toISOString());
      expect(typeof sha === 'string' && sha.length > 0, 'commitTurn produced a commit');
      await pushBranch(ctx, pushedBranch);

      const remoteSha = (await exec('git', ['rev-parse', `refs/heads/${pushedBranch}`], { cwd: bare })).stdout.trim();
      expect(remoteSha === sha, 'push reached the bare remote via plain URL + askpass');

      const cloneConfig = await readFile(join(ctx.workDir, '.git', 'config'), 'utf8');
      expect(!cloneConfig.includes('e2e-pat-321'), '.git/config contains no PAT');
      expect(!cloneConfig.includes('x-access-token:'), '.git/config contains no embedded credentials');
    } finally {
      await rm(e2eDir, { recursive: true, force: true });
      await rm(join(tmpdir(), `pocketagent-askpass-${process.pid}.sh`), { force: true });
    }
  }

  sse.close();
  await app.close();
  bus.stop();
  await rm(workDir, { recursive: true, force: true });

  console.log('SMOKE OK');
}

main().catch(error => {
  console.error('SMOKE FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
