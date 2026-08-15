import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Default location of the orchestrator-injected credentials file (uid-1000-readable). */
export const CREDS_FILE_DEFAULT = '/run/secrets/pa/creds.json';

export interface RepoOptions {
  workDir: string;
  repoUrl: string;
  repoBranch?: string;
  githubPat?: string;
  sessionId: string;
}

export interface PushOptions extends RepoOptions {
  repoFullName: string;
}

export type PushOutcome = { ok: true; prUrl?: string } | { ok: false; error: string };

/**
 * Resolve the GitHub PAT: session containers get no GITHUB_PAT env; instead the
 * orchestrator injects a creds file at PA_CREDS_FILE (default
 * /run/secrets/pa/creds.json, JSON {"githubPat":"..."}). Link-agent mode still
 * passes GITHUB_PAT env, so fall back to it. Tolerates a missing/bad file.
 */
export function readGithubPat(env: Record<string, string | undefined> = process.env): string | undefined {
  const credsFile = env.PA_CREDS_FILE ?? CREDS_FILE_DEFAULT;
  try {
    const parsed: unknown = JSON.parse(readFileSync(credsFile, 'utf8'));
    const pat = (parsed as { githubPat?: unknown } | null)?.githubPat;
    if (typeof pat === 'string' && pat.length > 0) return pat;
  } catch {
    // missing/unreadable/invalid creds file: fall through to the env fallback
  }
  const envPat = env.GITHUB_PAT;
  return typeof envPat === 'string' && envPat.length > 0 ? envPat : undefined;
}

/**
 * Environment for git child processes that need GitHub auth over https without
 * the PAT ever appearing in a remote URL, .git/config, argv or logs: git calls
 * the GIT_ASKPASS helper for credentials and the helper prints the PAT from
 * PA_GIT_PAT in its environment. The script itself never contains the PAT.
 */
export function askpassEnv(pat: string | undefined): NodeJS.ProcessEnv | undefined {
  if (pat === undefined || pat.length === 0) return undefined;
  const path = join(tmpdir(), `pocketagent-askpass-${process.pid}.sh`);
  const script = '#!/bin/sh\ncase "$1" in\n  Username*) echo "x-access-token" ;;\n  *) printf \'%s\' "$PA_GIT_PAT" ;;\nesac\n';
  writeFileSync(path, script, { mode: 0o700 });
  return { ...process.env, GIT_ASKPASS: path, GIT_TERMINAL_PROMPT: '0', PA_GIT_PAT: pat };
}

export function branchFor(sessionId: string): string {
  return `agent/${sessionId}`;
}

export function sanitizeUrl(url: string): string {
  return url.replace(/:\/\/[^@/\s]+@/, '://***@');
}

export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, env });
  return stdout;
}

export async function ensureRepo(opts: RepoOptions): Promise<string> {
  const { workDir, repoUrl, repoBranch, githubPat, sessionId } = opts;
  const branch = branchFor(sessionId);
  if (!existsSync(join(workDir, '.git'))) {
    if (!repoUrl) throw new Error(`WORK_DIR ${workDir} is not a git repo and REPO_URL is not set`);
    const args = ['clone'];
    if (repoBranch) args.push('--branch', repoBranch);
    args.push(repoUrl, workDir);
    console.log(`[git] cloning ${sanitizeUrl(repoUrl)} (branch ${repoBranch ?? 'default'}) -> ${workDir}`);
    // plain https URL; credentials (if any) are supplied via GIT_ASKPASS so
    // neither argv nor .git/config ever contains the PAT
    await exec('git', args, { maxBuffer: 32 * 1024 * 1024, env: askpassEnv(githubPat) });
  }
  await git(workDir, ['config', 'user.name', 'PocketAgent']);
  await git(workDir, ['config', 'user.email', 'agent@pocketagent.local']);
  try {
    await git(workDir, ['checkout', '-b', branch]);
  } catch {
    await git(workDir, ['checkout', branch]);
  }
  console.log(`[git] on branch ${branch}`);
  return branch;
}

export async function isDirty(workDir: string): Promise<boolean> {
  const out = await git(workDir, ['status', '--porcelain']);
  return out.trim().length > 0;
}

export async function commitTurn(workDir: string): Promise<string | undefined> {
  const stamp = new Date().toISOString();
  await git(workDir, ['add', '-A']);
  await git(workDir, ['commit', '-m', `agent: turn ${stamp}`, '--allow-empty', '--no-verify']);
  return (await git(workDir, ['rev-parse', 'HEAD'])).trim();
}

async function ensureDraftPR(opts: Required<Pick<PushOptions, 'githubPat' | 'repoFullName' | 'sessionId'>> & { repoBranch?: string }, branch: string): Promise<string | undefined> {
  const { githubPat, repoFullName, sessionId, repoBranch } = opts;
  const base = repoBranch ?? 'main';
  const api = `https://api.github.com/repos/${repoFullName}/pulls`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${githubPat}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
    'user-agent': 'pocketagent-shim',
  };
  const create = await fetch(api, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: `PocketAgent session ${sessionId}`, head: branch, base, draft: true }),
  });
  if (create.ok) {
    const created = (await create.json()) as { html_url?: string };
    return created.html_url;
  }
  if (create.status === 409 || create.status === 422) {
    try {
      const owner = repoFullName.split('/')[0] ?? '';
      const list = await fetch(`${api}?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`, { headers });
      if (list.ok) {
        const arr = (await list.json()) as { html_url?: string }[];
        return arr[0]?.html_url;
      }
    } catch {
      // PR exists but listing failed; not fatal
    }
    return undefined;
  }
  throw new Error(`draft PR create failed: HTTP ${create.status}`);
}

export async function pushAndDraftPR(opts: PushOptions): Promise<PushOutcome> {
  const branch = branchFor(opts.sessionId);
  try {
    if (!opts.repoUrl) return { ok: false, error: 'REPO_URL not set' };
    const pat = opts.githubPat;
    const askpass = askpassEnv(pat);
    if (pat === undefined || askpass === undefined) {
      return { ok: false, error: 'github PAT not configured (PA_CREDS_FILE or GITHUB_PAT)' };
    }
    // push over the plain https URL; GIT_ASKPASS supplies credentials so the
    // PAT is never persisted in git config or visible in argv/logs
    await git(opts.workDir, ['push', opts.repoUrl, `HEAD:refs/heads/${branch}`], askpass);
    const prUrl = await ensureDraftPR(
      { githubPat: pat, repoFullName: opts.repoFullName, sessionId: opts.sessionId, repoBranch: opts.repoBranch },
      branch,
    );
    return { ok: true, prUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
