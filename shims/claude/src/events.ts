import type { AgentEvent } from '@pocketagent/protocol';
import { SequencedSseBroadcaster } from '@pocketagent/protocol';
import type { ServerResponse } from 'node:http';

/**
 * Fan-out broadcaster for the normalized AgentEvent stream (SSE, `event: agent`).
 *
 * Sequencing, the replay ring and Last-Event-ID handling come from the shared
 * SequencedSseBroadcaster (identical across all shims, so a reconnect gap loses
 * no event); this subclass keeps the claude-specific wiring: the `retry:` hint,
 * the per-connection close cleanup, and the keepalive timer.
 */
export class EventBroadcaster extends SequencedSseBroadcaster {
  private timer: NodeJS.Timeout | null = null;

  /**
   * Register an SSE client. `lastEventId` (its Last-Event-ID header on a
   * reconnect) replays every buffered frame after it before live frames resume.
   */
  addClient(res: ServerResponse, lastEventId?: number): void {
    res.write('retry: 3000\n\n');
    this.add(res, lastEventId);
    res.on('close', () => this.remove(res));
  }

  startHeartbeat(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.publish({ type: 'ping', ts: Date.now() } satisfies AgentEvent), intervalMs);
    this.timer.unref();
  }

  stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
