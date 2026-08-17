/**
 * Per-session status the link agent reports on `agent.heartbeat` (Kilo P2,
 * see KILO-CLOUD-ANALYSE.md "Link-Agent auf Kilos Relay-Muster heben").
 *
 * Derived purely from the shim's own normalized event stream - the same
 * events the link agent already forwards to the orchestrator as
 * `agent.event` - so it needs no extra polling of the shim. Kept in its own
 * module (no WebSocket, no child_process) so the pure state machine is
 * unit-testable on its own, the same way ws-url.ts is.
 */
import type { AgentEvent, LinkSessionStatus } from '@pocketagent/protocol';

/** Status before any shim event has been observed. */
export const INITIAL_LINK_SESSION_STATUS: LinkSessionStatus = 'idle';

/**
 * Next heartbeat status after observing `ev`, mirroring how the orchestrator
 * itself infers running/idle from the same event types for a session
 * (`SessionManager.onEvent` in server/src/sessions.ts): a `status` event's
 * own `busy` flag is the primary signal, `permission.request` means the turn
 * is paused waiting on the user, and `turn.completed`/`turn.failed` always
 * end it. Events with no bearing on liveness (message deltas, tool
 * calls/results, notices, pings, ...) leave the status unchanged.
 *
 * `'question'` (Kilo's fourth status) is never produced here: no PocketAgent
 * shim event distinguishes "waiting for a free-text answer" from an
 * in-progress turn today - see `LinkSessionStatus` in the protocol package.
 */
export function nextLinkSessionStatus(current: LinkSessionStatus, ev: AgentEvent): LinkSessionStatus {
  switch (ev.type) {
    case 'status':
      return ev.busy ? 'busy' : 'idle';
    case 'permission.request':
      return 'permission';
    case 'permission.resolved':
      // The turn itself is still running - the next 'status' or
      // 'turn.completed'/'turn.failed' event corrects this once it actually
      // finishes.
      return 'busy';
    case 'turn.completed':
    case 'turn.failed':
      return 'idle';
    case 'error':
      return ev.fatal ? 'idle' : current;
    default:
      return current;
  }
}
