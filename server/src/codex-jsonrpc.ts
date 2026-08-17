/**
 * Minimal JSON-RPC 2.0 client over a pair of newline-delimited-JSON streams,
 * the wire `codex app-server` speaks over stdio (one JSON object per line).
 *
 * This is the orchestrator-side counterpart of the codex shim's transport
 * (shims/codex/src/jsonrpc.ts): the auth flow (codex-auth.ts) drives
 * `login_chatgpt` and waits for `AccountLoginCompletedNotification` over it.
 * It is deliberately transport-only and knows nothing about codex methods, so
 * the smoke test can point it at a fake app-server child process exactly like
 * production points it at a container's attached stdio.
 *
 * Three message shapes cross the wire:
 *  - request      {jsonrpc,id,method,params}  -> expects a matching response
 *  - response     {jsonrpc,id,result|error}
 *  - notification {jsonrpc,method,params}      -> no id, no reply
 */
import type { Readable, Writable } from 'node:stream';

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface WireMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

export type CodexNotificationHandler = (method: string, params: unknown) => void;

export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'CodexRpcError';
  }
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class CodexJsonRpc {
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private readonly pending = new Map<number | string, Pending>();
  private notificationHandler: CodexNotificationHandler | undefined;
  private readonly log: (message: string) => void;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    options: { onLog?: (message: string) => void } = {},
  ) {
    this.log = options.onLog ?? ((m) => console.error(`[codex-auth-rpc] ${m}`));
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => this.onData(chunk));
    stdout.on('close', () => this.failAll(new Error('codex app-server stdout closed')));
  }

  onNotification(handler: CodexNotificationHandler): void {
    this.notificationHandler = handler;
  }

  /** Fire-and-forget notification (no id, no reply expected). */
  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Request/response with a per-request timeout. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('endpoint closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`JSON-RPC request ${method} (#${id}) timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.dispatchLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private dispatchLine(line: string): void {
    let message: WireMessage;
    try {
      message = JSON.parse(line) as WireMessage;
    } catch {
      this.log(`ignoring non-JSON line: ${line.slice(0, 200)}`);
      return;
    }
    if ((message.result !== undefined || message.error !== undefined) && message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new CodexRpcError(message.error.message, message.error.code, message.error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    // A server-initiated request (method + id) is not part of the login flow;
    // decline it politely so the app-server does not hang waiting for a reply.
    if (typeof message.method === 'string' && message.id != null) {
      this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unhandled ${message.method}` } });
      return;
    }
    if (typeof message.method === 'string') {
      try {
        this.notificationHandler?.(message.method, message.params);
      } catch (error) {
        this.log(`notification handler threw for ${message.method}: ${errText(error)}`);
      }
    }
  }

  private write(message: WireMessage): void {
    if (this.closed) return;
    try {
      this.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.log(`write failed: ${errText(error)}`);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('endpoint closed'));
  }
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
