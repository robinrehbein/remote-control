#!/usr/bin/env node
/**
 * Standalone tap-push for the orchestrator (entry override: `node /app/scripts/push.js`).
 * Commits dirty worktree, pushes the agent branch and ensures a draft PR.
 * Best effort: never exits non-zero.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const workDir = process.env.WORK_DIR ?? '/work';
const sessionId = process.env.SESSION_ID ?? 'unknown-session';
const pat = process.env.GITHUB_PAT;
const repoUrl = process.env.REPO_URL ?? '';
const repoFullName = process.env.REPO_FULL_NAME ?? '';
const baseBranch = process.env.REPO_BRANCH ?? 'main';
const branch = `agent/${sessionId}`;

const sanitize = (url) => url.replace(/:\/\/[^@/\s]+@/, '://***@');
const authUrl = (url) => (pat ? url.replace(/^https:\/\//, `https://x-access-token:${encodeURIComponent(pat)}@`) : url);

async function git(...args) {
  return exec('git', args, { cwd: workDir, maxBuffer: 32 * 1024 * 1024 });
}

async function ensureDraftPr() {
  if (!pat || !repoFullName) {
    console.log('[push] GITHUB_PAT or REPO_FULL_NAME missing, skipping draft PR');
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
    const { stdout } = await git('status', '--porcelain');
    if (stdout.trim().length > 0) {
      await git('add', '-A');
      await git('commit', '-m', `agent: turn ${new Date().toISOString()}`, '--no-verify');
      console.log('[push] committed pending changes');
    } else {
      console.log('[push] worktree clean, nothing to commit');
    }
  } catch (err) {
    console.warn(`[push] commit skipped: ${err.message}`);
  }

  try {
    if (!repoUrl) throw new Error('REPO_URL not set');
    if (!pat) throw new Error('GITHUB_PAT not set');
    await git('push', authUrl(repoUrl), `HEAD:refs/heads/${branch}`);
    console.log(`[push] pushed ${sanitize(repoUrl)} -> ${branch}`);
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
