import type { ServerResponse } from 'node:http';
import type { AgentEvent } from '@pocketagent/protocol';
import { SequencedSseBroadcaster } from '@pocketagent/protocol';

/**
 * Fan-out broadcaster for the normalized AgentEvent stream (SSE, `event: agent`).
 *
 * Sequencing, the replay ring and Last-Event-ID handling come from the shared
 * SequencedSseBroadcaster (W2.1) — identical across all shims, so a reconnect
 * gap loses no event. Codex previously used a plain, unsequenced broadcaster
 * and so was the one adapter without event replay; this brings it in line with
 * claude/kilo/pi/junie. This subclass keeps only the codex-specific wiring: the
 * `retry:` hint, the per-connection close cleanup, and the keepalive timer.
 */
export class EventBroadcaster extends SequencedSseBroadcaster {
  private timer: NodeJS.Timeout | undefined;

  /**
   * Register an SSE client. `lastEventId` (its Last-Event-ID header on a
   * reconnect) replays every buffered frame after it before live frames resume.
   */
  override add(client: ServerResponse, lastEventId?: number): void {
    super.add(client, lastEventId);
    client.on('close', () => this.remove(client));
  }

  startHeartbeat(intervalMs: number): void {
    this.stop();
    // ping keepalives are deliberately unsequenced (see SequencedSseBroadcaster).
    this.timer = setInterval(() => this.publish({ type: 'ping', ts: Date.now() } satisfies AgentEvent), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
