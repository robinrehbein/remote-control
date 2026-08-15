/**
 * Git operations for the claude shim: repo bootstrap (clone/branch),
 * per-turn auto-commit, push + draft PR, and uncommitted-change diff.
 */
import type { DiffEntry } from '@pocketagent/protocol';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface RepoConfig {
  workDir: string;
  repoUrl?: string;
  repoBranch?: string;
  pat?: string;
  sessionId: string;
}

export interface PushConfig {
  workDir: string;
  sessionId: string;
  pat?: string;
  repoFullName?: string;
  base?: string;
}

function sanitize(out: unknown): string {
  return String(out ?? '').replace(/https:\/\/[^\s'"]+@/g, 'https://***@').slice(0, 500);
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args[0] ?? ''} failed: ${sanitize(e.stderr || e.message)}`);
  }
}

/** Inject the PAT into an https clone URL without ever logging it. */
function authUrl(repoUrl: string, pat?: string): string {
  if (!pat) return repoUrl;
  try {
    const url = new URL(repoUrl);
    url.username = 'x-access-token';
    url.password = pat;
    return url.toString();
  } catch {
    return repoUrl;
  }
}

export function branchName(sessionId: string): string {
  return `agent/${sessionId}`;
}

/**
 * Bootstrap /work: clone when empty, then ensure branch agent/<session-id>
 * and a session-local git identity.
 */
export async function ensureRepo(cfg: RepoConfig): Promise<'cloned' | 'existing' | 'skipped'> {
  await fs.mkdir(cfg.workDir, { recursive: true });
  const hasGit = await fs
    .stat(path.join(cfg.workDir, '.git'))
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!hasGit) {
    const entries = await fs.readdir(cfg.workDir);
    if (entries.length > 0) return 'skipped';
    if (!cfg.repoUrl) return 'skipped';
    const args = ['clone'];
    if (cfg.repoBranch) args.push('--branch', cfg.repoBranch, '--single-branch');
    args.push(authUrl(cfg.repoUrl, cfg.pat), cfg.workDir);
    await git(cfg.workDir, args);
  }
  await git(cfg.workDir, ['config', 'user.name', 'PocketAgent']);
  await git(cfg.workDir, ['config', 'user.email', 'agent@pocketagent.local']);
  const branch = branchName(cfg.sessionId);
  const exists = await git(cfg.workDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    .then(() => true)
    .catch(() => false);
  await git(cfg.workDir, exists ? ['checkout', branch] : ['checkout', '-b', branch]);
  return hasGit ? 'existing' : 'cloned';
}

/** Auto-commit after a completed turn; always returns HEAD sha (allow-empty). */
export async function commitTurn(workDir: string): Promise<string> {
  await git(workDir, ['add', '-A']);
  await git(workDir, [
    'commit',
    '-m',
    `agent: turn ${new Date().toISOString()}`,
    '--allow-empty',
    '--no-verify',
  ]);
  return (await git(workDir, ['rev-parse', 'HEAD'])).trim();
}

/** Push session branch and open (or find) a draft PR. */
export async function pushAndCreatePr(cfg: PushConfig): Promise<{ branch: string; prUrl?: string }> {
  const branch = branchName(cfg.sessionId);
  const origin = (await git(cfg.workDir, ['remote', 'get-url', 'origin'])).trim();
  if (cfg.pat) {
    await git(cfg.workDir, ['remote', 'set-url', 'origin', authUrl(origin, cfg.pat)]);
  }
  await git(cfg.workDir, ['push', '-u', 'origin', branch]);

  if (!cfg.pat || !cfg.repoFullName) return { branch };
  const prUrl = await createDraftPr(cfg.pat, cfg.repoFullName, branch, cfg.base ?? 'main');
  return { branch, ...(prUrl ? { prUrl } : {}) };
}

async function createDraftPr(
  pat: string,
  repoFullName: string,
  branch: string,
  base: string,
): Promise<string | undefined> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${pat}`,
    accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'content-type': 'application/json',
  };
  const res = await fetch(`https://api.github.com/repos/${repoFullName}/pulls`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: `PocketAgent session ${branch}`,
      head: branch,
      base,
      draft: true,
    }),
  });
  if (res.status === 201) {
    const json = (await res.json()) as unknown as { html_url?: string };
    return json.html_url;
  }
  if (res.status === 409 || res.status === 422) {
    const [owner, ...rest] = repoFullName.split('/');
    const repo = rest.join('/');
    const list = await fetch(
      `https://api.github.com/repos/${repoFullName}/pulls?head=${owner}:${branch}&state=open`,
      { headers },
    );
    if (list.ok) {
      const pulls = (await list.json()) as unknown as Array<{ html_url?: string }>;
      return pulls[0]?.html_url;
    }
    return undefined;
  }
  throw new Error(`draft PR failed: HTTP ${res.status}`);
}

/** Uncommitted changes vs HEAD: tracked via `git diff HEAD`, untracked synthesized. */
export async function getDiff(workDir: string): Promise<DiffEntry[]> {
  const entries: DiffEntry[] = [];
  const statusOut = await git(workDir, ['status', '--porcelain=v1', '-z']);
  const tokens = statusOut.split('\0');
  const untracked: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const xy = token.slice(0, 2);
    const p = token.slice(3);
    const isRename = xy.includes('R') || xy.includes('C');
    if (isRename) i++;
    if (xy === '??' && !p.endsWith('/')) untracked.push(p);
  }

  let diffOut = '';
  try {
    diffOut = await git(workDir, ['diff', 'HEAD']);
  } catch {
    diffOut = '';
  }
  for (const chunk of diffOut.split('diff --git ').slice(1)) {
    const entry = parseDiffChunk(chunk);
    if (entry) entries.push(entry);
  }
  for (const p of untracked) {
    entries.push(await untrackedEntry(workDir, p));
  }
  return entries;
}

function unquote(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

function parseDiffChunk(chunk: string): DiffEntry | null {
  const plus = chunk.match(/^\+\+\+ b\/(.+)$/m);
  const minus = chunk.match(/^--- a\/(.+)$/m);
  let rel: string | undefined;
  if (plus?.[1]) rel = unquote(plus[1]);
  else if (minus?.[1]) rel = unquote(minus[1]);
  else {
    const head = chunk.match(/^a\/(.*) b\/(.*)$/m);
    if (head?.[2]) rel = unquote(head[2]);
  }
  if (!rel) return null;
  if (/^GIT binary patch/m.test(chunk) || /^Binary files .* differ/m.test(chunk)) {
    return { path: rel, patch: '', binary: true };
  }
  return { path: rel, patch: `diff --git ${chunk}`.trimEnd() };
}

async function untrackedEntry(workDir: string, rel: string): Promise<DiffEntry> {
  const full = path.join(workDir, rel);
  const stat = await fs.stat(full).catch(() => undefined);
  if (!stat?.isFile()) return { path: rel, patch: '', binary: true };
  const buf = await fs.readFile(full);
  if (buf.length > 1_000_000 || buf.subarray(0, 8000).includes(0)) {
    return { path: rel, patch: '', binary: true };
  }
  const lines = buf.toString('utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const body = lines.map((l) => `+${l}`).join('\n');
  return {
    path: rel,
    patch: `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${body}`,
  };
}
