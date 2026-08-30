import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
const SESSION_DIR_IGNORE = '.pi-sessions/';
const MAX_PATCH_BYTES = 64 * 1024;
const MAX_DIFF_FILES = 500;
const DEFAULT_CREDS_FILE = '/run/secrets/pa/creds.json';

/**
 * Resolve the GitHub PAT: PA_CREDS_FILE JSON ({githubPat}) first, then the
 * GITHUB_PAT env var (link-agent mode). Tolerates a missing or malformed file.
 */
export function readGithubPat(): string | undefined {
  const credsFile = process.env.PA_CREDS_FILE || DEFAULT_CREDS_FILE;
  try {
    const data: unknown = JSON.parse(readFileSync(credsFile, 'utf8'));
    if (typeof data === 'object' && data !== null) {
      const pat = (data as { githubPat?: unknown }).githubPat;
      if (typeof pat === 'string' && pat.length > 0) return pat;
    }
  } catch {
    /* missing or malformed creds file: fall through to env */
  }
  const envPat = process.env.GITHUB_PAT;
  return typeof envPat === 'string' && envPat.length > 0 ? envPat : undefined;
}

const ASKPASS_SCRIPT = [
  '#!/bin/sh',
  'case "$1" in',
  '  Username*) echo "x-access-token" ;;',
  '  *) printf \'%s\' "$PA_GIT_PAT" ;;',
  'esac',
  '',
].join('\n');

/**
 * Pfad des GIT_ASKPASS-Helfers, EINMAL pro Prozess in einem frisch angelegten,
 * nur für uns lesbaren Verzeichnis (mkdtempSync -> unvorhersagbarer Name, 0700).
 * Früher wurde die Datei bei JEDEM Aufruf unter einem festen, vorhersagbaren
 * Pfad (`/tmp/pocketagent-askpass-<pid>.sh`) neu geschrieben - ein anderer
 * Nutzer auf demselben Host hätte ihn vorab anlegen/verlinken können. Der Helfer
 * selbst trägt kein Geheimnis (der PAT kommt zur Laufzeit über PA_GIT_PAT).
 */
let askpassHelperPath: string | undefined;
function askpassHelper(): string {
  if (askpassHelperPath === undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'pocketagent-askpass-'));
    const helper = join(dir, 'askpass.sh');
    writeFileSync(helper, ASKPASS_SCRIPT, { mode: 0o700 });
    askpassHelperPath = helper;
  }
  return askpassHelperPath;
}

/**
 * Env for authenticated git child processes: a tiny GIT_ASKPASS helper hands
 * the PAT to git via the PA_GIT_PAT env var, so the PAT never appears in
 * remote URLs, .git/config, argv or logs (the script itself holds no secret).
 * Returns undefined when no PAT is configured (public or local remotes).
 */
export function askpassEnv(pat: string | undefined): NodeJS.ProcessEnv | undefined {
  if (!pat) return undefined;
  return {
    ...process.env,
    GIT_ASKPASS: askpassHelper(),
    GIT_TERMINAL_PROMPT: '0',
    PA_GIT_PAT: pat,
  };
}

export function redact(text: string, secret?: string): string {
  if (!secret) return text;
  return text.split(secret).join('***');
}

export function agentBranch(sessionId: string): string {
  return `agent/${sessionId}`;
}

/** Defensive: drop userinfo from a URL (e.g. legacy configs written by older versions). */
export function stripCredentials(url: string): string {
  return url.replace(/^(https:\/\/)[^/@]+@/, '$1');
}

async function git(cwd: string, args: string[], ctx: GitContext, timeoutMs = 120_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: askpassEnv(ctx.githubPat),
    });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(redact(`git ${args[0] ?? ''} failed: ${detail}`, ctx.githubPat));
  }
}

/**
 * Halte das pi-Session-Verzeichnis (.pi-sessions/) aus git heraus - über
 * `.git/info/exclude`, NICHT über die Repo-.gitignore. Eine Zeile in der
 * Repo-.gitignore wäre eine echte Änderung am Worktree und landete in jedem
 * Auto-Commit/PR ("agent: turn ..." mit einem .gitignore-Diff, das der Nutzer
 * nie wollte). `.git/info/exclude` wirkt genauso, berührt den Worktree aber nie.
 */
async function ensureGitIgnore(ctx: GitContext): Promise<void> {
  const excludePath = join(ctx.workDir, '.git', 'info', 'exclude');
  let current = '';
  if (existsSync(excludePath)) {
    current = await readFile(excludePath, 'utf8');
  }
  if (!current.split('\n').some(line => line.trim() === SESSION_DIR_IGNORE.trim())) {
    await mkdir(dirname(excludePath), { recursive: true });
    await appendFile(excludePath, current.length > 0 && !current.endsWith('\n') ? `\n${SESSION_DIR_IGNORE}` : SESSION_DIR_IGNORE);
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
      // Plain URL: auth (if any) flows through GIT_ASKPASS, never the URL.
      args.push(ctx.repoUrl, ctx.workDir);
      await git(dirname(ctx.workDir), args, ctx, 300_000);
    } else {
      await mkdir(ctx.workDir, { recursive: true });
      await git(ctx.workDir, ['init', '-b', ctx.repoBranch || 'main'], ctx);
      await git(ctx.workDir, ['config', 'user.name', GIT_USER_NAME], ctx);
      await git(ctx.workDir, ['config', 'user.email', GIT_USER_EMAIL], ctx);
      await ensureGitIgnore(ctx);
      await git(ctx.workDir, ['add', '-A'], ctx);
      await git(ctx.workDir, ['commit', '-m', 'init', '--allow-empty', '--no-verify'], ctx);
    }
  }
  await git(ctx.workDir, ['config', 'user.name', GIT_USER_NAME], ctx);
  await git(ctx.workDir, ['config', 'user.email', GIT_USER_EMAIL], ctx);
  await ensureGitIgnore(ctx);
  const existing = (await git(ctx.workDir, ['branch', '--list', branch], ctx)).trim().length > 0;
  await git(ctx.workDir, existing ? ['checkout', branch] : ['checkout', '-b', branch], ctx);
  return branch;
}

/** Gibt es im Worktree überhaupt etwas zu committen (tracked oder untracked)? */
export async function hasUncommittedChanges(ctx: GitContext): Promise<boolean> {
  return (await git(ctx.workDir, ['status', '--porcelain'], ctx)).trim().length > 0;
}

/**
 * Auto-commit nach einem beendeten Turn - aber NUR, wenn der Worktree wirklich
 * schmutzig ist. Früher lief jeder Turn mit `--allow-empty` und hinterließ pro
 * Turn einen Leer-Commit ("agent: turn ...") ohne jede Änderung; das blähte die
 * Historie und den PR-Diff auf. Bei einem sauberen Worktree wird nichts
 * committet und der aktuelle HEAD zurückgegeben.
 */
export async function commitTurn(ctx: GitContext, isoTimestamp: string): Promise<string> {
  if (await hasUncommittedChanges(ctx)) {
    await git(ctx.workDir, ['add', '-A'], ctx);
    await git(ctx.workDir, ['commit', '-m', `agent: turn ${isoTimestamp}`, '--no-verify'], ctx);
  }
  return (await git(ctx.workDir, ['rev-parse', 'HEAD'], ctx)).trim();
}

export async function pushBranch(ctx: GitContext, branch: string): Promise<void> {
  let remoteUrl = '';
  try {
    remoteUrl = stripCredentials((await git(ctx.workDir, ['remote', 'get-url', 'origin'], ctx)).trim());
  } catch {
    remoteUrl = ctx.repoUrl ?? '';
  }
  if (!remoteUrl) throw new Error('no remote configured for push');
  // Plain URL push: credentials, when needed, are supplied by GIT_ASKPASS.
  await git(ctx.workDir, ['push', remoteUrl, `HEAD:refs/heads/${branch}`], ctx, 300_000);
}

interface PullRequestResponse {
  html_url?: unknown;
}

/** Create a draft PR; returns undefined only when one already exists (409/422 with GitHub's "A pull request already exists" body). Every other 4xx/5xx throws. */
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
  const text = redact(await response.text(), ctx.githubPat);
  // "PR existiert schon" wird geschluckt (Auto-Push legt pro Turn erneut an) -
  // aber NUR daran erkennbar, nicht pauschal an 409/422: GitHub liefert 422 auch
  // für einen ungültigen Base-Branch, einen leeren Diff (no commits between ...)
  // oder ein nicht existierendes Head-Ref. Die würden sonst still verschluckt und
  // der Nutzer bekäme nie einen PR, ohne je einen Fehler zu sehen.
  if (
    (response.status === 409 || response.status === 422) &&
    text.includes('A pull request already exists')
  ) {
    return undefined;
  }
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

/** Zerlegt die Ausgabe eines `git diff` in ihre Pro-Datei-Blöcke (je ab `diff --git`). */
function splitDiffBlocks(out: string): string[] {
  if (out.trim().length === 0) return [];
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) blocks.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current.join('\n'));
  return blocks;
}

/** `--- a/x` / `+++ b/x` -> `x` (die a//b/-Präfixe strippen). */
function stripDiffPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/**
 * Dateipfad eines Diff-Blocks. Bevorzugt die `+++ b/…`-Zeile (bei Löschung
 * `/dev/null` -> stattdessen `--- a/…`); als letzter Ausweg der `diff --git`-
 * Header. `core.quotePath=false` (in getDiff gesetzt) hält Unicode-Pfade
 * unescaped, sodass diese Zeilen den vollen Pfad tragen.
 */
function pathFromBlock(lines: string[]): string | null {
  let aPath: string | null = null;
  let bPath: string | null = null;
  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') bPath = stripDiffPrefix(p);
    } else if (line.startsWith('--- ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') aPath = stripDiffPrefix(p);
    }
  }
  if (bPath) return bPath;
  if (aPath) return aPath;
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0] ?? '');
  return m ? m[2]! : null;
}

/**
 * Whole-session diff: tracked changes vs HEAD plus untracked files.
 *
 * Ein einziges `git diff HEAD` statt eines git-Spawns pro Datei (früher: erst
 * `status --porcelain`, dann je Pfad ein `diff HEAD -- <path>` - N+1 Prozesse
 * bei N geänderten Dateien). `--no-renames`, damit eine Umbenennung als
 * Löschung + Hinzufügung erscheint (stabile, einfach zu parsende Pfade statt
 * eines `rename from/to`-Headers). Untracked-Dateien zeigt `git diff HEAD` nicht
 * - die kommen wie bisher separat über `ls-files --others` als reine +-Patches.
 */
export async function getDiff(ctx: GitContext): Promise<DiffEntry[]> {
  const { workDir } = ctx;
  const diffOut = await git(workDir, ['-c', 'core.quotePath=false', 'diff', 'HEAD', '--no-renames'], ctx);
  const entries: DiffEntry[] = [];
  const seen = new Set<string>();

  for (const block of splitDiffBlocks(diffOut)) {
    const lines = block.split('\n');
    const path = pathFromBlock(lines);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    if (lines.some(line => line.startsWith('Binary files '))) {
      entries.push({ path, patch: '', binary: true });
    } else {
      entries.push({ path, patch: block.slice(0, MAX_PATCH_BYTES) });
    }
    if (entries.length >= MAX_DIFF_FILES) return entries;
  }

  const untrackedOut = await git(workDir, ['ls-files', '--others', '--exclude-standard', '-z'], ctx);
  const untrackedPaths = untrackedOut.split('\0').filter(path => path.length > 0);
  for (const path of untrackedPaths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const entry = await untrackedEntry(workDir, path);
    if (entry) entries.push(entry);
    if (entries.length >= MAX_DIFF_FILES) return entries;
  }
  return entries;
}
