#!/usr/bin/env node
/**
 * Standalone tap-push for the orchestrator (entry override: `node /app/scripts/push.js`).
 * Commits dirty worktree, pushes the agent branch and ensures a draft PR.
 * Credentials are resolved from PA_CREDS_FILE (JSON { "githubPat": "..." }),
 * then the PA_CREDS env var (same JSON inline), then GITHUB_PAT. Git auth goes
 * through a GIT_ASKPASS helper so the PAT never appears in a remote URL,
 * .git/config, argv or logs.
 * Best effort: never exits non-zero.
 */
import { execFile } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const workDir = process.env.WORK_DIR ?? '/work';
const sessionId = process.env.SESSION_ID ?? 'unknown-session';
const repoUrl = process.env.REPO_URL ?? '';
const repoFullName = process.env.REPO_FULL_NAME ?? '';
const baseBranch = process.env.REPO_BRANCH ?? 'main';
const branch = `agent/${sessionId}`;

function parseCreds(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.githubPat === 'string' && parsed.githubPat.length > 0) return parsed.githubPat;
  } catch {
    // bad JSON -> fall through
  }
  return undefined;
}

function readGithubPat() {
  const credsPath = process.env.PA_CREDS_FILE ?? '/run/secrets/pa/creds.json';
  try {
    const fromFile = parseCreds(readFileSync(credsPath, 'utf8'));
    if (fromFile) return fromFile;
  } catch {
    // missing file -> fall through
  }
  if (typeof process.env.PA_CREDS === 'string') {
    const inline = parseCreds(process.env.PA_CREDS);
    if (inline) return inline;
  }
  const fromEnv = process.env.GITHUB_PAT;
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined;
}

const pat = readGithubPat();

const ASKPASS_SCRIPT = [
  '#!/bin/sh',
  'case "$1" in',
  '  Username*) echo "x-access-token" ;;',
  "  *) printf '%s' \"$PA_GIT_PAT\" ;;",
  'esac',
  '',
].join('\n');

function askpassEnv() {
  if (!pat) return undefined;
  const script = join(tmpdir(), `pocketagent-askpass-${process.pid}.sh`);
  try {
    writeFileSync(script, ASKPASS_SCRIPT, { mode: 0o700 });
    chmodSync(script, 0o700);
  } catch {
    // best effort
  }
  return { ...process.env, GIT_ASKPASS: script, GIT_TERMINAL_PROMPT: '0', PA_GIT_PAT: pat };
}

async function git(...args) {
  return exec('git', args, { cwd: workDir, maxBuffer: 32 * 1024 * 1024 });
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
    if (!pat) throw new Error('github PAT not available (PA_CREDS_FILE, PA_CREDS or GITHUB_PAT)');
    // plain URL; credentials flow through GIT_ASKPASS, never the URL
    await exec('git', ['push', repoUrl, `HEAD:refs/heads/${branch}`], {
      cwd: workDir,
      maxBuffer: 32 * 1024 * 1024,
      env: askpassEnv(),
    });
    console.log(`[push] pushed ${repoUrl} -> ${branch}`);
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
