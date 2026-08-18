import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import http, { type IncomingMessage } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import type { AgentEvent } from '@pocketagent/protocol';
import { installEnvProxyDispatcher } from '@pocketagent/protocol';
import { EventBroadcaster } from '../src/events';
import { askpassEnv, commitTurn, ensureRepo, pushBranch, readGithubPat, type GitContext } from '../src/gitops';
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

/**
 * Open a fresh SSE connection (optionally with a Last-Event-ID header, as the
 * orchestrator sends on a reconnect), collect the AgentEvents that arrive for
 * `ms`, then close. Used to prove the ring buffer replays a reconnect gap.
 */
function collectSse(base: string, token: string, lastEventId: number | undefined, ms: number): Promise<AgentEvent[]> {
  return new Promise(resolve => {
    const events: AgentEvent[] = [];
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (lastEventId !== undefined) headers['last-event-id'] = String(lastEventId);
    const req = http.get(`${base}/events`, { headers }, (res: IncomingMessage) => {
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
    });
    req.on('error', () => resolve(events));
    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, ms);
  });
}

/**
 * The egress-proxy contract of src/proxy.ts, checked against a real listener
 * instead of a mock: a session under policy 'allowlist' sits on an internal
 * docker network, so a provider call that ignores HTTPS_PROXY never leaves the
 * container and dies as "Connection error." with nothing in the proxy log.
 *
 * Asserted here: nothing is installed without proxy variables (policy 'open'
 * keeps talking directly), an https call is tunnelled through the proxy once
 * the dispatcher is in place, NO_PROXY still gets loopback out of the way, and
 * the reported proxy carries no credentials.
 */
async function checkEgressProxyDispatcher(): Promise<void> {
  const seen: string[] = [];
  const proxy = http.createServer((req, res) => {
    seen.push(`FORWARD ${req.url ?? ''}`);
    res.writeHead(204).end();
  });
  // https goes out as a CONNECT tunnel; answering with a closed socket is
  // enough - the request line is the evidence, the response is not.
  proxy.on('connect', (req: IncomingMessage, socket: { end(): void }) => {
    seen.push(`CONNECT ${req.url ?? ''}`);
    socket.end();
  });
  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('local');
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as AddressInfo).port;
  const originPort = (origin.address() as AddressInfo).port;
  const token = 'smoke-shim-token';
  const proxyUrl = `http://pa:${token}@127.0.0.1:${proxyPort}`;

  let installs = 0;
  const withoutProxy = installEnvProxyDispatcher({ PATH: '/usr/bin' }, () => {
    installs += 1;
  });
  expect(withoutProxy === undefined && installs === 0, 'without proxy variables no dispatcher is installed');

  // Both spellings are set (and restored): EnvHttpProxyAgent reads the
  // lowercase ones first, and a developer machine may well have them pointing
  // somewhere else entirely.
  const proxyKeys = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];
  const dispatcherBefore = getGlobalDispatcher();
  const envBefore = { ...process.env };
  try {
    process.env.HTTP_PROXY = proxyUrl;
    process.env.http_proxy = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.https_proxy = proxyUrl;
    process.env.NO_PROXY = 'localhost,127.0.0.1';
    process.env.no_proxy = 'localhost,127.0.0.1';
    const active = installEnvProxyDispatcher(process.env, () => {
      setGlobalDispatcher(new EnvHttpProxyAgent());
    });
    expect(active !== undefined, 'a configured proxy is installed');
    expect(active?.includes(token) === false, 'the reported proxy URL carries no credentials');

    await fetch('https://api.provider.test/v1/models', { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
    expect(
      seen.includes('CONNECT api.provider.test:443'),
      `an https provider call reaches the proxy instead of DNS (saw ${JSON.stringify(seen)})`,
    );

    seen.length = 0;
    const local = await fetch(`http://127.0.0.1:${originPort}/health`, { signal: AbortSignal.timeout(5_000) });
    expect(local.status === 200 && seen.length === 0, 'NO_PROXY keeps loopback traffic off the proxy');
  } finally {
    setGlobalDispatcher(dispatcherBefore);
    for (const key of proxyKeys) {
      const before = envBefore[key];
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
  }

  seen.length = 0;
  await fetch('https://api.provider.test/v1/models', { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  expect(seen.length === 0, 'with the dispatcher gone nothing is routed through the proxy any more');

  // Sockets the fetches above left in the pool would keep close() waiting.
  proxy.closeAllConnections();
  origin.closeAllConnections();
  await new Promise<void>(resolve => proxy.close(() => resolve()));
  await new Promise<void>(resolve => origin.close(() => resolve()));
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

  // --- Ringpuffer + Last-Event-ID replay (Event-Verlust-Fix) ---
  // Every sequenced event is buffered, so a reconnect that presents the last
  // seq it saw is replayed exactly the events after it - no turn.completed lost
  // in a gap. A fresh connection (no Last-Event-ID) replays no history.
  // Settle first so the post-turn status event is counted before we snapshot.
  await new Promise(resolve => setTimeout(resolve, 150));
  const lastId = bus.lastId;
  expect(lastId >= 3, `the shim has sequenced several events by now (lastId=${lastId})`);
  const from = Math.max(0, lastId - 3);
  const replayed = (await collectSse(base, config.token, from, 800)).filter(e => e.type !== 'ping');
  expect(replayed.length === lastId - from, `Last-Event-ID replays exactly the buffered tail (${lastId - from} events, got ${replayed.length})`);
  expect(
    replayed.every(e => typeof (e as { seq?: number }).seq === 'number' && (e as { seq: number }).seq > from),
    'every replayed event carries a seq greater than the Last-Event-ID',
  );
  const fresh = (await collectSse(base, config.token, undefined, 500)).filter(e => e.type !== 'ping');
  expect(fresh.length === 0, 'a fresh connection without Last-Event-ID replays no history');
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

  // --- provider without model -> the adapter default, not a 400 ---
  // Das ist die Form, die der Server im Normalbetrieb schickt: die App setzt
  // immer einen Provider (den Zugang) und lässt das Modell leer, wenn der
  // Nutzer "Standard des Agenten" stehen lässt. Die bisherigen Fälle prüften
  // nur "beides gesetzt" und "beides leer" — dazwischen lief der Prompt in
  // ein hartes 400 und die Session starb an ihrem ersten Auftrag.
  const defaultModel = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ text: 'hi', mode: 'ask', provider: 'openai', model: '' }),
  });
  expect(
    defaultModel.status !== 400,
    `provider with empty model must not be rejected, got ${defaultModel.status}`,
  );
  // Dieser Prompt wird angenommen — er startet also einen echten Turn, nicht
  // nur eine Validierung. Wird er nicht abgewartet, erfüllt sein
  // `turn.completed` weiter unten das Prädikat für `completed2` (alles außer
  // `completed1`). Die Runde danach gilt dann als fertig, obwohl sie noch
  // läuft, und der nächste Prompt läuft in das 409 aus `POST /prompt`
  // ("prompt already running"). Genau daran ist die Abbruch-Zusicherung auf
  // ausgelasteten CI-Runnern gescheitert, während sie lokal durchlief: dort
  // war der Turn zufällig schon vor der nächsten Runde fertig.
  const completedDefault = await waitFor(
    () => sse.events,
    event => event.type === 'turn.completed' && event !== completed1,
    5_000,
    'turn.completed for the empty-model prompt',
  );

  // --- model without provider stays an error ---
  // Umgekehrt bliebe das Modell unten wirkungslos liegen; das darf nicht
  // still durchgehen.
  const modelOnly = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ text: 'hi', model: 'some-model' }),
  });
  expect(modelOnly.status === 400, `model without provider -> 400, got ${modelOnly.status}`);

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
    event => event.type === 'turn.completed' && event !== completed1 && event !== completedDefault,
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

  // --- credentials: readGithubPat (creds file -> GITHUB_PAT env fallback) ---
  const testPat = 'smoke-pat-never-leak-0123456789abcdef';
  const credsDir = await mkdtemp(join(tmpdir(), 'pi-shim-smoke-creds-'));
  const credsFile = join(credsDir, 'creds.json');
  const savedCredsFile = process.env.PA_CREDS_FILE;
  const savedEnvPat = process.env.GITHUB_PAT;
  try {
    await writeFile(credsFile, JSON.stringify({ githubPat: testPat }), 'utf8');
    process.env.PA_CREDS_FILE = credsFile;
    delete process.env.GITHUB_PAT;
    expect(readGithubPat() === testPat, 'readGithubPat reads githubPat from creds file');

    process.env.GITHUB_PAT = 'env-fallback-pat';
    expect(readGithubPat() === testPat, 'creds file wins over GITHUB_PAT env');

    await writeFile(credsFile, '{not valid json', 'utf8');
    expect(readGithubPat() === 'env-fallback-pat', 'malformed creds file falls back to env');

    process.env.PA_CREDS_FILE = join(credsDir, 'missing.json');
    delete process.env.GITHUB_PAT;
    expect(readGithubPat() === undefined, 'missing creds file + no env -> undefined');

    process.env.PA_CREDS_FILE = credsFile;
    await writeFile(credsFile, JSON.stringify({ other: 'nope' }), 'utf8');
    expect(readGithubPat() === undefined, 'creds file without githubPat -> undefined');
  } finally {
    if (savedCredsFile === undefined) delete process.env.PA_CREDS_FILE;
    else process.env.PA_CREDS_FILE = savedCredsFile;
    if (savedEnvPat === undefined) delete process.env.GITHUB_PAT;
    else process.env.GITHUB_PAT = savedEnvPat;
  }

  // --- askpass helper: PAT never in the script, env wired correctly ---
  expect(askpassEnv(undefined) === undefined, 'askpassEnv is undefined without a PAT');
  const askpass = askpassEnv(testPat);
  const helperPath = askpass?.GIT_ASKPASS;
  expect(typeof helperPath === 'string', 'askpassEnv sets GIT_ASKPASS');
  const helperBody = await readFile(helperPath as string, 'utf8');
  expect(!helperBody.includes(testPat), 'askpass script must not contain the PAT literal');
  expect(helperBody.includes('x-access-token'), 'askpass script answers the username prompt');
  expect(helperBody.includes('PA_GIT_PAT'), 'askpass script reads PA_GIT_PAT');
  const helperStat = await stat(helperPath as string);
  expect((helperStat.mode & 0o777) === 0o700, `askpass script mode is 0700 (got ${helperStat.mode.toString(8)})`);
  expect(askpass?.PA_GIT_PAT === testPat, 'askpassEnv carries the PAT via PA_GIT_PAT');
  expect(askpass?.GIT_TERMINAL_PROMPT === '0', 'askpassEnv disables terminal prompts');
  expect(askpass?.HOME === process.env.HOME, 'askpassEnv preserves HOME for child processes');
  expect(askpass?.XDG_CONFIG_HOME === process.env.XDG_CONFIG_HOME, 'askpassEnv preserves XDG_CONFIG_HOME');
  await rm(helperPath as string, { force: true });

  // --- local git end-to-end: clone + push over file:// with askpass flow ---
  let gitAvailable = true;
  try {
    await exec('git', ['--version']);
  } catch {
    gitAvailable = false;
    console.log('SKIP: git binary not available; skipping credential e2e checks');
  }
  if (gitAvailable) {
    const e2eRoot = await mkdtemp(join(tmpdir(), 'pi-shim-smoke-e2e-'));
    try {
      const upstream = join(e2eRoot, 'upstream');
      const origin = join(e2eRoot, 'origin.git');
      await exec('git', ['init', '-b', 'main', upstream]);
      await exec('git', ['config', 'user.name', 'Smoke Test'], { cwd: upstream });
      await exec('git', ['config', 'user.email', 'smoke@test.local'], { cwd: upstream });
      await writeFile(join(upstream, 'README.md'), '# e2e origin\n', 'utf8');
      await exec('git', ['add', '-A'], { cwd: upstream });
      await exec('git', ['commit', '-m', 'init', '--no-verify'], { cwd: upstream });
      await exec('git', ['clone', '--bare', upstream, origin]);

      const workDir2 = join(e2eRoot, 'clone');
      const ctx: GitContext = {
        workDir: workDir2,
        sessionId: 'smoke-e2e',
        repoUrl: `file://${origin}`,
        githubPat: testPat,
      };
      const e2eBranch = await ensureRepo(ctx);
      expect(e2eBranch === 'agent/smoke-e2e', 'ensureRepo clones and creates the agent branch');
      await writeFile(join(workDir2, 'note.txt'), 'e2e\n', 'utf8');
      const sha = await commitTurn(ctx, new Date().toISOString());
      expect(sha.length > 0, 'commitTurn commits on the clone');
      await pushBranch(ctx, e2eBranch);

      const gitConfig = await readFile(join(workDir2, '.git', 'config'), 'utf8');
      expect(!gitConfig.includes(testPat), '.git/config must not contain the PAT');
      expect(gitConfig.includes('file://'), 'remote recorded as a plain URL');
      const remoteBranches = await exec('git', ['branch', '--list', 'agent/smoke-e2e'], { cwd: origin });
      expect(remoteBranches.stdout.trim().length > 0, 'branch pushed to the file:// remote');
    } finally {
      await rm(e2eRoot, { recursive: true, force: true });
    }
  }

  await rm(workDir, { recursive: true, force: true });
  await rm(agentDir, { recursive: true, force: true });
  await rm(credsDir, { recursive: true, force: true });

  // Last, because it swaps the process-wide dispatcher for the duration.
  await checkEgressProxyDispatcher();

  console.log('SMOKE OK');
}

main().catch(error => {
  console.error('SMOKE FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
