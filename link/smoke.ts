/**
 * Smoke test for the link agent's protocol layer (agent.ts):
 *   fake orchestrator (WS server, in-process) <-> startLinkAgent()
 *                                                    -> fake pi-runner (buildApp + FakeRunner)
 *
 * Deliberately does NOT spin up the real server/ (still pre-G1.2, multi-
 * adapter) or a real pi-runner with provider credentials: embedding the real
 * RealPiRunner without an API key does not fail fast, it hangs inside the SDK
 * (verified by hand while building this test) - exactly why runner's own
 * smoke.ts (runner/smoke/smoke.ts) drives buildApp() with FakeRunner instead
 * of main(). This smoke reuses that same FakeRunner (runner/smoke/fake.ts)
 * so it can prove the link agent's WS/reconnect/heartbeat/command-proxy
 * plumbing end to end without any provider key, exactly as GREENFIELD-PI.md's
 * G1.4 verification calls for.
 *
 * Covers:
 *   - agent.hello (protocolVersion 2, capabilities.heartbeat) on connect
 *   - agent.heartbeat full-state snapshot on its own cadence
 *   - agent.command -> POST /prompt on the embedded runner -> agent.response
 *     + the resulting AgentEvents flowing back as agent.event
 *   - an abnormal close (1006) triggers a reconnect (fresh agent.hello)
 *   - a terminal close (4001, WS_CLOSE_UNAUTHORIZED) ends the loop for good
 *     and cleanly closes the embedded runner (no further agent.hello)
 *
 * Run: npm run smoke -w link   (from repo root; needs `npm install` in both
 * the repo root and runner/ - see runner-embed.ts)
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import type { AgentEvent } from '@pocketagent/protocol';
import { LINK_PROTOCOL_VERSION, WS_CLOSE_UNAUTHORIZED } from '@pocketagent/protocol';
import { buildApp, type ShimConfig } from '../runner/src/index.js';
import { EventBroadcaster } from '../runner/src/events.js';
import { FakeRunner } from '../runner/smoke/fake.js';
import { startLinkAgent, type EmbeddedRunner, type LinkAgentHandle } from './src/agent.js';

const exec = promisify(execFile);
const GLOBAL_TIMEOUT_MS = 120_000;
const LINK_TOKEN = `smoke-link-${randomBytes(8).toString('hex')}`;
const FAKE_SESSION_ID = 'fake-session-1';

function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function waitFor<T>(getter: () => T | undefined, what: string, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      const value = getter();
      if (value !== undefined) {
        resolvePromise(value);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timeout waiting for ${what}`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

/** Loose shape for whatever the link agent sends us - both directions of the
 * agent.* union share one JSON envelope, see protocol's ServerMessage comment. */
interface Envelope {
  type: string;
  [key: string]: unknown;
}

interface FakeConn {
  ws: WebSocket;
  messages: Envelope[];
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'link-smoke-work-'));
  const agentDir = mkdtempSync(join(tmpdir(), 'link-smoke-agent-'));
  const sessionDir = mkdtempSync(join(tmpdir(), 'link-smoke-sessions-'));

  // Real git repo, because the (fake-runner-driven) buildApp still shells out
  // to real `git` for commitTurn/getDiff - only the agent turn itself is fake.
  await exec('git', ['init', '-b', 'main'], { cwd: workDir });
  await exec('git', ['config', 'user.name', 'LinkSmoke'], { cwd: workDir });
  await exec('git', ['config', 'user.email', 'link-smoke@test.local'], { cwd: workDir });
  writeFileSync(join(workDir, 'README.md'), '# link smoke\n');
  await exec('git', ['add', '-A'], { cwd: workDir });
  await exec('git', ['commit', '-m', 'init', '--no-verify'], { cwd: workDir });

  /* ---------------- fake pi-runner (buildApp + FakeRunner) ---------------- */

  const runnerToken = randomBytes(16).toString('hex');
  const config: ShimConfig = {
    port: 0, // unused by buildApp itself - only main()'s app.listen() reads it
    token: runnerToken,
    workDir,
    sessionId: FAKE_SESSION_ID,
    mode: 'auto',
    autoPush: false,
    agentDir,
    sessionDir,
    heartbeatMs: 60_000, // keep the runner's own SSE ping out of the way of the assertions below
    permissionTimeoutMs: 5_000,
    autoContinue: false,
  };
  const bus = new EventBroadcaster();
  bus.startHeartbeat(config.heartbeatMs);
  const fakeRunner = new FakeRunner({
    workDir,
    mode: config.mode,
    permissionTimeoutMs: config.permissionTimeoutMs,
    emit: (event) => bus.publish(event),
  });
  await fakeRunner.init();
  const runnerApp = buildApp({
    config,
    runner: fakeRunner,
    bus,
    gitCtx: { workDir, sessionId: config.sessionId },
    branch: `agent/${FAKE_SESSION_ID}`,
  });
  await runnerApp.listen({ port: 0, host: '127.0.0.1' });
  const runnerAddress = runnerApp.server.address() as AddressInfo;
  let fakeRunnerClosed = false;
  const fakeEmbeddedRunner: EmbeddedRunner = {
    port: runnerAddress.port,
    token: runnerToken,
    close: async () => {
      fakeRunnerClosed = true;
      bus.stop();
      await runnerApp.close();
    },
  };

  /* ---------------- fake orchestrator (WebSocketServer) ---------------- */

  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', r));
  const orchestratorPort = (wss.address() as AddressInfo).port;
  const orchestratorUrl = `ws://127.0.0.1:${orchestratorPort}`;

  const connections: FakeConn[] = [];
  wss.on('connection', (sock) => {
    const conn: FakeConn = { ws: sock, messages: [] };
    connections.push(conn);
    sock.on('message', (raw) => {
      let msg: Envelope;
      try {
        msg = JSON.parse(String(raw)) as Envelope;
      } catch {
        return;
      }
      conn.messages.push(msg);
      if (msg.type === 'agent.hello') {
        sock.send(JSON.stringify({ type: 'agent.ready', sessionId: FAKE_SESSION_ID }));
      } else if (msg.type === 'agent.ping') {
        // Ohne agent.pong hielte der Link seine eigene Verbindung irgendwann
        // für tot (siehe silentTimeoutMs in agent.ts) und würde sie
        // selbst kappen - das würde die Verbindungszählung unten verfälschen.
        sock.send(JSON.stringify({ type: 'agent.pong', ts: msg.ts }));
      }
    });
  });

  function latestConn(): FakeConn | undefined {
    return connections.at(-1);
  }

  /* ---------------- drive the link agent ---------------- */

  let terminalCode: number | undefined;
  const handle: LinkAgentHandle = startLinkAgent({
    server: orchestratorUrl,
    token: LINK_TOKEN,
    name: 'smoke-link',
    mode: 'ask',
    workDir,
    startRunner: async () => fakeEmbeddedRunner,
    intervals: {
      pingMs: 1_500,
      heartbeatMs: 1_000,
      silentTimeoutMs: 20_000,
      reconnectBaseMs: 300,
      reconnectMaxMs: 1_000,
      runnerStartRetryMs: 300,
    },
    log: (m) => console.log(`[smoke:link] ${m}`),
    onTerminal: (code) => {
      terminalCode = code;
    },
  });

  try {
    // --- agent.hello on first connect ---
    await waitFor(() => (connections.length >= 1 ? connections[0] : undefined), 'first connection');
    const hello = await waitFor(
      () => connections[0]?.messages.find((m) => m.type === 'agent.hello'),
      'agent.hello',
    );
    expect(hello.token === LINK_TOKEN, 'agent.hello carries PA_TOKEN');
    expect(hello.protocolVersion === LINK_PROTOCOL_VERSION, `agent.hello protocolVersion is ${LINK_PROTOCOL_VERSION}`);
    expect(
      (hello.capabilities as { heartbeat?: boolean } | undefined)?.heartbeat === true,
      'agent.hello announces heartbeat capability',
    );
    expect(hello.name === 'smoke-link', 'agent.hello carries PA_NAME');
    expect(hello.workDir === workDir, 'agent.hello carries PA_WORKDIR');

    // --- full-state heartbeat on its own cadence ---
    const heartbeat = await waitFor(
      () => connections[0]?.messages.find((m) => m.type === 'agent.heartbeat'),
      'agent.heartbeat',
      5_000,
    );
    expect(heartbeat.protocolVersion === LINK_PROTOCOL_VERSION, 'agent.heartbeat carries protocolVersion');
    const sessions = heartbeat.sessions as { sessionId: string; status: string }[];
    expect(sessions.length === 1 && sessions[0]?.sessionId === FAKE_SESSION_ID, 'heartbeat reports the bound session');

    // --- agent.command -> POST /prompt -> events flow back ---
    const conn1 = latestConn();
    expect(conn1 !== undefined, 'a connection is open before sending agent.command');
    conn1?.ws.send(
      JSON.stringify({
        type: 'agent.command',
        sessionId: FAKE_SESSION_ID,
        callId: 'call-1',
        path: '/prompt',
        method: 'POST',
        // auto mode: FakeRunner's canned bash call ('echo hello > hello.txt')
        // is not on the risky-bash list, so this completes without an
        // extra permission.request/permissions/:id round trip - the point
        // here is proving the command/event pipe, not the gating matrix
        // (that's covered by runner's own smoke.ts).
        body: { text: 'do the thing', mode: 'auto' },
      }),
    );
    const response = await waitFor(
      () => connections[0]?.messages.find((m) => m.type === 'agent.response' && m.callId === 'call-1'),
      'agent.response for call-1',
    );
    expect(response.status === 200, `agent.response status 200, got ${response.status}`);
    expect((response.body as { ok?: boolean } | undefined)?.ok === true, 'agent.response body.ok');

    const toolCall = await waitFor(
      () =>
        connections[0]?.messages.find(
          (m) => m.type === 'agent.event' && (m.event as AgentEvent).type === 'tool.call',
        ),
      'agent.event tool.call',
    );
    expect((toolCall.event as AgentEvent & { type: 'tool.call' }).tool === 'bash', 'tool.call event names the bash tool');

    const turnCompleted = await waitFor(
      () =>
        connections[0]?.messages.find(
          (m) => m.type === 'agent.event' && (m.event as AgentEvent).type === 'turn.completed',
        ),
      'agent.event turn.completed',
    );
    expect(turnCompleted.sessionId === FAKE_SESSION_ID, 'agent.event carries the bound sessionId');

    /* -------- abnormal close (1006) reconnects -------- */
    // 1006 is RFC 6455's reserved "no close frame received" code - it can
    // never be sent explicitly (`ws` rejects it), only observed by the peer
    // after the underlying socket dies without a handshake. terminate()
    // reproduces exactly that (unlike close(), which always completes a
    // clean handshake), which is what a real network drop looks like.
    connections[0]?.ws.terminate();
    await waitFor(() => (connections.length >= 2 ? connections[1] : undefined), 'reconnect after abnormal close', 10_000);
    await waitFor(
      () => connections[1]?.messages.find((m) => m.type === 'agent.hello'),
      'fresh agent.hello after reconnect',
      5_000,
    );
    console.log('[smoke] 1006 -> reconnected with a fresh agent.hello');

    /* -------- terminal close (4001) ends the loop for good -------- */
    const conn2 = latestConn();
    conn2?.ws.close(WS_CLOSE_UNAUTHORIZED, 'smoke: simulated revoked token');
    await waitFor(() => terminalCode, 'onTerminal callback after 4001', 10_000);
    expect(terminalCode === 1, `onTerminal reports exit code 1 for an unauthorized close, got ${terminalCode}`);
    expect(fakeRunnerClosed, 'the embedded runner was closed as part of the terminal shutdown');

    // No further reconnect attempt: give the (short, test-only) backoff a
    // few multiples of headroom and confirm the connection count is stable.
    const countAfterTerminal = connections.length;
    await sleep(2_000);
    expect(
      connections.length === countAfterTerminal,
      `no further connection after a terminal close (had ${countAfterTerminal}, now ${connections.length})`,
    );

    console.log('\nLINK SMOKE OK');
    process.exitCode = 0;
  } finally {
    await handle.shutdown().catch(() => {});
    if (!fakeRunnerClosed) await fakeEmbeddedRunner.close().catch(() => {});
    await new Promise<void>((r) => wss.close(() => r()));
    rmSync(workDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
}

const watchdog = setTimeout(() => {
  console.error('LINK SMOKE FAILED: global timeout');
  process.exit(1);
}, GLOBAL_TIMEOUT_MS);
watchdog.unref();

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error('LINK SMOKE FAILED:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
