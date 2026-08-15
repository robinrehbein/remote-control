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
import { mkdtempSync, rmSync } from 'node:fs';
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

function runCli(cliEntry: string, args: string[], stdinData?: string): Promise<CliResult> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [cliEntry, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
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
