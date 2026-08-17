import type { ServerResponse } from 'node:http';
import type { AgentEvent } from '@pocketagent/protocol';

/** Fan-out for normalized AgentEvents to all connected SSE clients. */
export class EventBroadcaster {
  private readonly clients = new Set<ServerResponse>();
  private timer: NodeJS.Timeout | undefined;

  add(client: ServerResponse): void {
    this.clients.add(client);
  }

  remove(client: ServerResponse): void {
    this.clients.delete(client);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  publish(event: AgentEvent): void {
    if (this.clients.size === 0) return;
    const frame = `event: agent\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  startHeartbeat(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => this.publish({ type: 'ping', ts: Date.now() }), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
