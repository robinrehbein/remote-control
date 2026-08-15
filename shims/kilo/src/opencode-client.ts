import { parseProviderCatalog } from '@pocketagent/protocol';
import type { DiffEntry, ModelInfo, PermissionDecision } from '@pocketagent/protocol';

export type PermissionForward = 'ok' | 'unavailable' | 'error';

export interface PromptMessageBody {
  parts: { type: 'text'; text: string }[];
  model?: { providerID: string; modelID: string };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function idOf(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

/**
 * Minimal client for `kilo serve` (Kilo CLI, OpenCode fork).
 *
 * Wire format verified against kilo v7.4.22:
 * - instance routing via `?directory=` query (POST/GET /session) or the
 *   session record itself (per-session routes); /event binds via `?directory=`
 * - optional HTTP Basic auth when KILO_SERVER_PASSWORD is set (user "kilo")
 * - POST /session/:id/prompt_async returns immediately; legacy
 *   POST /session/:id/message is atomic (only used as fallback)
 */
export class OpenCodeClient {
  lastEventAt = Date.now();
  private readonly base: string;
  private readonly directory: string;
  private readonly authHeader: string | undefined;

  constructor(base: string, directory: string) {
    this.base = base.replace(/\/+$/, '');
    this.directory = directory;
    // kilo serve only enforces auth when KILO_SERVER_PASSWORD is set; without
    // it the server boots unsecured and no Authorization header is required.
    const password = process.env.KILO_SERVER_PASSWORD;
    const username = process.env.KILO_SERVER_USERNAME ?? 'kilo';
    this.authHeader = password ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : undefined;
  }

  private directoryQuery(): string {
    return `directory=${encodeURIComponent(this.directory)}`;
  }

  private async request(method: string, path: string, body?: unknown, timeoutMs = 15000): Promise<Response> {
    return fetch(this.base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.authHeader === undefined ? {} : { authorization: this.authHeader }),
      },
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

  async createSession(): Promise<string | undefined> {
    // kilo ignores `directory` in the create body; the instance directory comes
    // from the ?directory= query, the x-kilo-directory header, or the server cwd.
    const res = await this.json<{ id?: string; data?: { id?: string } }>(
      'POST',
      `/session?${this.directoryQuery()}`,
      {},
    );
    return res.data?.id ?? res.data?.data?.id;
  }

  async listSessions(): Promise<string[]> {
    const res = await this.json<unknown>('GET', `/session?${this.directoryQuery()}`);
    const raw = res.data;
    if (Array.isArray(raw)) return raw.map(idOf).filter((v): v is string => v !== undefined);
    if (typeof raw === 'object' && raw !== null) {
      return Object.values(raw).map(idOf).filter((v): v is string => v !== undefined);
    }
    return [];
  }

  /** Provider/model catalog; unavailable route or odd shape -> empty list. */
  async models(): Promise<ModelInfo[]> {
    const res = await this.json<unknown>('GET', `/config/providers?${this.directoryQuery()}`);
    if (res.status < 200 || res.status >= 300) return [];
    return parseProviderCatalog(res.data);
  }

  async promptMessage(sessionId: string, body: PromptMessageBody): Promise<number> {
    const base = `/session/${encodeURIComponent(sessionId)}`;
    // prompt_async (kilo >= 7.x) returns 204 immediately and streams via SSE.
    const asyncRes = await this.json('POST', `${base}/prompt_async`, body, 15000);
    if (asyncRes.status >= 200 && asyncRes.status < 300) return asyncRes.status;
    if (asyncRes.status !== 404 && asyncRes.status !== 405) return asyncRes.status;
    // legacy fallback: atomic message endpoint, blocks until the turn finishes
    const res = await this.json('POST', `${base}/message`, body, 300000);
    return res.status;
  }

  async abort(sessionId: string): Promise<number> {
    const res = await this.json('POST', `/session/${encodeURIComponent(sessionId)}/abort`, undefined);
    return res.status;
  }

  async respondPermission(sessionId: string, permissionId: string, response: PermissionDecision): Promise<PermissionForward> {
    const legacy = await this.json(
      'POST',
      `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
      { response },
    );
    if (legacy.status >= 200 && legacy.status < 300) return 'ok';
    if (legacy.status === 404 || legacy.status === 405 || legacy.status === 501) {
      // kilo 7.x also exposes POST /permission/:requestID/reply {reply}
      const modern = await this.json('POST', `/permission/${encodeURIComponent(permissionId)}/reply`, {
        reply: response,
        interactive: true,
      });
      if (modern.status >= 200 && modern.status < 300) return 'ok';
      if (modern.status === 404 || modern.status === 405 || modern.status === 501) return 'unavailable';
      return 'error';
    }
    return 'error';
  }

  async diff(sessionId: string): Promise<DiffEntry[]> {
    const res = await this.json<unknown>('GET', `/session/${encodeURIComponent(sessionId)}/diff`);
    if (!Array.isArray(res.data)) return [];
    const out: DiffEntry[] = [];
    for (const raw of res.data) {
      const d = raw as { path?: unknown; file?: unknown; patch?: unknown; content?: { type?: unknown; patch?: unknown } } | null;
      if (d === null || typeof d !== 'object') continue;
      // kilo's Snapshot.FileDiff uses `file` as the path key; older opencode used `path`
      const path = typeof d.path === 'string' ? d.path : d.file;
      if (typeof path !== 'string') continue;
      const patch = typeof d.patch === 'string' ? d.patch : d.content?.patch;
      out.push({
        path,
        patch: typeof patch === 'string' ? patch : '',
        binary: d.content?.type === 'binary',
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
        // /event needs the directory query to bind to the right instance;
        // no fetch timeout: a stalled stream is detected via lastEventAt + fallback polling
        const res = await fetch(`${this.base}/event?${this.directoryQuery()}`, {
          headers: {
            accept: 'text/event-stream',
            ...(this.authHeader === undefined ? {} : { authorization: this.authHeader }),
          },
        });
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
              try {
                const parsed = JSON.parse(data) as { type?: unknown };
                // kilo sends server.heartbeat frames every 10s; they must not
                // reset the staleness clock that drives fallback polling
                if (parsed?.type !== 'server.heartbeat') this.lastEventAt = Date.now();
                onEvent(parsed);
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
