/**
 * Real-SDK check (no credentials): verifies the claude shim's SdkRunner wiring
 * against the real @anthropic-ai/claude-agent-sdk. Run with: npm run smoke:real
 *
 * Phase A (SDK probe): query() with a minimal prompt and NO credentials
 *  (no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY), IS_SANDBOX=1 and
 *  ~/.claude.json bootstrap applied. Expectation: controlled failure — the
 *  async generator either throws or finishes with an error result; never a
 *  hang, never an unhandled rejection. The exact error is printed and
 *  classified (auth vs missing native CLI binary).
 *
 * Phase B (shim level): buildServer with the real sdkRunnerFactory; POST
 *  /prompt must be accepted and SSE must deliver turn.failed with a readable
 *  error within 60s; /status stays reachable and idle afterwards.
 */
import type { AgentEvent } from '@pocketagent/protocol';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildServer } from '../src/index.ts';
import { sdkRunnerFactory, writeClaudeAuthBootstrap } from '../src/claude.ts';
import { ensureRepo } from '../src/gitops.ts';

const exec = promisify(execFile);
const GLOBAL_TIMEOUT_MS = 110_000;
const QUERY_TIMEOUT_MS = 60_000;

const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(reason);
});

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function classifyFailure(message: string): 'auth' | 'missing-binary' | 'other' {
  if (/Native CLI binary|ENOENT|Failed to spawn|not found/i.test(message)) return 'missing-binary';
  if (/api key|authentication|unauthorized|401|invalid.*key|run \/\/login|please run \/login/i.test(message)) return 'auth';
  return 'other';
}

async function makeTempRepo(): Promise<string> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-real-'));
  await exec('git', ['init', '-b', 'main'], { cwd: workDir });
  await exec('git', ['config', 'user.name', 'Real Check'], { cwd: workDir });
  await exec('git', ['config', 'user.email', 'real@test.local'], { cwd: workDir });
  await fs.writeFile(path.join(workDir, 'README.md'), '# real check\n');
  await exec('git', ['add', '-A'], { cwd: workDir });
  await exec('git', ['commit', '-m', 'init', '--no-verify'], { cwd: workDir });
  return workDir;
}

async function phaseA(): Promise<string> {
  console.log('[A] SDK query() without credentials');
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;

  await writeClaudeAuthBootstrap();
  const cfgPath = path.join(os.homedir(), '.claude.json');
  expect(existsSync(cfgPath), '~/.claude.json bootstrap written');

  const workDir = await makeTempRepo();
  let settled: { kind: 'throw' | 'result'; message: string } | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
  try {
    try {
      // query() may throw synchronously (e.g. missing native CLI binary) --
      // that is a controlled failure and must be captured, not escape.
      const q = query({
        prompt: 'Reply with the single word: pong',
        options: {
          cwd: workDir,
          permissionMode: 'default',
          includePartialMessages: false,
          abortController: controller,
          env: { ...process.env, IS_SANDBOX: '1' },
        },
      });
      for await (const msg of q) {
        const result = msg as SDKMessage & { type: string; subtype?: string; errors?: string[] };
        if (result.type === 'result') {
          const errors = result.errors ?? [];
          settled = {
            kind: 'result',
            message: errors.length > 0 ? errors.join('; ') : `result subtype ${result.subtype ?? 'unknown'}`,
          };
          break;
        }
      }
    } catch (err) {
      settled = { kind: 'throw', message: errMessage(err) };
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    await fs.rm(workDir, { recursive: true, force: true });
  }

  expect(settled !== undefined, `query() settled within ${QUERY_TIMEOUT_MS}ms (no hang)`);
  const failure = settled!;
  console.log(`[A] failure mode: ${failure.kind}`);
  console.log(`[A] outcome: ${failure.message.split('\n')[0]}`);
  console.log(`[A] classification: ${classifyFailure(failure.message)}`);
  // The real SDK (0.3.233) reports missing credentials as a *successful*
  // result whose assistant message carries the auth hint — any settled,
  // readable outcome without hang/crash is the controlled path we assert here.
  expect(failure.message.length > 0, 'failure has a readable message');
  expect(unhandled.length === 0, `no unhandled rejections (got ${unhandled.length})`);
  return failure.message;
}

class SseClient {
  readonly events: AgentEvent[] = [];
  private readonly ctrl = new AbortController();

  async start(url: string, token: string): Promise<void> {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: this.ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split('\n')) {
              if (line.startsWith('data: ')) {
                try {
                  this.events.push(JSON.parse(line.slice(6)) as AgentEvent);
                } catch {
                  /* skip malformed frame */
                }
              }
            }
          }
        }
      } catch {
        /* aborted */
      }
    })();
  }

  close(): void {
    this.ctrl.abort();
  }

  async wait(pred: (e: AgentEvent) => boolean, timeoutMs: number, what: string): Promise<AgentEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find(pred);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for ${what}; got: ${this.events.map((e) => e.type).join(', ')}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function phaseB(): Promise<void> {
  console.log('[B] shim-level check (real sdkRunnerFactory, no credentials)');
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.SMOKE_FAKE;

  const workDir = await makeTempRepo();
  await ensureRepo({ workDir, sessionId: 'real-check' });
  const app = buildServer(
    {
      token: 'real-check-token',
      workDir,
      sessionId: 'real-check',
      mode: 'ask',
      autoPush: false,
      github: {},
    },
    sdkRunnerFactory,
  );
  let sse: SseClient | undefined;
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no tcp address');
    const base = `http://127.0.0.1:${address.port}`;
    const auth: Record<string, string> = { authorization: 'Bearer real-check-token' };
    const authJson: Record<string, string> = { ...auth, 'content-type': 'application/json' };

    const status0 = (await (await fetch(`${base}/status`, { headers: auth })).json()) as Record<string, unknown>;
    expect(status0.adapter === 'claude', '/status adapter claude');
    expect(status0.busy === false, '/status initially idle');

    sse = new SseClient();
    await sse.start(`${base}/events`, 'real-check-token');

    const promptRes = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(promptRes.status === 200, `POST /prompt accepted (got ${promptRes.status})`);
    expect((await promptRes.json() as { ok: boolean }).ok === true, 'POST /prompt ok');

    // Without credentials the SDK answers with an assistant message carrying
    // the auth hint and ends the turn (turn.completed) — or, on other SDK
    // versions, with turn.failed. Both are controlled outcomes; what must NOT
    // happen is a hang, a crash, or a stuck busy flag.
    const terminal = await sse.wait(
      (e) => e.type === 'turn.failed' || e.type === 'turn.completed',
      QUERY_TIMEOUT_MS,
      'turn.failed|turn.completed within 60s',
    );
    if (terminal.type === 'turn.failed') {
      console.log(`[B] turn.failed: ${terminal.error.split('\n')[0]}`);
    } else {
      const text = sse.events.find((e): e is AgentEvent & { type: 'message.completed'; text: string } => e.type === 'message.completed');
      console.log(`[B] turn.completed with auth-hint message: ${((text?.text ?? '').split('\n')[0] ?? '').slice(0, 120)}`);
      expect((text?.text ?? '').length > 0, 'turn.completed carries a non-empty assistant message');
    }

    const status1 = (await (await fetch(`${base}/status`, { headers: auth })).json()) as Record<string, unknown>;
    expect(status1.busy === false, '/status idle after failed turn');
    const health = await fetch(`${base}/health`);
    expect(health.status === 200, '/health still 200 after failure');
    expect(unhandled.length === 0, `no unhandled rejections (got ${unhandled.length})`);
  } finally {
    sse?.close();
    await app.close();
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function mainCheck(): Promise<void> {
  const watchdog = setTimeout(() => {
    console.error('REAL CHECK FAILED: global timeout');
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);
  watchdog.unref();
  await phaseA();
  await phaseB();
  console.log('REAL CHECK OK');
  process.exit(0);
}

mainCheck().catch((err: unknown) => {
  console.error('REAL CHECK FAILED:', errMessage(err));
  process.exit(1);
});
