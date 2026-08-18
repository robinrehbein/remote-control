#!/usr/bin/env node
/**
 * PocketAgent pi-shim standalone push helper.
 * Commits dirty state, pushes the agent branch and opens a draft PR.
 * Best-effort: always exits 0, failures are logged to stderr (secrets redacted).
 *
 * Credentials: PA_CREDS_FILE (default /run/secrets/pa/creds.json) JSON
 * {githubPat}, falling back to the GITHUB_PAT env var (link-agent mode).
 * git receives the PAT through a GIT_ASKPASS helper reading PA_GIT_PAT, so
 * the PAT never appears in remote URLs, .git/config, argv or logs.
 *
 * Env: WORK_DIR, SESSION_ID, PA_CREDS_FILE/GITHUB_PAT, REPO_FULL_NAME, REPO_BRANCH (base, default main)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { installEnvProxyDispatcher } from '@pocketagent/protocol';

// Same egress rule as the shim process itself (src/proxy.ts): node ignores
// HTTP_PROXY/HTTPS_PROXY on its own, and under network policy 'allowlist' this
// container has no other route to api.github.com. No log line here - stdout
// belongs to the JSON outcome the orchestrator parses.
installEnvProxyDispatcher(process.env, () => {
  setGlobalDispatcher(new EnvHttpProxyAgent());
});

const workDir = process.env.WORK_DIR || process.cwd();
const sessionId = process.env.SESSION_ID || 'unknown-session';
const pat = readGithubPat() || '';
const fullName = process.env.REPO_FULL_NAME || '';
const base = process.env.REPO_BRANCH || 'main';
const branch = `agent/${sessionId}`;

const ASKPASS_SCRIPT = [
  '#!/bin/sh',
  'case "$1" in',
  '  Username*) echo "x-access-token" ;;',
  '  *) printf \'%s\' "$PA_GIT_PAT" ;;',
  'esac',
  '',
].join('\n');

function readGithubPat() {
  const credsFile = process.env.PA_CREDS_FILE || '/run/secrets/pa/creds.json';
  try {
    const data = JSON.parse(readFileSync(credsFile, 'utf8'));
    if (data && typeof data.githubPat === 'string' && data.githubPat) return data.githubPat;
  } catch {
    /* missing or malformed creds file: fall through to env */
  }
  return process.env.GITHUB_PAT || '';
}

function askpassEnv() {
  if (!pat) return undefined;
  const helper = join(tmpdir(), `pocketagent-askpass-${process.pid}.sh`);
  writeFileSync(helper, ASKPASS_SCRIPT, { mode: 0o700 });
  return { ...process.env, GIT_ASKPASS: helper, GIT_TERMINAL_PROMPT: '0', PA_GIT_PAT: pat };
}

function git(args) {
  const result = spawnSync('git', args, { cwd: workDir, encoding: 'utf8', env: askpassEnv() });
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

/** Defensive: drop userinfo from a URL (e.g. legacy configs written by older versions). */
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
  // Plain URL push: credentials, when needed, are supplied by GIT_ASKPASS.
  const push = git(['push', stripPat(remote.out), `HEAD:refs/heads/${branch}`]);
  if (!push.ok) {
    log(`push failed: ${push.out}`);
    return;
  }
  log(`pushed ${branch}`);

  if (!pat || !fullName) {
    log('no GitHub PAT/REPO_FULL_NAME; skipping draft PR');
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
      log(`draft PR failed: HTTP ${response.status} ${redact(text.slice(0, 300))}`);
    }
  } catch (error) {
    log(`draft PR failed: ${redact(error instanceof Error ? error.message : String(error))}`);
  }
}

main().then(() => process.exit(0));
