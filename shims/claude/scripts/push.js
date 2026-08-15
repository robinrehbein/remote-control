#!/usr/bin/env node
/**
 * Standalone push script for orchestrator tap-push:
 * commit (if dirty) -> push session branch -> ensure draft PR.
 * Always exits 0; outcome is logged as JSON on stdout.
 *
 * Env: WORK_DIR, SESSION_ID, GITHUB_PAT, REPO_FULL_NAME, REPO_BRANCH (PR base).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const workDir = process.env.WORK_DIR ?? '/work';
const sessionId = process.env.SESSION_ID ?? 'local';
const pat = process.env.GITHUB_PAT;
const repoFullName = process.env.REPO_FULL_NAME;
const base = process.env.REPO_BRANCH ?? 'main';
const branch = `agent/${sessionId}`;

function sanitize(s) {
  return String(s ?? '').replace(/https:\/\/[^\s'"]+@/g, 'https://***@').slice(0, 500);
}

async function git(args) {
  try {
    const { stdout } = await exec('git', args, { cwd: workDir, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    throw new Error(sanitize(err.stderr || err.message));
  }
}

function authUrl(url) {
  if (!pat) return url;
  try {
    const u = new URL(url);
    u.username = 'x-access-token';
    u.password = pat;
    return u.toString();
  } catch {
    return url;
  }
}

async function ensureDraftPr() {
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
  const status = await git(['status', '--porcelain']);
  let committed = false;
  if (status.trim()) {
    await git(['add', '-A']);
    await git(['commit', '-m', `agent: manual push ${new Date().toISOString()}`, '--no-verify']);
    committed = true;
  }
  const origin = (await git(['remote', 'get-url', 'origin'])).trim();
  if (pat) {
    await git(['remote', 'set-url', 'origin', authUrl(origin)]);
  }
  await git(['push', '-u', 'origin', branch]);
  const prUrl = await ensureDraftPr();
  console.log(JSON.stringify({ ok: true, branch, committed, ...(prUrl ? { prUrl } : {}) }));
} catch (err) {
  console.error(`push.js: ${err.message}`);
  console.log(JSON.stringify({ ok: false, branch, error: err.message }));
}
process.exit(0);
