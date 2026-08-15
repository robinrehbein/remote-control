import { execFile } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface RepoOptions {
  workDir: string;
  repoUrl: string;
  repoBranch?: string;
  sessionId: string;
}

export interface PushOptions extends RepoOptions {
  repoFullName: string;
}

export type PushOutcome = { ok: true; prUrl?: string } | { ok: false; error: string };

export function branchFor(sessionId: string): string {
  return `agent/${sessionId}`;
}

export function sanitizeUrl(url: string): string {
  return url.replace(/:\/\/[^@/\s]+@/, '://***@');
}

/**
 * GitHub PAT resolution, in priority order:
 *   1. creds file at PA_CREDS_FILE (default /run/secrets/pa/creds.json),
 *      JSON { "githubPat": "..." } — per-session container mode
 *   2. GITHUB_PAT env — link-agent (local dev PC) fallback
 * Tolerant of a missing file or malformed JSON (falls through to env).
 */
export function readGithubPat(): string | undefined {
  const credsPath = process.env.PA_CREDS_FILE ?? '/run/secrets/pa/creds.json';
  try {
    const parsed = JSON.parse(readFileSync(credsPath, 'utf8')) as { githubPat?: unknown };
    if (typeof parsed.githubPat === 'string' && parsed.githubPat.length > 0) return parsed.githubPat;
  } catch {
    // missing file / bad JSON -> fall through to env
  }
  const fromEnv = process.env.GITHUB_PAT;
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined;
}

// The askpass helper echoes the PAT (delivered via the PA_GIT_PAT env var) only
// when git asks for it. The secret never appears in the script itself, in a
// remote URL, in .git/config or in argv.
const ASKPASS_SCRIPT = [
  '#!/bin/sh',
  'case "$1" in',
  '  Username*) echo "x-access-token" ;;',
  "  *) printf '%s' \"$PA_GIT_PAT\" ;;",
  'esac',
  '',
].join('\n');

export function askpassEnv(pat: string | undefined): NodeJS.ProcessEnv | undefined {
  if (!pat) return undefined;
  const script = join(tmpdir(), `pocketagent-askpass-${process.pid}.sh`);
  try {
    writeFileSync(script, ASKPASS_SCRIPT, { mode: 0o700 });
    chmodSync(script, 0o700);
  } catch {
    // best effort; if the script cannot be written git will simply fail
    // credential prompts instead of leaking anything
  }
  return { ...process.env, GIT_ASKPASS: script, GIT_TERMINAL_PROMPT: '0', PA_GIT_PAT: pat };
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return await gitOpts(cwd, undefined, ...args);
}

async function gitOpts(cwd: string, env: NodeJS.ProcessEnv | undefined, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, env });
  return stdout;
}

export async function ensureRepo(opts: RepoOptions): Promise<string> {
  const { workDir, repoUrl, repoBranch, sessionId } = opts;
  const branch = branchFor(sessionId);
  if (!existsSync(join(workDir, '.git'))) {
    if (!repoUrl) throw new Error(`WORK_DIR ${workDir} is not a git repo and REPO_URL is not set`);
    const args = ['clone'];
    if (repoBranch) args.push('--branch', repoBranch);
    args.push(repoUrl, workDir); // plain https URL; auth (if any) flows via GIT_ASKPASS
    console.log(`[git] cloning ${sanitizeUrl(repoUrl)} (branch ${repoBranch ?? 'default'}) -> ${workDir}`);
    await exec('git', args, { maxBuffer: 32 * 1024 * 1024, env: askpassEnv(readGithubPat()) });
  }
  await git(workDir, 'config', 'user.name', 'PocketAgent');
  await git(workDir, 'config', 'user.email', 'agent@pocketagent.local');
  try {
    await git(workDir, 'checkout', '-b', branch);
  } catch {
    await git(workDir, 'checkout', branch);
  }
  console.log(`[git] on branch ${branch}`);
  return branch;
}

export async function isDirty(workDir: string): Promise<boolean> {
  const out = await git(workDir, 'status', '--porcelain');
  return out.trim().length > 0;
}

export async function commitTurn(workDir: string): Promise<string | undefined> {
  const stamp = new Date().toISOString();
  await git(workDir, 'add', '-A');
  await git(workDir, 'commit', '-m', `agent: turn ${stamp}`, '--allow-empty', '--no-verify');
  return (await git(workDir, 'rev-parse', 'HEAD')).trim();
}

async function ensureDraftPR(opts: { githubPat: string; repoFullName: string; sessionId: string; repoBranch?: string }, branch: string): Promise<string | undefined> {
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
    const pat = readGithubPat();
    if (!pat) return { ok: false, error: 'github PAT not available (PA_CREDS_FILE creds file or GITHUB_PAT env)' };
    if (!opts.repoUrl) return { ok: false, error: 'REPO_URL not set' };
    // push the plain https URL; credentials flow through GIT_ASKPASS so the
    // PAT is never embedded in a remote URL and never persisted in .git/config
    await gitOpts(opts.workDir, askpassEnv(pat), 'push', opts.repoUrl, `HEAD:refs/heads/${branch}`);
    if (!opts.repoFullName) return { ok: true };
    const prUrl = await ensureDraftPR(
      { githubPat: pat, repoFullName: opts.repoFullName, sessionId: opts.sessionId, repoBranch: opts.repoBranch },
      branch,
    );
    return { ok: true, prUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
