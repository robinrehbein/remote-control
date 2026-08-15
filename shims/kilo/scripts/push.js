#!/usr/bin/env node
/**
 * Standalone tap-push for the orchestrator (entry override:
 * `node /app/shims/kilo/scripts/push.js`).
 * Commits dirty worktree, pushes the agent branch and ensures a draft PR.
 * Best effort: never exits non-zero.
 *
 * Credentials: the PAT comes from PA_CREDS_FILE (default
 * /run/secrets/pa/creds.json, JSON {"githubPat":"..."}) with GITHUB_PAT env as
 * fallback. Push uses the plain https URL plus a GIT_ASKPASS helper so the PAT
 * never appears in the remote URL, .git/config, argv or logs.
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const CREDS_FILE_DEFAULT = '/run/secrets/pa/creds.json';

const workDir = process.env.WORK_DIR ?? '/work';
const sessionId = process.env.SESSION_ID ?? 'unknown-session';
const repoUrl = process.env.REPO_URL ?? '';
const repoFullName = process.env.REPO_FULL_NAME ?? '';
const baseBranch = process.env.REPO_BRANCH ?? 'main';
const branch = `agent/${sessionId}`;

function readGithubPat() {
  const credsFile = process.env.PA_CREDS_FILE ?? CREDS_FILE_DEFAULT;
  try {
    const parsed = JSON.parse(readFileSync(credsFile, 'utf8'));
    if (parsed && typeof parsed.githubPat === 'string' && parsed.githubPat) return parsed.githubPat;
  } catch {
    // missing/unreadable/invalid creds file: fall through to the env fallback
  }
  return process.env.GITHUB_PAT || undefined;
}

const pat = readGithubPat();

function askpassEnv(token) {
  if (!token) return undefined;
  const path = join(tmpdir(), `pocketagent-askpass-${process.pid}.sh`);
  const script = '#!/bin/sh\ncase "$1" in\n  Username*) echo "x-access-token" ;;\n  *) printf \'%s\' "$PA_GIT_PAT" ;;\nesac\n';
  writeFileSync(path, script, { mode: 0o700 });
  return { ...process.env, GIT_ASKPASS: path, GIT_TERMINAL_PROMPT: '0', PA_GIT_PAT: token };
}

async function git(args, env) {
  return exec('git', args, { cwd: workDir, maxBuffer: 32 * 1024 * 1024, env });
}

async function ensureDraftPr() {
  if (!pat || !repoFullName) {
    console.log('[push] github PAT or REPO_FULL_NAME missing, skipping draft PR');
    return;
  }
  const api = `https://api.github.com/repos/${repoFullName}/pulls`;
  const headers = {
    authorization: `Bearer ${pat}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
    'user-agent': 'pocketagent-shim',
  };
  const create = await fetch(api, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: `PocketAgent session ${sessionId}`, head: branch, base: baseBranch, draft: true }),
  });
  if (create.ok) {
    const pr = await create.json();
    console.log(`[push] draft PR created: ${pr.html_url}`);
    return;
  }
  if (create.status === 409 || create.status === 422) {
    try {
      const owner = repoFullName.split('/')[0] ?? '';
      const list = await fetch(`${api}?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`, { headers });
      if (list.ok) {
        const arr = await list.json();
        const existing = arr[0];
        console.log(`[push] draft PR already exists${existing ? `: ${existing.html_url}` : ''}`);
        return;
      }
    } catch {
      // ignore
    }
    console.log('[push] draft PR already exists');
    return;
  }
  throw new Error(`draft PR create failed: HTTP ${create.status}`);
}

try {
  try {
    const { stdout } = await git(['status', '--porcelain']);
    if (stdout.trim().length > 0) {
      await git(['add', '-A']);
      await git(['commit', '-m', `agent: turn ${new Date().toISOString()}`, '--no-verify']);
      console.log('[push] committed pending changes');
    } else {
      console.log('[push] worktree clean, nothing to commit');
    }
  } catch (err) {
    console.warn(`[push] commit skipped: ${err.message}`);
  }

  try {
    if (!repoUrl) throw new Error('REPO_URL not set');
    const askpass = askpassEnv(pat);
    if (!askpass) throw new Error('github PAT not configured (PA_CREDS_FILE or GITHUB_PAT)');
    // plain https URL + GIT_ASKPASS: the PAT never reaches argv or .git/config
    await git(['push', repoUrl, `HEAD:refs/heads/${branch}`], askpass);
    console.log(`[push] pushed ${branch} via plain URL + GIT_ASKPASS`);
  } catch (err) {
    console.warn(`[push] push failed: ${err.message}`);
  }

  try {
    await ensureDraftPr();
  } catch (err) {
    console.warn(`[push] PR step failed: ${err.message}`);
  }
} finally {
  process.exit(0);
}
