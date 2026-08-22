/**
 * Unit tests for the Fly bootstrap (link/src/fly-bootstrap.ts, F4): the
 * clone/branch logic a disk-less Fly Machine runs before starting the link
 * agent - driven entirely against a local fixture repo (git init + bare
 * "origin"), no network, no GitHub.
 *
 * Covers:
 *  (a) fresh clone onto the base branch (PA_REPO_BRANCH) when no remote
 *      agent branch exists yet,
 *  (b) an existing remote agent branch (agent/<session-id>) gets checked out
 *      and fast-forwarded (resume after idle-stop: new machine, fresh clone),
 *  (c) the GITHUB_PAT never leaks into .git/config (or any other file under
 *      .git) and the clone URL stays token-free,
 *  (d) a half-empty workdir (interrupted first clone, junk without .git) is
 *      wiped and re-cloned,
 *  (e) the NO_PROXY hardening for the embedded runner's loopback fetches.
 *
 * Run: npm run test -w link   (from repo root; needs git on PATH)
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ensureLoopbackNoProxy, prepareFlyWorkdir } from '../src/fly-bootstrap.js';

const exec = promisify(execFile);

function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'FlyBootstrapTest',
  GIT_AUTHOR_EMAIL: 'fly-bootstrap@test.local',
  GIT_COMMITTER_NAME: 'FlyBootstrapTest',
  GIT_COMMITTER_EMAIL: 'fly-bootstrap@test.local',
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, env: GIT_ENV });
  return stdout;
}

async function currentBranch(cwd: string): Promise<string> {
  return (await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
}

/** All file contents below `dir` (shallow-walked), for the PAT-leak grep. */
function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(p, out);
    else out.push(p);
  }
  return out;
}

/* ---------------- fixture: bare origin with main + agent/s1 ---------------- */

const base = mkdtempSync(join(tmpdir(), 'fly-bootstrap-test-'));
const origin = join(base, 'origin.git');
const seed = join(base, 'seed');

try {
  await exec('git', ['init', '--bare', '-b', 'main', origin], { env: GIT_ENV });
  await exec('git', ['init', '-b', 'main', seed], { env: GIT_ENV });
  writeFileSync(join(seed, 'README.md'), '# base\n');
  await git(seed, 'add', '-A');
  await git(seed, 'commit', '-m', 'init', '--no-verify');
  await git(seed, 'push', origin, 'main');
  await git(seed, 'checkout', '-b', 'agent/s1');
  writeFileSync(join(seed, 'AGENT.md'), '# agent work\n');
  await git(seed, 'add', '-A');
  await git(seed, 'commit', '-m', 'agent turn', '--no-verify');
  await git(seed, 'push', origin, 'agent/s1');

  /* -------- (a) fresh clone onto the base branch (new session) -------- */

  const workA = join(base, 'work-a');
  const quiet = (): void => {};
  const resA = await prepareFlyWorkdir({
    workDir: workA,
    repoUrl: origin,
    repoBranch: 'main',
    agentBranch: 'agent/other-session', // remote branch that does not exist
    log: quiet,
  });
  expect(resA.branch === 'main', `(a) prepare reports the base branch, got ${resA.branch}`);
  expect((await currentBranch(workA)) === 'main', `(a) HEAD is on main, got ${await currentBranch(workA)}`);
  // The workdir IS the checkout (runner-embed expects the repo at PA_WORKDIR).
  expect(existsSync(join(workA, 'README.md')), '(a) clone landed directly in the workdir');
  expect(!existsSync(join(workA, 'AGENT.md')), '(a) base checkout does not carry agent-branch files');

  /* -------- (b) existing remote agent branch gets checked out ---------- */

  const workB = join(base, 'work-b');
  const resB = await prepareFlyWorkdir({
    workDir: workB,
    repoUrl: origin,
    repoBranch: 'main',
    agentBranch: 'agent/s1',
    log: quiet,
  });
  expect(resB.branch === 'agent/s1', `(b) prepare reports the agent branch, got ${resB.branch}`);
  expect((await currentBranch(workB)) === 'agent/s1', `(b) HEAD is on agent/s1, got ${await currentBranch(workB)}`);
  expect(existsSync(join(workB, 'AGENT.md')), '(b) agent-branch content is checked out');

  /* -------- (c) PAT never reaches .git/config or the clone URL --------- */

  const pat = 'ghp_TESTPAT-must-not-leak-9137';
  const workC = join(base, 'work-c');
  await prepareFlyWorkdir({
    workDir: workC,
    repoUrl: origin,
    repoBranch: 'main',
    agentBranch: 'agent/s1',
    githubPat: pat,
    log: quiet,
  });
  const config = readFileSync(join(workC, '.git', 'config'), 'utf8');
  expect(!config.includes(pat), '(c) PAT is not in .git/config');
  expect(!config.includes('x-access-token'), '(c) no basic-auth extraheader persisted in .git/config');
  for (const file of collectFiles(join(workC, '.git'))) {
    expect(!readFileSync(file, 'utf8').includes(pat), `(c) PAT is not in any file under .git (${file})`);
  }
  const remoteUrl = (await git(workC, 'remote', 'get-url', 'origin')).trim();
  expect(remoteUrl === origin, `(c) remote URL is the token-free origin, got ${remoteUrl}`);

  /* -------- (d) half-empty workdir is wiped and re-cloned --------------- */

  const workD = join(base, 'work-d');
  mkdirSync(workD);
  writeFileSync(join(workD, 'junk-from-interrupted-clone.txt'), 'partial');
  const resD = await prepareFlyWorkdir({ workDir: workD, repoUrl: origin, repoBranch: 'main', log: quiet });
  expect(resD.branch === 'main', `(d) re-clone lands on base branch, got ${resD.branch}`);
  expect(existsSync(join(workD, 'README.md')), '(d) re-cloned checkout has the repo content');
  expect(!existsSync(join(workD, 'junk-from-interrupted-clone.txt')), '(d) interrupted leftovers were wiped');

  // Broken .git (clone died before any ref was written): also re-cloned.
  const workE = join(base, 'work-e');
  mkdirSync(join(workE, '.git'), { recursive: true });
  const resE = await prepareFlyWorkdir({ workDir: workE, repoUrl: origin, repoBranch: 'main', log: quiet });
  expect(resE.branch === 'main' && existsSync(join(workE, 'README.md')), '(d) broken .git is re-cloned');

  /* -------- (e) resume: existing checkout fast-forwards to origin ------- */

  // Simulate the next pushed turn on the remote agent branch ...
  await git(seed, 'checkout', 'agent/s1');
  writeFileSync(join(seed, 'TURN-2.md'), 'second turn\n');
  await git(seed, 'add', '-A');
  await git(seed, 'commit', '-m', 'agent turn 2', '--no-verify');
  await git(seed, 'push', origin, 'agent/s1');
  // ... and re-run the bootstrap on the already-existing workB checkout.
  const resF = await prepareFlyWorkdir({
    workDir: workB,
    repoUrl: origin,
    repoBranch: 'main',
    agentBranch: 'agent/s1',
    log: quiet,
  });
  expect(resF.branch === 'agent/s1', `(e) resume stays on the agent branch, got ${resF.branch}`);
  expect(existsSync(join(workB, 'TURN-2.md')), '(e) resume fast-forwarded to the pushed remote state');

  /* -------- (f) NO_PROXY hardening for the loopback fetches ------------- */

  {
    const env: NodeJS.ProcessEnv = {
      HTTPS_PROXY: 'http://pa:shimtoken@egress.example.com:3128',
      NO_PROXY: 'orch.example.com',
    };
    ensureLoopbackNoProxy(env);
    for (const key of ['NO_PROXY', 'no_proxy'] as const) {
      const tokens = (env[key] ?? '').split(',').map((t) => t.trim());
      expect(tokens.includes('orch.example.com'), `(f) ${key} keeps the orchestrator host`);
      expect(tokens.includes('127.0.0.1') && tokens.includes('localhost'), `(f) ${key} gains the loopback entries`);
    }
    expect(env.HTTPS_PROXY === 'http://pa:shimtoken@egress.example.com:3128', '(f) proxy URL incl. userinfo passes through unchanged');
  }
  {
    // Without a proxy (policy 'open') nothing must be invented.
    const env: NodeJS.ProcessEnv = { NO_PROXY: 'whatever' };
    ensureLoopbackNoProxy(env);
    expect(env.NO_PROXY === 'whatever' && env.no_proxy === undefined, '(f) no proxy -> NO_PROXY untouched');
  }

  console.log('FLY-BOOTSTRAP TEST OK');
} finally {
  rmSync(base, { recursive: true, force: true });
}
