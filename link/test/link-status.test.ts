/**
 * Unit tests for the link agent's relay robustness (W2.4, Kilo P2):
 *  (a) heartbeat status derivation - the pure state machine behind
 *      `agent.heartbeat`'s full-state snapshot.
 *  (b) terminal vs. transient WS close codes - which ones stop the
 *      reconnect loop for good vs. retry with the existing backoff.
 *
 * Run: npm run test -w link   (from repo root)
 */
import type { AgentEvent } from '@pocketagent/protocol';
import {
  WS_CLOSE_REPLACED,
  WS_CLOSE_TOO_MANY_CONNECTIONS,
  WS_CLOSE_UNAUTHORIZED,
  isTerminalLinkCloseCode,
} from '@pocketagent/protocol';
import { INITIAL_LINK_SESSION_STATUS, nextLinkSessionStatus } from '../src/link-status.js';

function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

/* ---------------- (a) heartbeat full-state status derivation ---------------- */

expect(INITIAL_LINK_SESSION_STATUS === 'idle', 'a link session starts idle before any event');

const statusEv = (busy: boolean): AgentEvent => ({ type: 'status', adapter: 'kilo', mode: 'ask', busy });

expect(nextLinkSessionStatus('idle', statusEv(true)) === 'busy', "a 'status' event with busy=true reports busy");
expect(nextLinkSessionStatus('busy', statusEv(false)) === 'idle', "a 'status' event with busy=false reports idle");

expect(
  nextLinkSessionStatus('idle', { type: 'permission.request', permissionId: 'p1', kind: 'bash', title: 'npm install' }) ===
    'permission',
  "'permission.request' reports permission",
);
expect(
  nextLinkSessionStatus('permission', { type: 'permission.resolved', permissionId: 'p1', decision: 'once' }) === 'busy',
  "'permission.resolved' returns to busy (the turn is still running)",
);

expect(
  nextLinkSessionStatus('busy', { type: 'turn.completed' }) === 'idle',
  "'turn.completed' always ends the turn, back to idle",
);
expect(
  nextLinkSessionStatus('busy', { type: 'turn.failed', error: 'boom' }) === 'idle',
  "'turn.failed' always ends the turn, back to idle",
);

expect(
  nextLinkSessionStatus('busy', { type: 'error', message: 'transient', fatal: false }) === 'busy',
  'a non-fatal error does not end the turn',
);
expect(
  nextLinkSessionStatus('busy', { type: 'error', message: 'boom', fatal: true }) === 'idle',
  'a fatal error ends the turn',
);

// Events with no bearing on liveness leave the status exactly as it was.
for (const ev of [
  { type: 'message.delta', role: 'assistant', delta: 'hi' },
  { type: 'tool.call', id: 't1', tool: 'bash', input: {} },
  { type: 'tool.result', id: 't1', tool: 'bash', output: 'ok' },
  { type: 'notice', message: 'starting' },
  { type: 'ping', ts: 0 },
] as AgentEvent[]) {
  expect(nextLinkSessionStatus('busy', ev) === 'busy', `${ev.type} leaves 'busy' unchanged`);
  expect(nextLinkSessionStatus('idle', ev) === 'idle', `${ev.type} leaves 'idle' unchanged`);
}

/* ---------------- (c) terminal vs. transient close codes --------------------- */

expect(isTerminalLinkCloseCode(WS_CLOSE_UNAUTHORIZED), 'an unauthorized/revoked close (4001) is terminal - retrying cannot help');
expect(isTerminalLinkCloseCode(WS_CLOSE_REPLACED), 'a replaced-by-another-link close (4000) is terminal - avoids a replace war');
expect(
  !isTerminalLinkCloseCode(WS_CLOSE_TOO_MANY_CONNECTIONS),
  'a too-many-connections close (4002) is transient - the normal backoff retries it',
);
for (const code of [1000, 1001, 1006, 1011, 4999]) {
  expect(!isTerminalLinkCloseCode(code), `close code ${code} (ordinary/unknown) reconnects with the normal backoff`);
}

console.log('LINK-STATUS TEST OK');
