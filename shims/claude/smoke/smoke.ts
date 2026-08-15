/**
 * Smoke test for the claude shim. Runs the real fastify server + session
 * orchestration against a FakeRunner (no SDK, no credentials, no docker)
 * and a temp git repo. Verifies: SSE event normalization, permission flow
 * over /permissions/:id, auto-commit per turn, /diff, /status, auth
 * (constant-time bearer check), PAT credential handling (creds file,
 * askpass helper without embedded PAT) and the credential-free clone/push
 * path against a local file:// remote.
 */
import type { AgentEvent } from '@pocketagent/protocol';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { buildServer } from '../src/index.ts';
import { fakeRunnerFactory } from './fakerunner.ts';
import { askpassEnv, commitTurn, ensureRepo, pushAndCreatePr, readGithubPat } from '../src/gitops.ts';

const exec = promisify(execFile);

class SseClient {
  readonly events: AgentEvent[] = [];
  private readonly ctrl = new AbortController();

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async start(): Promise<void> {
    const res = await fetch(this.url, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: this.ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split('\n')) {
              if (line.startsWith('data: ')) {
                try {
                  this.events.push(JSON.parse(line.slice(6)) as AgentEvent);
                } catch {
                  /* skip malformed frame */
                }
              }
            }
          }
        }
      } catch {
        /* aborted */
      }
    })();
  }

  close(): void {
    this.ctrl.abort();
  }

  seen(pred: (e: AgentEvent) => boolean): boolean {
    return this.events.some(pred);
  }

  async wait(pred: (e: AgentEvent) => boolean, timeoutMs = 10_000): Promise<AgentEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find(pred);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `timeout waiting for event; got: ${this.events.map((e) => e.type).join(', ')}`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

async function waitUntil(pred: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function main(): Promise<void> {
  try {
    await exec('git', ['--version']);
  } catch {
    console.log('SKIP: git binary not available, smoke test skipped');
    process.exit(0);
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-shim-smoke-'));
  await git(workDir, ['init', '-b', 'main']);
  await git(workDir, ['config', 'user.name', 'Smoke Tester']);
  await git(workDir, ['config', 'user.email', 'smoke@test.local']);
  await fs.writeFile(path.join(workDir, 'app.txt'), 'hello\n');
  await git(workDir, ['add', '-A']);
  await git(workDir, ['commit', '-m', 'init']);

  const app = buildServer(
    {
      token: 'smoke-token',
      workDir,
      sessionId: 'smoke-session',
      mode: 'ask',
      autoPush: false,
      github: {},
    },
    fakeRunnerFactory,
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no tcp address');
  const base = `http://127.0.0.1:${address.port}`;
  const auth: Record<string, string> = { authorization: 'Bearer smoke-token' };
  const authJson: Record<string, string> = { ...auth, 'content-type': 'application/json' };
  let sse: SseClient | undefined;

  /** One full fake turn in `mode`, including the permission gate the fake runner opens. */
  async function runTurn(mode: string): Promise<void> {
    const client = sse;
    if (client === undefined) throw new Error('sse not started');
    const count = (type: string): number => client.events.filter((e) => e.type === type).length;
    const permsBefore = count('permission.request');
    const doneBefore = count('turn.completed');
    const res = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({ text: 'again', mode }),
    });
    assert.equal(res.status, 200, `prompt (${mode}) accepted`);
    await waitUntil(() => count('permission.request') > permsBefore, `permission.request (${mode})`);
    const perms = client.events.filter((e) => e.type === 'permission.request');
    const pending = perms[perms.length - 1];
    if (pending === undefined || pending.type !== 'permission.request') throw new Error('unreachable');
    await fetch(`${base}/permissions/${pending.permissionId}`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({ response: 'once' }),
    });
    await waitUntil(() => count('turn.completed') > doneBefore, `turn.completed (${mode})`);
  }

  try {
    // auth
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { ok: boolean }).ok, true);

    const noAuth = await fetch(`${base}/status`);
    assert.equal(noAuth.status, 401);

    const wrongAuth = await fetch(`${base}/status`, {
      headers: { authorization: 'Bearer smoke-token-with-wrong-suffix' },
    });
    assert.equal(wrongAuth.status, 401);

    const rightAuth = await fetch(`${base}/status`, { headers: auth });
    assert.equal(rightAuth.status, 200);

    const status0 = (await (await fetch(`${base}/status`, { headers: auth })).json()) as Record<string, unknown>;
    assert.equal(status0.adapter, 'claude');
    assert.equal(status0.provider, 'anthropic');
    assert.equal(status0.mode, 'ask');
    assert.equal(status0.busy, false);

    // model catalog (static core list)
    const modelsRes = await fetch(`${base}/models`, { headers: auth });
    assert.equal(modelsRes.status, 200);
    const models = (await modelsRes.json()) as { models: Array<{ id: string }> };
    assert.ok(models.models.some((m) => m.id === 'claude-opus-5'));

    // SSE
    sse = new SseClient(`${base}/events`, 'smoke-token');
    await sse.start();

    // prompt triggers fake turn incl. permission gate
    const promptRes = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({ text: 'hello', mode: 'ask' }),
    });
    assert.equal(promptRes.status, 200);
    assert.equal((await promptRes.json() as { ok: boolean }).ok, true);

    const permReq = await sse.wait((e) => e.type === 'permission.request');
    assert.equal(permReq.type, 'permission.request');
    if (permReq.type !== 'permission.request') throw new Error('unreachable');
    assert.equal(permReq.kind, 'bash');
    assert.ok(permReq.title.includes('npm test'));
    const permissionId = permReq.permissionId;

    // unknown id -> 404, then the real one resolves the callback
    const badPerm = await fetch(`${base}/permissions/not-a-perm`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({ response: 'once' }),
    });
    assert.equal(badPerm.status, 404);

    const permReply = await fetch(`${base}/permissions/${permissionId}`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({ response: 'once' }),
    });
    assert.equal(permReply.status, 200);

    const completed = await sse.wait((e) => e.type === 'turn.completed');
    assert.equal(completed.type, 'turn.completed');
    if (completed.type !== 'turn.completed') throw new Error('unreachable');
    assert.ok(sse.seen((e) => e.type === 'message.delta' && e.delta === 'Hel'));
    assert.ok(sse.seen((e) => e.type === 'message.delta' && e.delta === 'lo'));
    assert.ok(sse.seen((e) => e.type === 'message.completed' && e.text === 'Hello hello'));
    const toolCall = sse.events.find((e) => e.type === 'tool.call');
    assert.ok(toolCall !== undefined && toolCall.type === 'tool.call');
    assert.equal(toolCall.tool, 'Bash');
    assert.equal((toolCall.input as { command?: string }).command, 'npm test');
    assert.ok(sse.seen((e) => e.type === 'tool.result' && e.output.includes('allow')));
    assert.ok(sse.seen((e) => e.type === 'permission.resolved' && e.decision === 'once'));
    assert.equal(completed.usage?.input, 10);
    assert.equal(completed.usage?.output, 5);
    assert.equal(completed.usage?.costUsd, 0.01);
    assert.match(completed.commitSha ?? '', /^[0-9a-f]{40}$/);

    // auto-commit happened
    const commitCount = (await git(workDir, ['rev-list', '--count', 'HEAD'])).trim();
    assert.ok(Number(commitCount) >= 2, 'expected auto-commit after turn');

    // diff: modified tracked file + untracked file
    await fs.writeFile(path.join(workDir, 'app.txt'), 'hello\nworld\n');
    await fs.writeFile(path.join(workDir, 'new.txt'), 'brand new\n');
    const diffRes = await fetch(`${base}/diff`, { headers: auth });
    assert.equal(diffRes.status, 200);
    const diff = (await diffRes.json()) as Array<{ path: string; patch: string }>;
    const appEntry = diff.find((d) => d.path === 'app.txt');
    assert.ok(appEntry, 'app.txt in diff');
    assert.ok(appEntry.patch.includes('+world'));
    const newEntry = diff.find((d) => d.path === 'new.txt');
    assert.ok(newEntry, 'untracked new.txt in diff');
    assert.ok(newEntry.patch.includes('+brand new'));

    // status after turn
    const status1 = (await (await fetch(`${base}/status`, { headers: auth })).json()) as Record<string, unknown>;
    assert.equal(status1.sessionRef, 'fake-session-1');
    assert.equal(status1.busy, false);
    assert.equal(status1.mode, 'ask');

    // abort + resume
    const abortRes = await fetch(`${base}/abort`, { method: 'POST', headers: auth });
    assert.equal((await abortRes.json() as { ok: boolean }).ok, true);

    const resumeRes = await fetch(`${base}/resume`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({ sessionRef: 'fake-2' }),
    });
    assert.equal((await resumeRes.json() as { ok: boolean }).ok, true);
    const status2 = (await (await fetch(`${base}/status`, { headers: auth })).json()) as Record<string, unknown>;
    assert.equal(status2.sessionRef, 'fake-2');

    // auto-push follows the mode of the *current* turn, not the AUTO_PUSH the
    // container booted with (cfg.autoPush === false above). The smoke repo has
    // no origin, so an attempted push surfaces as a "push failed" error event.
    const pushAttempts = (): number =>
      (sse?.events ?? []).filter((e) => e.type === 'error' && e.message.startsWith('push failed')).length;
    assert.equal(pushAttempts(), 0, 'no push attempt for the ask turns so far');
    await runTurn('yolo');
    await waitUntil(() => pushAttempts() === 1, 'push attempt after switching to yolo');
    await runTurn('ask');
    assert.equal(pushAttempts(), 1, 'no further push after switching back to ask');

    // validation
    const badPrompt = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({ text: '' }),
    });
    assert.equal(badPrompt.status, 400);
    const badPermBody = await fetch(`${base}/permissions/${permissionId}`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({ response: 'maybe' }),
    });
    assert.equal(badPermBody.status, 400);

    // --- credential handling: readGithubPat (creds file + env fallback) ---
    const prevCredsFile = process.env.PA_CREDS_FILE;
    const prevGithubPat = process.env.GITHUB_PAT;
    const credsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-shim-creds-'));
    try {
      const credsFile = path.join(credsDir, 'creds.json');
      await fs.writeFile(credsFile, JSON.stringify({ githubPat: 'file-pat-123' }));
      delete process.env.GITHUB_PAT;
      process.env.PA_CREDS_FILE = credsFile;
      assert.equal(readGithubPat(), 'file-pat-123');

      const badCredsFile = path.join(credsDir, 'bad.json');
      await fs.writeFile(badCredsFile, '{not valid json');
      process.env.PA_CREDS_FILE = badCredsFile;
      process.env.GITHUB_PAT = 'env-pat-456';
      assert.equal(readGithubPat(), 'env-pat-456');

      process.env.PA_CREDS_FILE = path.join(credsDir, 'missing.json');
      assert.equal(readGithubPat(), 'env-pat-456');

      delete process.env.GITHUB_PAT;
      assert.equal(readGithubPat(), undefined);

      delete process.env.PA_CREDS_FILE;
      process.env.GITHUB_PAT = 'env-only-789';
      assert.equal(readGithubPat(), 'env-only-789');
    } finally {
      if (prevCredsFile === undefined) delete process.env.PA_CREDS_FILE;
      else process.env.PA_CREDS_FILE = prevCredsFile;
      if (prevGithubPat === undefined) delete process.env.GITHUB_PAT;
      else process.env.GITHUB_PAT = prevGithubPat;
      await fs.rm(credsDir, { recursive: true, force: true });
    }

    // --- askpass helper: no PAT literal inside the script file ---
    const askpass = askpassEnv('super-secret-pat-987');
    assert.ok(askpass !== undefined, 'askpassEnv returns env for a pat');
    assert.equal(askpass.PA_GIT_PAT, 'super-secret-pat-987');
    assert.equal(askpass.GIT_TERMINAL_PROMPT, '0');
    assert.ok(typeof askpass.GIT_ASKPASS === 'string' && askpass.GIT_ASKPASS.length > 0);
    const askpassScript = await fs.readFile(askpass.GIT_ASKPASS!, 'utf8');
    assert.ok(!askpassScript.includes('super-secret-pat-987'), 'askpass script must not embed PAT');
    assert.ok(askpassScript.includes('x-access-token'), 'askpass answers the username prompt');
    assert.equal((await fs.stat(askpass.GIT_ASKPASS!)).mode & 0o777, 0o700, 'askpass is 0700');
    assert.equal(askpassEnv(undefined), undefined, 'no pat -> no askpass env');
    await fs.rm(askpass.GIT_ASKPASS!, { force: true });

    // --- git end-to-end: plain-URL clone + askpass push against file:// remote ---
    const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-shim-seed-'));
    const bareDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-shim-bare-'));
    const cloneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-shim-clone-'));
    const pushJsCreds = path.join(os.tmpdir(), `claude-shim-pushjs-${process.pid}.json`);
    const gitSessionId = 'git-e2e';
    const gitPat = 'e2e-pat-do-not-leak';
    try {
      await git(seedDir, ['init', '-b', 'main']);
      await git(seedDir, ['config', 'user.name', 'Seed']);
      await git(seedDir, ['config', 'user.email', 'seed@test.local']);
      await fs.writeFile(path.join(seedDir, 'README.md'), '# seed\n');
      await git(seedDir, ['add', '-A']);
      await git(seedDir, ['commit', '-m', 'init', '--no-verify']);
      await exec('git', ['clone', '--bare', seedDir, bareDir]);
      const bareUrl = `file://${bareDir}`;

      const bootstrap = await ensureRepo({
        workDir: cloneDir,
        repoUrl: bareUrl,
        repoBranch: 'main',
        pat: gitPat,
        sessionId: gitSessionId,
      });
      assert.equal(bootstrap, 'cloned');
      const cloneConfig = await fs.readFile(path.join(cloneDir, '.git/config'), 'utf8');
      assert.ok(!cloneConfig.includes(gitPat), 'no PAT in .git/config after clone');
      assert.ok(!cloneConfig.includes('x-access-token'), 'no injected username in remote URL');
      assert.ok(cloneConfig.includes(bareUrl), 'remote origin is the plain file:// URL');

      const sha = await commitTurn(cloneDir);
      assert.match(sha, /^[0-9a-f]{40}$/);

      const pushed = await pushAndCreatePr({
        workDir: cloneDir,
        sessionId: gitSessionId,
        pat: gitPat,
      });
      assert.equal(pushed.branch, `agent/${gitSessionId}`);
      assert.equal(pushed.prUrl, undefined);
      await git(bareDir, ['rev-parse', '--verify', `refs/heads/agent/${gitSessionId}`]);
      const pushedConfig = await fs.readFile(path.join(cloneDir, '.git/config'), 'utf8');
      assert.ok(!pushedConfig.includes(gitPat), 'no PAT in .git/config after push');

      // scripts/push.js through the same credential path (creds file, file:// remote)
      await fs.writeFile(pushJsCreds, JSON.stringify({ githubPat: 'pushjs-pat-321' }));
      const pushJs = await exec(process.execPath, [
        fileURLToPath(new URL('../scripts/push.js', import.meta.url)),
      ], {
        env: {
          ...process.env,
          WORK_DIR: cloneDir,
          SESSION_ID: gitSessionId,
          PA_CREDS_FILE: pushJsCreds,
          GITHUB_PAT: '',
          REPO_FULL_NAME: '',
        },
        maxBuffer: 16 * 1024 * 1024,
      });
      const jsonLine = pushJs.stdout
        .trim()
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .pop();
      assert.ok(jsonLine, 'push.js printed its JSON outcome');
      const outcome = JSON.parse(jsonLine ?? '{}') as { ok: boolean; branch: string };
      assert.equal(outcome.ok, true);
      assert.equal(outcome.branch, `agent/${gitSessionId}`);
      const finalConfig = await fs.readFile(path.join(cloneDir, '.git/config'), 'utf8');
      assert.ok(!finalConfig.includes('pushjs-pat-321'), 'no PAT in .git/config after push.js');
      assert.ok(!finalConfig.includes(gitPat), 'still no gitops PAT after push.js');
    } finally {
      await fs.rm(seedDir, { recursive: true, force: true });
      await fs.rm(bareDir, { recursive: true, force: true });
      await fs.rm(cloneDir, { recursive: true, force: true });
      await fs.rm(pushJsCreds, { force: true });
    }

    sse.close();
    console.log('SMOKE OK');
    process.exit(0);
  } finally {
    sse?.close();
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
