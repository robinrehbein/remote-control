import type {
  AgentEvent,
  DiffEntry,
  ModelInfo,
  ModelsResponse,
  PermissionDecision,
  PromptRequest,
  ShimApiResponse,
  ShimStatus,
} from '@pocketagent/protocol';

const TIMEOUT_MS = 10_000;
const RECONNECT_MS = 3_000;

/** Tolerant reader for GET /models bodies (missing route, wrong shape -> []). */
export function normalizeModels(body: unknown): ModelInfo[] {
  const raw = Array.isArray(body) ? body : (body as ModelsResponse | null)?.models;
  if (!Array.isArray(raw)) return [];
  const out: ModelInfo[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      if (entry.length > 0) out.push({ id: entry });
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || id.length === 0) continue;
    out.push({ id, ...(typeof name === 'string' && name.length > 0 ? { name } : {}) });
  }
  return out;
}

export class ShimClient {
  private readonly base: string;
  private readonly token: string;
  private readonly extraHeaders: Record<string, string>;
  private ac: AbortController | null = null;
  private stopped = false;
  /**
   * Last event sequence number seen on this stream (0 = none yet). Sent as
   * `Last-Event-ID` on every (re)connect so the shim replays whatever fell into
   * the gap, and used to drop the replayed events this client already forwarded
   * - so a reconnect neither loses nor duplicates an event. The cursor lives on
   * the client instance: a fresh client (a restarted container) starts at 0,
   * which is correct because the shim's own sequence resets with it.
   */
  private lastEventId = 0;

  /**
   * `extraHeaders` ride along on every request; used for the remote-runner
   * gateway's shared-secret header (empty in all local modes).
   */
  constructor(base: string, token: string, extraHeaders: Record<string, string> = {}) {
    this.base = base.replace(/\/+$/, '');
    this.token = token;
    this.extraHeaders = extraHeaders;
  }

  private async call<T>(path: string, method: string, body?: unknown): Promise<T | null> {
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          ...this.extraHeaders,
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // A non-2xx response with a parsable JSON body (a proxy's "upstream not
      // ready" while the shim is still booting, a reverse proxy's JSON error
      // page) must not read as success just because the body parses - only an
      // ok response carries a real T. Treated the same as a transport failure:
      // waitForShim's `if (await client.status()) return;` keeps polling
      // instead of declaring a failing shim "ready".
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  status(): Promise<ShimStatus | null> {
    return this.call<ShimStatus>('/status', 'GET');
  }

  prompt(req: PromptRequest): Promise<ShimApiResponse | null> {
    return this.call<ShimApiResponse>('/prompt', 'POST', req);
  }

  abort(): Promise<ShimApiResponse | null> {
    return this.call<ShimApiResponse>('/abort', 'POST');
  }

  permission(id: string, decision: PermissionDecision): Promise<ShimApiResponse | null> {
    return this.call<ShimApiResponse>(`/permissions/${encodeURIComponent(id)}`, 'POST', {
      response: decision,
    });
  }

  resume(ref: string): Promise<ShimApiResponse | null> {
    return this.call<ShimApiResponse>('/resume', 'POST', { sessionRef: ref });
  }

  diff(): Promise<DiffEntry[] | null> {
    return this.call<DiffEntry[]>('/diff', 'GET');
  }

  /**
   * GET /models; older shims without the route answer 404 -> empty catalog.
   * null is reserved for a transport failure (no answer at all), which the
   * caller heals by re-attaching the session network and retrying.
   */
  async models(): Promise<ModelInfo[] | null> {
    const res = await this.call<ModelsResponse>('/models', 'GET');
    return res === null ? null : normalizeModels(res);
  }

  /**
   * Seed the replay cursor before the stream starts. Used when reconnecting to
   * a shim process that kept running (e.g. an orchestrator redeploy): the last
   * seq already persisted for the session picks the events emitted during the
   * gap back up. A fresh container leaves this at 0.
   */
  seedEventCursor(lastSeq: number): void {
    if (Number.isFinite(lastSeq) && lastSeq > this.lastEventId) this.lastEventId = lastSeq;
  }

  startEvents(onEvent: (e: AgentEvent) => void): void {
    void this.eventLoop(onEvent);
  }

  private async eventLoop(onEvent: (e: AgentEvent) => void): Promise<void> {
    while (!this.stopped) {
      this.ac = new AbortController();
      try {
        const res = await fetch(`${this.base}/events`, {
          headers: {
            ...this.extraHeaders,
            authorization: `Bearer ${this.token}`,
            accept: 'text/event-stream',
            // Reconnect from where we were: the shim replays every buffered
            // event after this seq, so the gap between disconnect and reconnect
            // loses nothing. Omitted on the first connect (nothing to replay).
            ...(this.lastEventId > 0 ? { 'last-event-id': String(this.lastEventId) } : {}),
          },
          signal: this.ac.signal,
        });
        if (!res.ok || !res.body) throw new Error(`sse status ${res.status}`);
        await this.readStream(res.body, onEvent);
      } catch {
        /* reconnect below */
      }
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, RECONNECT_MS));
    }
  }

  private async readStream(
    body: ReadableStream<Uint8Array>,
    onEvent: (e: AgentEvent) => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf('\n\n');
      while (idx >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        this.handleBlock(block, onEvent);
        idx = buf.indexOf('\n\n');
      }
    }
  }

  /**
   * One SSE frame: an optional `id:` line (the event's sequence number) and a
   * `data:` line (the AgentEvent JSON). The seq drives dedup + the reconnect
   * cursor - an event at or below the last one seen is a replay this client
   * already forwarded and is dropped, so a reconnect delivers each event
   * exactly once. Frames without a seq (an older shim, or a ping) are always
   * forwarded and never advance the cursor, preserving the old behaviour.
   */
  private handleBlock(block: string, onEvent: (e: AgentEvent) => void): void {
    let dataLine: string | undefined;
    let idLine: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) dataLine = line.slice(5).trim();
      else if (line.startsWith('id:')) idLine = line.slice(3).trim();
    }
    if (dataLine === undefined) return;
    let ev: AgentEvent;
    try {
      ev = JSON.parse(dataLine) as AgentEvent;
    } catch {
      return; // malformed frame
    }
    if (!ev || typeof ev.type !== 'string') return;
    // Prefer the seq embedded in the event; fall back to the SSE id: line and
    // inject it so persistence and the app get a consistent sequence number.
    let seq = typeof ev.seq === 'number' ? ev.seq : undefined;
    if (seq === undefined && idLine !== undefined) {
      const parsed = Number.parseInt(idLine, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        seq = parsed;
        ev.seq = parsed;
      }
    }
    if (seq !== undefined) {
      if (seq <= this.lastEventId) return; // replay of an event already forwarded
      this.lastEventId = seq;
    }
    onEvent(ev);
  }

  stop(): void {
    this.stopped = true;
    this.ac?.abort();
  }
}
