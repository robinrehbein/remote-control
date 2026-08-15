#!/usr/bin/env node
/**
 * Standalone push script for orchestrator tap-push:
 * commit (if dirty) -> push session branch -> ensure draft PR.
 * Always exits 0; outcome is logged as JSON on stdout.
 *
 * Env: WORK_DIR, SESSION_ID, REPO_FULL_NAME, REPO_BRANCH (PR base),
 * PA_CREDS_FILE (default /run/secrets/pa/creds.json, JSON {"githubPat":...})
 * with GITHUB_PAT env as fallback. The PAT never lands in remote URLs,
 * .git/config, argv or logs: it reaches git via a GIT_ASKPASS helper.
 */
import { execFile } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const DEFAULT_CREDS_FILE = '/run/secrets/pa/creds.json';

const workDir = process.env.WORK_DIR ?? '/work';
const sessionId = process.env.SESSION_ID ?? 'local';
const repoFullName = process.env.REPO_FULL_NAME;
const base = process.env.REPO_BRANCH ?? 'main';
const branch = `agent/${sessionId}`;

function readGithubPat() {
  const credsFile = process.env.PA_CREDS_FILE || DEFAULT_CREDS_FILE;
  try {
    const parsed = JSON.parse(readFileSync(credsFile, 'utf8'));
    if (typeof parsed.githubPat === 'string' && parsed.githubPat.length > 0) {
      return parsed.githubPat;
    }
  } catch {
    /* missing or malformed creds file -> fall through to env */
  }
  return process.env.GITHUB_PAT || undefined;
}

function askpassEnv(pat) {
  if (!pat) return undefined;
  const scriptPath = path.join(os.tmpdir(), `pocketagent-askpass-${process.pid}.sh`);
  const script =
    '#!/bin/sh\n' +
    'case "$1" in\n' +
    '  Username*) echo "x-access-token" ;;\n' +
    '  *) printf \'%s\' "$PA_GIT_PAT" ;;\n' +
    'esac\n';
  try {
    writeFileSync(scriptPath, script, { mode: 0o700 });
    chmodSync(scriptPath, 0o700);
  } catch {
    return undefined;
  }
  return {
    ...process.env,
    GIT_ASKPASS: scriptPath,
    GIT_TERMINAL_PROMPT: '0',
    PA_GIT_PAT: pat,
  };
}

function sanitize(s) {
  return String(s ?? '').replace(/https:\/\/[^\s'"]+@/g, 'https://***@').slice(0, 500);
}

async function git(args, env) {
  try {
    const { stdout } = await exec('git', args, { cwd: workDir, env, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    throw new Error(sanitize(err.stderr || err.message));
  }
}

function stripUrlCredentials(url) {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
      return u.toString();
    }
  } catch {
    /* not a parseable URL */
  }
  return url;
}

async function ensureDraftPr(pat) {
  if (!pat || !repoFullName) return undefined;
  const headers = {
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
    const json = await res.json();
    return json.html_url;
  }
  if (res.status === 409 || res.status === 422) {
    const [owner, ...rest] = repoFullName.split('/');
    const list = await fetch(
      `https://api.github.com/repos/${repoFullName}/pulls?head=${owner}:${branch}&state=open`,
      { headers },
    );
    if (list.ok) {
      const pulls = await list.json();
      return pulls[0]?.html_url;
    }
    return undefined;
  }
  throw new Error(`draft PR failed: HTTP ${res.status}`);
}

try {
  const pat = readGithubPat();
  const status = await git(['status', '--porcelain']);
  let committed = false;
  if (status.trim()) {
    await git(['add', '-A']);
    await git(['commit', '-m', `agent: manual push ${new Date().toISOString()}`, '--no-verify']);
    committed = true;
  }
  const origin = (await git(['remote', 'get-url', 'origin'])).trim();
  const clean = stripUrlCredentials(origin);
  if (clean !== origin) {
    // Drop credentials possibly embedded by an older shim version.
    await git(['remote', 'set-url', 'origin', clean]);
  }
  await git(['push', '-u', 'origin', branch], askpassEnv(pat));
  const prUrl = await ensureDraftPr(pat);
  console.log(JSON.stringify({ ok: true, branch, committed, ...(prUrl ? { prUrl } : {}) }));
} catch (err) {
  console.error(`push.js: ${err.message}`);
  console.log(JSON.stringify({ ok: false, branch, error: err.message }));
}
process.exit(0);
