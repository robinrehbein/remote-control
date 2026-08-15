#!/usr/bin/env node
/**
 * PocketAgent pi-shim standalone push helper.
 * Commits dirty state, pushes the agent branch and opens a draft PR.
 * Best-effort: always exits 0, failures are logged to stderr (secrets redacted).
 *
 * Env: WORK_DIR, SESSION_ID, GITHUB_PAT, REPO_FULL_NAME, REPO_BRANCH (base, default main)
 */
import { spawnSync } from 'node:child_process';

const workDir = process.env.WORK_DIR || process.cwd();
const sessionId = process.env.SESSION_ID || 'unknown-session';
const pat = process.env.GITHUB_PAT || '';
const fullName = process.env.REPO_FULL_NAME || '';
const base = process.env.REPO_BRANCH || 'main';
const branch = `agent/${sessionId}`;

function git(args) {
  const result = spawnSync('git', args, { cwd: workDir, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    out: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

function redact(text) {
  return pat ? text.split(pat).join('***') : text;
}

function log(message) {
  process.stderr.write(`[push] ${redact(message)}\n`);
}

function injectPat(url) {
  if (!pat) return url;
  return url.replace(/^(https:\/\/)(?:[^/@]+@)?([^/]+)/, `$1x-access-token:${pat}@$2`);
}

function stripPat(url) {
  return url.replace(/^(https:\/\/)[^/@]+@/, '$1');
}

async function main() {
  const status = git(['status', '--porcelain']);
  if (!status.ok) {
    log('git status failed');
    return;
  }
  if (status.out) {
    if (!git(['add', '-A']).ok) {
      log('git add failed');
      return;
    }
    const commit = git(['commit', '-m', `agent: turn ${new Date().toISOString()}`, '--allow-empty', '--no-verify']);
    if (!commit.ok) {
      log('git commit failed');
      return;
    }
    log('committed dirty state');
  }

  const remote = git(['remote', 'get-url', 'origin']);
  if (!remote.ok || !remote.out) {
    log('no origin remote configured; skipping push');
    return;
  }
  const push = git(['push', injectPat(stripPat(remote.out)), `HEAD:refs/heads/${branch}`]);
  if (!push.ok) {
    log(`push failed: ${push.out}`);
    return;
  }
  log(`pushed ${branch}`);

  if (!pat || !fullName) {
    log('GITHUB_PAT/REPO_FULL_NAME not set; skipping draft PR');
    return;
  }
  try {
    const response = await fetch(`https://api.github.com/repos/${fullName}/pulls`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${pat}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({
        title: `PocketAgent session ${sessionId}`,
        head: branch,
        base,
        draft: true,
      }),
    });
    if (response.ok) {
      const data = await response.json();
      log(`draft PR: ${data.html_url}`);
    } else if (response.status === 409 || response.status === 422) {
      log('draft PR already exists');
    } else {
      const text = await response.text();
      log(`draft PR failed: HTTP ${response.status} ${text.slice(0, 300)}`);
    }
  } catch (error) {
    log(`draft PR failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

main().then(() => process.exit(0));
