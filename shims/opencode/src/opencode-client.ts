import type { DiffEntry, ModelInfo, PermissionDecision } from '@pocketagent/protocol';

export type PermissionForward = 'ok' | 'unavailable' | 'error';

export interface PromptMessageBody {
  parts: { type: 'text'; text: string }[];
  model?: { providerID: string; modelID: string };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Flatten opencode's `GET /config/providers` catalog into `provider/model` ids
 * (the form POST /session/:id/prompt accepts as {providerID, modelID}).
 * Shape: { providers: [{ id, name, models: { <modelID>: { id?, name? } } }] };
 * anything unexpected yields an empty catalog instead of an error.
 */
export function parseProviderCatalog(raw: unknown): ModelInfo[] {
  const providers = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { providers?: unknown }).providers)
      ? ((raw as { providers: unknown[] }).providers)
      : [];
  const out: ModelInfo[] = [];
  for (const entry of providers) {
    if (typeof entry !== 'object' || entry === null) continue;
    const p = entry as { id?: unknown; name?: unknown; models?: unknown };
    const providerId = typeof p.id === 'string' ? p.id : undefined;
    if (providerId === undefined) continue;
    const providerName = typeof p.name === 'string' ? p.name : providerId;
    const models = p.models;
    const list: Array<[string, { name?: unknown } | null]> = Array.isArray(models)
      ? models.map((m) => {
          const rec = typeof m === 'object' && m !== null ? (m as { id?: unknown; name?: unknown }) : null;
          return [typeof rec?.id === 'string' ? rec.id : '', rec] as [string, { name?: unknown } | null];
        })
      : typeof models === 'object' && models !== null
        ? Object.entries(models as Record<string, unknown>).map(([key, value]) => {
            const rec = typeof value === 'object' && value !== null ? (value as { id?: unknown; name?: unknown }) : null;
            const id = typeof rec?.id === 'string' ? rec.id : key;
            return [id, rec] as [string, { name?: unknown } | null];
          })
        : [];
    for (const [modelId, rec] of list) {
      if (modelId.length === 0) continue;
      const modelName = typeof rec?.name === 'string' ? rec.name : modelId;
      out.push({ id: `${providerId}/${modelId}`, name: `${providerName} · ${modelName}` });
    }
  }
  return out;
}

function idOf(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

export class OpenCodeClient {
  lastEventAt = Date.now();
  private readonly base: string;

  constructor(base: string) {
    this.base = base.replace(/\/+$/, '');
  }

  private async request(method: string, path: string, body?: unknown, timeoutMs = 15000): Promise<Response> {
    return fetch(this.base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  private async json<T>(method: string, path: string, body?: unknown, timeoutMs = 15000): Promise<{ status: number; data: T | undefined }> {
    try {
      const res = await this.request(method, path, body, timeoutMs);
      const text = await res.text();
      let data: T | undefined;
      if (text.length > 0) {
        try {
          data = JSON.parse(text) as T;
        } catch {
          data = undefined;
        }
      }
      return { status: res.status, data };
    } catch {
      return { status: 0, data: undefined };
    }
  }

  async waitReady(timeoutMs = 30000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await this.json('GET', '/doc', undefined, 2000);
      if (res.status > 0 && res.status < 500) return true;
      await sleep(500);
    }
    return false;
  }

  async createSession(_directory: string): Promise<string | undefined> {
    // opencode 1.18 POST /session: body optional (empty body -> create({})),
    // sessions bind to the server's cwd; response is Session.Info with top-level id
    const res = await this.json<{ id?: string; data?: { id?: string } }>('POST', '/session');
    return res.data?.id ?? res.data?.data?.id;
  }

  async listSessions(directory: string): Promise<string[]> {
    const res = await this.json<unknown>('GET', `/session?directory=${encodeURIComponent(directory)}`);
    const raw = res.data;
    if (Array.isArray(raw)) return raw.map(idOf).filter((v): v is string => v !== undefined);
    if (typeof raw === 'object' && raw !== null) {
      return Object.values(raw).map(idOf).filter((v): v is string => v !== undefined);
    }
    return [];
  }

  /** Provider/model catalog; unavailable route or odd shape -> empty list. */
  async models(): Promise<ModelInfo[]> {
    const res = await this.json<unknown>('GET', '/config/providers');
    if (res.status < 200 || res.status >= 300) return [];
    return parseProviderCatalog(res.data);
  }

  async promptMessage(sessionId: string, body: PromptMessageBody): Promise<number> {
    const res = await this.json('POST', `/session/${encodeURIComponent(sessionId)}/message`, body, 30000);
    return res.status;
  }

  /**
   * opencode >= 1.18: POST /session/:id/prompt_async returns 204 immediately;
   * model/turn failures are reported later via `session.error` events on the bus.
   */
  async promptMessageAsync(sessionId: string, body: PromptMessageBody): Promise<number> {
    const res = await this.json('POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, body, 15000);
    return res.status;
  }

  async abort(sessionId: string): Promise<number> {
    const res = await this.json('POST', `/session/${encodeURIComponent(sessionId)}/abort`, {});
    return res.status;
  }

  async respondPermission(sessionId: string, permissionId: string, response: PermissionDecision): Promise<PermissionForward> {
    const res = await this.json('POST', `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`, { response });
    if (res.status >= 200 && res.status < 300) return 'ok';
    if (res.status === 404 || res.status === 405 || res.status === 501) return 'unavailable';
    return 'error';
  }

  async diff(sessionId: string): Promise<DiffEntry[]> {
    // opencode 1.18 GET /session/:id/diff returns Snapshot.FileDiff[] entries
    // shaped {file?, patch?, additions, deletions, status?} — the path field is
    // `file`; older builds used {path, content: {type, patch}}
    const res = await this.json<unknown>('GET', `/session/${encodeURIComponent(sessionId)}/diff`);
    if (!Array.isArray(res.data)) return [];
    const out: DiffEntry[] = [];
    for (const raw of res.data) {
      const d = raw as { path?: unknown; file?: unknown; patch?: unknown; content?: { type?: unknown; patch?: unknown } } | null;
      if (d === null || typeof d !== 'object') continue;
      const path = typeof d.path === 'string' ? d.path : typeof d.file === 'string' ? d.file : undefined;
      if (path === undefined) continue;
      const patch = typeof d.patch === 'string' ? d.patch : d.content?.patch;
      out.push({
        path,
        patch: typeof patch === 'string' ? patch : '',
        binary: d.content?.type === 'binary' || typeof patch !== 'string',
      });
    }
    return out;
  }

  async messages(sessionId: string): Promise<unknown[]> {
    const res = await this.json<unknown>('GET', `/session/${encodeURIComponent(sessionId)}/message`);
    return Array.isArray(res.data) ? res.data : [];
  }

  startEventStream(onEvent: (raw: unknown) => void): void {
    void this.sseLoop(onEvent);
  }

  private async sseLoop(onEvent: (raw: unknown) => void): Promise<void> {
    for (;;) {
      try {
        // no fetch timeout: a stalled stream is detected via lastEventAt + fallback polling instead
        const res = await fetch(this.base + '/event', { headers: { accept: 'text/event-stream' } });
        if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let sep = buf.indexOf('\n\n');
          while (sep >= 0) {
            const chunk = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            sep = buf.indexOf('\n\n');
            const data = chunk
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('');
            if (data.length > 0) {
              this.lastEventAt = Date.now();
              try {
                onEvent(JSON.parse(data));
              } catch {
                // ignore malformed SSE frame
              }
            }
          }
        }
      } catch {
        // fall through to reconnect
      }
      await sleep(2000);
    }
  }
}
