import type { AgentEvent } from '@pocketagent/protocol';
import { SequencedSseBroadcaster } from '@pocketagent/protocol';

/**
 * Fan-out for normalized AgentEvents to all connected SSE clients.
 *
 * The sequencing, replay ring and Last-Event-ID handling live in the shared
 * SequencedSseBroadcaster (every runner uses the same one, so a reconnect gap
 * loses no event); this subclass only adds the pi-specific keepalive timer.
 */
export class EventBroadcaster extends SequencedSseBroadcaster {
  private timer: NodeJS.Timeout | undefined;

  startHeartbeat(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => this.publish({ type: 'ping', ts: Date.now() } satisfies AgentEvent), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
