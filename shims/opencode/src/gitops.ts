import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

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

export function branchFor(sessionId: string): string {
  return `agent/${sessionId}`;
}

export function sanitizeUrl(url: string): string {
  return url.replace(/:\/\/[^@/\s]+@/, '://***@');
}

function authUrl(repoUrl: string, pat: string | undefined): string {
  if (!pat) return repoUrl;
  return repoUrl.replace(/^https:\/\//, `https://x-access-token:${encodeURIComponent(pat)}@`);
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

export async function ensureRepo(opts: RepoOptions): Promise<string> {
  const { workDir, repoUrl, repoBranch, githubPat, sessionId } = opts;
  const branch = branchFor(sessionId);
  if (!existsSync(join(workDir, '.git'))) {
    if (!repoUrl) throw new Error(`WORK_DIR ${workDir} is not a git repo and REPO_URL is not set`);
    const args = ['clone'];
    if (repoBranch) args.push('--branch', repoBranch);
    args.push(authUrl(repoUrl, githubPat), workDir);
    console.log(`[git] cloning ${sanitizeUrl(repoUrl)} (branch ${repoBranch ?? 'default'}) -> ${workDir}`);
    await exec('git', args, { maxBuffer: 32 * 1024 * 1024 });
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
    if (!opts.githubPat) return { ok: false, error: 'GITHUB_PAT not set' };
    if (!opts.repoUrl) return { ok: false, error: 'REPO_URL not set' };
    // push with an authenticated one-shot URL; PAT is never persisted in git config
    await git(opts.workDir, 'push', authUrl(opts.repoUrl, opts.githubPat), `HEAD:refs/heads/${branch}`);
    const prUrl = await ensureDraftPR(
      { githubPat: opts.githubPat, repoFullName: opts.repoFullName, sessionId: opts.sessionId, repoBranch: opts.repoBranch },
      branch,
    );
    return { ok: true, prUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
