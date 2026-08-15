import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { DiffEntry } from '@pocketagent/protocol';

const execFileAsync = promisify(execFile);

export interface GitContext {
  workDir: string;
  sessionId: string;
  repoUrl?: string;
  repoBranch?: string;
  githubPat?: string;
  repoFullName?: string;
}

const GIT_USER_NAME = 'PocketAgent';
const GIT_USER_EMAIL = 'agent@pocketagent.local';
const MAX_PATCH_BYTES = 64 * 1024;
const MAX_DIFF_FILES = 500;

export function redact(text: string, secret?: string): string {
  if (!secret) return text;
  return text.split(secret).join('***');
}

export function agentBranch(sessionId: string): string {
  return `agent/${sessionId}`;
}

export function withCredentials(url: string, pat?: string): string {
  if (!pat) return url;
  return url.replace(/^(https:\/\/)(?:[^/@]+@)?([^/]+)/, `$1x-access-token:${pat}@$2`);
}

export function stripCredentials(url: string): string {
  return url.replace(/^(https:\/\/)[^/@]+@/, '$1');
}

async function git(cwd: string, args: string[], ctx: GitContext, timeoutMs = 120_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(redact(`git ${args[0] ?? ''} failed: ${detail}`, ctx.githubPat));
  }
}

/**
 * Idempotent repo bootstrap for the session work dir.
 * - empty dir + REPO_URL: clone (optional branch) and create agent branch
 * - empty dir, no REPO_URL: git init + empty initial commit (local mode)
 * - existing checkout: make sure identity is set and the agent branch is active
 */
export async function ensureRepo(ctx: GitContext): Promise<string> {
  const branch = agentBranch(ctx.sessionId);
  if (!existsSync(join(ctx.workDir, '.git'))) {
    if (ctx.repoUrl) {
      await mkdir(dirname(ctx.workDir), { recursive: true });
      const args = ['clone'];
      if (ctx.repoBranch) args.push('--branch', ctx.repoBranch);
      args.push(withCredentials(ctx.repoUrl, ctx.githubPat), ctx.workDir);
      await git(dirname(ctx.workDir), args, ctx, 300_000);
    } else {
      await mkdir(ctx.workDir, { recursive: true });
      await git(ctx.workDir, ['init', '-b', ctx.repoBranch || 'main'], ctx);
      await git(ctx.workDir, ['config', 'user.name', GIT_USER_NAME], ctx);
      await git(ctx.workDir, ['config', 'user.email', GIT_USER_EMAIL], ctx);
      await git(ctx.workDir, ['add', '-A'], ctx);
      await git(ctx.workDir, ['commit', '-m', 'init', '--allow-empty', '--no-verify'], ctx);
    }
  }
  await git(ctx.workDir, ['config', 'user.name', GIT_USER_NAME], ctx);
  await git(ctx.workDir, ['config', 'user.email', GIT_USER_EMAIL], ctx);
  const existing = (await git(ctx.workDir, ['branch', '--list', branch], ctx)).trim().length > 0;
  await git(ctx.workDir, existing ? ['checkout', branch] : ['checkout', '-b', branch], ctx);
  return branch;
}

/** Auto-commit after a completed turn. Always creates a commit (--allow-empty) as turn marker. */
export async function commitTurn(ctx: GitContext, isoTimestamp: string): Promise<string> {
  await git(ctx.workDir, ['add', '-A'], ctx);
  await git(
    ctx.workDir,
    ['commit', '-m', `agent: turn ${isoTimestamp}`, '--allow-empty', '--no-verify'],
    ctx,
  );
  return (await git(ctx.workDir, ['rev-parse', 'HEAD'], ctx)).trim();
}

export async function pushBranch(ctx: GitContext, branch: string): Promise<void> {
  let remoteUrl = '';
  try {
    remoteUrl = stripCredentials((await git(ctx.workDir, ['remote', 'get-url', 'origin'], ctx)).trim());
  } catch {
    remoteUrl = ctx.repoUrl ?? '';
  }
  const url = withCredentials(remoteUrl, ctx.githubPat);
  if (!url) throw new Error('no remote configured for push');
  await git(ctx.workDir, ['push', url, `HEAD:refs/heads/${branch}`], ctx, 300_000);
}

interface PullRequestResponse {
  html_url?: unknown;
}

/** Create a draft PR; returns undefined when one already exists (409/422 swallowed). */
export async function createDraftPr(ctx: GitContext, branch: string): Promise<string | undefined> {
  if (!ctx.githubPat || !ctx.repoFullName) return undefined;
  const base = ctx.repoBranch || 'main';
  const response = await fetch(`https://api.github.com/repos/${ctx.repoFullName}/pulls`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ctx.githubPat}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({
      title: `PocketAgent session ${ctx.sessionId}`,
      head: branch,
      base,
      draft: true,
    }),
  });
  if (response.ok) {
    const data: unknown = await response.json();
    if (typeof data === 'object' && data !== null) {
      const url = (data as PullRequestResponse).html_url;
      if (typeof url === 'string') return url;
    }
    return undefined;
  }
  if (response.status === 409 || response.status === 422) return undefined;
  const text = redact(await response.text(), ctx.githubPat);
  throw new Error(`draft PR failed: HTTP ${response.status} ${text.slice(0, 300)}`);
}

function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

async function untrackedEntry(workDir: string, path: string): Promise<DiffEntry | undefined> {
  try {
    const buffer = await readFile(join(workDir, path));
    if (isBinaryBuffer(buffer)) return { path, patch: '', binary: true };
    const patch = buffer
      .toString('utf8')
      .split('\n')
      .map(line => `+${line}`)
      .join('\n');
    return { path, patch: patch.slice(0, MAX_PATCH_BYTES) };
  } catch {
    return undefined;
  }
}

/** Whole-session diff: tracked changes vs HEAD plus untracked files. */
export async function getDiff(ctx: GitContext): Promise<DiffEntry[]> {
  const { workDir } = ctx;
  const trackedOut = await git(workDir, ['status', '--porcelain', '-z', '--untracked-files=no'], ctx);
  const untrackedOut = await git(workDir, ['ls-files', '--others', '--exclude-standard', '-z'], ctx);
  const entries: DiffEntry[] = [];

  const trackedRecords = trackedOut.split('\0').filter(record => record.length >= 3);
  const seen = new Set<string>();
  for (const record of trackedRecords) {
    const path = record.slice(3).trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const patch = await git(workDir, ['diff', 'HEAD', '--', path], ctx);
    entries.push({ path, patch: patch.slice(0, MAX_PATCH_BYTES) });
    if (entries.length >= MAX_DIFF_FILES) return entries;
  }

  const untrackedPaths = untrackedOut.split('\0').filter(path => path.length > 0);
  for (const path of untrackedPaths) {
    if (seen.has(path)) continue;
    const entry = await untrackedEntry(workDir, path);
    if (entry) entries.push(entry);
    if (entries.length >= MAX_DIFF_FILES) return entries;
  }
  return entries;
}
