/**
 * CLI smoke test: starts the orchestrator (docker disabled), pipes a fake
 * secret value into `pocketagent-secret openai` over stdin, and verifies
 * the server accepted it via POST /api/secrets.
 *
 * The server has local relative imports (./db.js -> db.ts, etc.) so it needs
 * tsx to run; the CLI itself is dependency-free and runs on plain `node`.
 *
 * Run: npm run smoke -w cli   (from repo root; needs workspace deps installed)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const GLOBAL_TIMEOUT_MS = 60_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') return rej(new Error('no port'));
      const { port } = addr;
      srv.close(() => res(port));
    });
  });
}

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCli(
  cliEntry: string,
  args: string[],
  stdinData?: string,
  env?: NodeJS.ProcessEnv,
): Promise<CliResult> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', rej);
    child.on('close', (code) => res({ stdout, stderr, code }));
    if (stdinData !== undefined) child.stdin.write(stdinData);
    child.stdin.end();
  });
}

interface PostedSecret {
  kind?: string;
  value?: string;
}

/** Minimal stand-in for POST /api/secrets that records what the CLI sent. */
function startSecretRecorder(posted: PostedSecret[]): Promise<{ url: string; close: () => void }> {
  return new Promise((res) => {
    const srv = http.createServer((req, response) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        try {
          posted.push(JSON.parse(body) as PostedSecret);
        } catch {
          posted.push({});
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ secret: { id: 'stub', kind: 'claude_oauth', createdAt: '2026-01-01T00:00:00Z' } }),
        );
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr !== null && typeof addr !== 'string' ? addr.port : 0;
      res({ url: `http://127.0.0.1:${port}`, close: () => srv.close() });
    });
  });
}

/** Writes a fake `claude` onto PATH that prints `stdout` and exits 0. */
function fakeClaudeEnv(dir: string, stdout: string): NodeJS.ProcessEnv {
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\ncat <<'PA_EOF'\n${stdout}\nPA_EOF\n`, { mode: 0o755 });
  return { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` };
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'cli-smoke-data-'));
  const port = await freePort();
  const adminToken = 'smoke-admin-token';
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;

  try {
    const tsx = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
    server = spawn(process.execPath, [tsx, 'src/index.ts'], {
      cwd: resolve(repoRoot, 'server'),
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dataDir,
        DOCKER_ENABLED: '0',
        PAIRING_ADMIN_TOKEN: adminToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (c: Buffer) => process.stdout.write(`[server] ${c}`));
    server.stderr?.on('data', (c: Buffer) => process.stderr.write(`[server:err] ${c}`));

    let healthy = false;
    const deadline = Date.now() + 30_000;
    while (!healthy && Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
        healthy = res.ok;
      } catch {
        healthy = false;
      }
      if (!healthy) await sleep(300);
    }
    expect(healthy, 'server healthy');

    // wrong token -> 401
    const unauthorized = await fetch(`${base}/api/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify({ kind: 'openai', value: 'x' }),
    });
    expect(unauthorized.status === 401, `wrong token rejected (got ${unauthorized.status})`);

    // CLI happy path: value piped via stdin
    const cliEntry = resolve(here, 'src/index.ts');
    const result = await runCli(
      cliEntry,
      ['openai', '--url', base, '--token', adminToken],
      'sk-smoke-test-value\n',
    );
    expect(result.code === 0, `cli exit 0 (stderr: ${result.stderr})`);
    expect(result.stdout.includes('✓ openai'), `cli success marker present: ${result.stdout}`);

    // invalid kind -> non-zero exit, no server round trip needed
    const badKind = await runCli(cliEntry, ['Not Valid', '--url', base, '--token', adminToken], 'x\n');
    expect(badKind.code !== 0, 'invalid kind rejected by cli');

    // `claude setup-token`: the token is recognized by pattern, so a trailing
    // hint line never ends up in the vault; no match at all aborts instead.
    const posted: PostedSecret[] = [];
    const recorder = await startSecretRecorder(posted);
    const binDir = mkdtempSync(join(tmpdir(), 'cli-smoke-bin-'));
    try {
      const okEnv = fakeClaudeEnv(
        binDir,
        [
          'Anmeldung im Browser abgeschlossen.',
          'sk-ant-oat01-SMOKEabcdefghijklmnopqrstuvwx',
          'Kopiere den Token in deine Umgebung.',
        ].join('\n'),
      );
      const claudeOk = await runCli(
        cliEntry,
        ['claude', '--url', recorder.url, '--token', adminToken],
        undefined,
        okEnv,
      );
      expect(claudeOk.code === 0, `claude flow exits 0 (stderr: ${claudeOk.stderr})`);
      expect(posted.length === 1, `exactly one secret posted (got ${posted.length})`);
      expect(posted[0]?.kind === 'claude_oauth', 'claude is stored as kind claude_oauth');
      expect(
        posted[0]?.value === 'sk-ant-oat01-SMOKEabcdefghijklmnopqrstuvwx',
        `token taken from the sk-ant line, not the trailing footer (got ${String(posted[0]?.value)})`,
      );

      const badEnv = fakeClaudeEnv(binDir, 'Anmeldung fehlgeschlagen, bitte erneut versuchen.');
      const claudeBad = await runCli(
        cliEntry,
        ['claude', '--url', recorder.url, '--token', adminToken],
        undefined,
        badEnv,
      );
      expect(claudeBad.code !== 0, 'output without a token aborts instead of storing garbage');
      expect(posted.length === 1, 'nothing posted when no token could be extracted');
    } finally {
      recorder.close();
      rmSync(binDir, { recursive: true, force: true });
    }

    console.log('\nCLI SMOKE OK');
  } finally {
    server?.kill('SIGTERM');
    await sleep(300);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const watchdog = setTimeout(() => {
  console.error('CLI SMOKE FAILED: global timeout');
  process.exit(1);
}, GLOBAL_TIMEOUT_MS);
watchdog.unref();

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('CLI SMOKE FAILED:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
