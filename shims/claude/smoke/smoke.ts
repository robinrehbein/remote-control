/**
 * Smoke test for the claude shim. Runs the real fastify server + session
 * orchestration against a FakeRunner (no SDK, no credentials) and a temp
 * git repo. Verifies: SSE event normalization, permission flow over
 * /permissions/:id, auto-commit per turn, /diff, /status, auth.
 */
import type { AgentEvent } from '@pocketagent/protocol';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { buildServer } from '../src/index.ts';
import { fakeRunnerFactory } from './fakerunner.ts';

const exec = promisify(execFile);

class SseClient {
  readonly events: AgentEvent[] = [];
  private readonly ctrl = new AbortController();

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async start(): Promise<void> {
    const res = await fetch(this.url, {
      headers: { authorization: `Bearer ${this.token}` },
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

  seen(pred: (e: AgentEvent) => boolean): boolean {
    return this.events.some(pred);
  }

  async wait(pred: (e: AgentEvent) => boolean, timeoutMs = 10_000): Promise<AgentEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find(pred);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `timeout waiting for event; got: ${this.events.map((e) => e.type).join(', ')}`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

async function main(): Promise<void> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-shim-smoke-'));
  await git(workDir, ['init', '-b', 'main']);
  await git(workDir, ['config', 'user.name', 'Smoke Tester']);
  await git(workDir, ['config', 'user.email', 'smoke@test.local']);
  await fs.writeFile(path.join(workDir, 'app.txt'), 'hello\n');
  await git(workDir, ['add', '-A']);
  await git(workDir, ['commit', '-m', 'init']);

  const app = buildServer(
    {
      token: 'smoke-token',
      workDir,
      sessionId: 'smoke-session',
      mode: 'ask',
      autoPush: false,
      github: {},
    },
    fakeRunnerFactory,
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no tcp address');
  const base = `http://127.0.0.1:${address.port}`;
  const auth: Record<string, string> = { authorization: 'Bearer smoke-token' };
  const authJson: Record<string, string> = { ...auth, 'content-type': 'application/json' };
  let sse: SseClient | undefined;

  try {
    // auth
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { ok: boolean }).ok, true);

    const noAuth = await fetch(`${base}/status`);
    assert.equal(noAuth.status, 401);

    const status0 = (await (await fetch(`${base}/status`, { headers: auth })).json()) as Record<string, unknown>;
    assert.equal(status0.adapter, 'claude');
    assert.equal(status0.provider, 'anthropic');
    assert.equal(status0.mode, 'ask');
    assert.equal(status0.busy, false);

    // SSE
    sse = new SseClient(`${base}/events`, 'smoke-token');
    await sse.start();

    // prompt triggers fake turn incl. permission gate
    const promptRes = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({ text: 'hello', mode: 'ask' }),
    });
    assert.equal(promptRes.status, 200);
    assert.equal((await promptRes.json() as { ok: boolean }).ok, true);

    const permReq = await sse.wait((e) => e.type === 'permission.request');
    assert.equal(permReq.type, 'permission.request');
    if (permReq.type !== 'permission.request') throw new Error('unreachable');
    assert.equal(permReq.kind, 'bash');
    assert.ok(permReq.title.includes('npm test'));
    const permissionId = permReq.permissionId;

    // unknown id -> 404, then the real one resolves the callback
    const badPerm = await fetch(`${base}/permissions/not-a-perm`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({ response: 'once' }),
    });
    assert.equal(badPerm.status, 404);

    const permReply = await fetch(`${base}/permissions/${permissionId}`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({ response: 'once' }),
    });
    assert.equal(permReply.status, 200);

    const completed = await sse.wait((e) => e.type === 'turn.completed');
    assert.equal(completed.type, 'turn.completed');
    if (completed.type !== 'turn.completed') throw new Error('unreachable');
    assert.ok(sse.seen((e) => e.type === 'message.delta' && e.delta === 'Hel'));
    assert.ok(sse.seen((e) => e.type === 'message.delta' && e.delta === 'lo'));
    assert.ok(sse.seen((e) => e.type === 'message.completed' && e.text === 'Hello hello'));
    const toolCall = sse.events.find((e) => e.type === 'tool.call');
    assert.ok(toolCall !== undefined && toolCall.type === 'tool.call');
    assert.equal(toolCall.tool, 'Bash');
    assert.equal((toolCall.input as { command?: string }).command, 'npm test');
    assert.ok(sse.seen((e) => e.type === 'tool.result' && e.output.includes('allow')));
    assert.ok(sse.seen((e) => e.type === 'permission.resolved' && e.decision === 'once'));
    assert.equal(completed.usage?.input, 10);
    assert.equal(completed.usage?.output, 5);
    assert.equal(completed.usage?.costUsd, 0.01);
    assert.match(completed.commitSha ?? '', /^[0-9a-f]{40}$/);

    // auto-commit happened
    const commitCount = (await git(workDir, ['rev-list', '--count', 'HEAD'])).trim();
    assert.ok(Number(commitCount) >= 2, 'expected auto-commit after turn');

    // diff: modified tracked file + untracked file
    await fs.writeFile(path.join(workDir, 'app.txt'), 'hello\nworld\n');
    await fs.writeFile(path.join(workDir, 'new.txt'), 'brand new\n');
    const diffRes = await fetch(`${base}/diff`, { headers: auth });
    assert.equal(diffRes.status, 200);
    const diff = (await diffRes.json()) as Array<{ path: string; patch: string }>;
    const appEntry = diff.find((d) => d.path === 'app.txt');
    assert.ok(appEntry, 'app.txt in diff');
    assert.ok(appEntry.patch.includes('+world'));
    const newEntry = diff.find((d) => d.path === 'new.txt');
    assert.ok(newEntry, 'untracked new.txt in diff');
    assert.ok(newEntry.patch.includes('+brand new'));

    // status after turn
    const status1 = (await (await fetch(`${base}/status`, { headers: auth })).json()) as Record<string, unknown>;
    assert.equal(status1.sessionRef, 'fake-session-1');
    assert.equal(status1.busy, false);
    assert.equal(status1.mode, 'ask');

    // abort + resume
    const abortRes = await fetch(`${base}/abort`, { method: 'POST', headers: auth });
    assert.equal((await abortRes.json() as { ok: boolean }).ok, true);

    const resumeRes = await fetch(`${base}/resume`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({ sessionRef: 'fake-2' }),
    });
    assert.equal((await resumeRes.json() as { ok: boolean }).ok, true);
    const status2 = (await (await fetch(`${base}/status`, { headers: auth })).json()) as Record<string, unknown>;
    assert.equal(status2.sessionRef, 'fake-2');

    // validation
    const badPrompt = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({ text: '' }),
    });
    assert.equal(badPrompt.status, 400);
    const badPermBody = await fetch(`${base}/permissions/${permissionId}`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({ response: 'maybe' }),
    });
    assert.equal(badPermBody.status, 400);

    sse.close();
    console.log('SMOKE OK');
    process.exit(0);
  } finally {
    sse?.close();
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
