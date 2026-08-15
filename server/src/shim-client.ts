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
  private ac: AbortController | null = null;
  private stopped = false;

  constructor(base: string, token: string) {
    this.base = base.replace(/\/+$/, '');
    this.token = token;
  }

  private async call<T>(path: string, method: string, body?: unknown): Promise<T | null> {
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
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

  /** GET /models; older shims without the route answer 404 -> empty catalog. */
  async models(): Promise<ModelInfo[]> {
    const res = await this.call<ModelsResponse>('/models', 'GET');
    return normalizeModels(res);
  }

  startEvents(onEvent: (e: AgentEvent) => void): void {
    void this.eventLoop(onEvent);
  }

  private async eventLoop(onEvent: (e: AgentEvent) => void): Promise<void> {
    while (!this.stopped) {
      this.ac = new AbortController();
      try {
        const res = await fetch(`${this.base}/events`, {
          headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
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
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim()) as AgentEvent;
            if (ev && typeof ev.type === 'string') onEvent(ev);
          } catch {
            /* malformed line */
          }
        }
        idx = buf.indexOf('\n\n');
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.ac?.abort();
  }
}
