import type { AgentEvent } from '@pocketagent/protocol';
import type { ServerResponse } from 'node:http';

/** Fan-out broadcaster for the normalized AgentEvent stream (SSE, `event: agent`). */
export class EventBroadcaster {
  private readonly clients = new Set<ServerResponse>();
  private timer: NodeJS.Timeout | null = null;

  add(res: ServerResponse): void {
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
    });
  }

  publish(event: AgentEvent): void {
    if (this.clients.size === 0) return;
    const frame = `event: agent\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) {
      if (!res.writableEnded) res.write(frame);
    }
  }

  startHeartbeat(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.publish({ type: 'ping', ts: Date.now() }), intervalMs);
    this.timer.unref();
  }

  stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
