/**
 * Minimal JSON-RPC 2.0 endpoint over a pair of newline-delimited-JSON streams.
 *
 * `codex app-server` speaks "JSON-RPC-lite" over stdio: one JSON object per
 * line on stdin/stdout. This module is deliberately transport-only and knows
 * nothing about codex methods, so the smoke test can drive the exact same code
 * against a fake app-server child process.
 *
 * Three message shapes cross the wire:
 *  - request      {jsonrpc,id,method,params}  -> expects a matching response
 *  - response     {jsonrpc,id,result|error}
 *  - notification {jsonrpc,method,params}      -> no id, no reply
 *
 * The server also *initiates* requests (approval prompts): those arrive with an
 * id and are dispatched to the registered server-request handler, which must
 * reply via the supplied `respond`/`respondError` callbacks.
 */
import type { Readable, Writable } from 'node:stream';

export const JSONRPC_OVERLOAD_CODE = -32001;

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

/** Reply callbacks handed to the server-request handler. */
export interface ServerRequestReply {
  respond(result: unknown): void;
  respondError(code: number, message: string, data?: unknown): void;
}

export type NotificationHandler = (method: string, params: unknown) => void;
export type ServerRequestHandler = (
  method: string,
  params: unknown,
  reply: ServerRequestReply,
) => void;

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

interface RequestOptions {
  timeoutMs?: number;
  /** Retry on -32001 (overload, queue full) with exponential backoff. */
  retryOnOverload?: boolean;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface JsonRpcOptions {
  /** Default per-request timeout. */
  requestTimeoutMs?: number;
  /** Max retries for -32001 overload errors. */
  overloadRetries?: number;
  /** Base backoff (doubled each retry). */
  overloadBackoffMs?: number;
  /** Structured log sink; defaults to console.error. */
  onLog?: (message: string) => void;
}

export class JsonRpcEndpoint {
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private readonly pending = new Map<number | string, Pending>();
  private notificationHandler: NotificationHandler | undefined;
  private serverRequestHandler: ServerRequestHandler | undefined;
  private readonly requestTimeoutMs: number;
  private readonly overloadRetries: number;
  private readonly overloadBackoffMs: number;
  private readonly log: (message: string) => void;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    options: JsonRpcOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.overloadRetries = options.overloadRetries ?? 5;
    this.overloadBackoffMs = options.overloadBackoffMs ?? 250;
    this.log = options.onLog ?? ((m) => console.error(`[codex-jsonrpc] ${m}`));
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => this.onData(chunk));
    stdout.on('close', () => this.failAll(new Error('codex app-server stdout closed')));
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /** Fire-and-forget notification (no id, no reply expected). */
  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Request/response with optional overload backoff. */
  async request<T = unknown>(
    method: string,
    params?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const maxAttempts = options.retryOnOverload ? this.overloadRetries + 1 : 1;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return (await this.requestOnce(method, params, options.timeoutMs)) as T;
      } catch (error) {
        const isOverload = error instanceof RpcError && error.code === JSONRPC_OVERLOAD_CODE;
        if (isOverload && attempt < maxAttempts) {
          const delay = this.overloadBackoffMs * 2 ** (attempt - 1);
          this.log(`overload on ${method}; retry ${attempt}/${maxAttempts - 1} in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw error;
      }
    }
  }

  private requestOnce(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('endpoint closed'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`JSON-RPC request ${method} (#${id}) timed out after ${timeoutMs ?? this.requestTimeoutMs}ms`));
        }
      }, timeoutMs ?? this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
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
    // Response to one of our requests.
    if ((message.result !== undefined || message.error !== undefined) && message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new RpcError(message.error.message, message.error.code, message.error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    // Server-initiated request (has method + id): needs a reply.
    if (typeof message.method === 'string' && message.id != null) {
      this.handleServerRequest(message.id, message.method, message.params);
      return;
    }
    // Notification (has method, no id).
    if (typeof message.method === 'string') {
      try {
        this.notificationHandler?.(message.method, message.params);
      } catch (error) {
        this.log(`notification handler threw for ${message.method}: ${errText(error)}`);
      }
      return;
    }
    this.log(`ignoring unrecognized message: ${line.slice(0, 200)}`);
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    const handler = this.serverRequestHandler;
    if (!handler) {
      // No handler: decline politely so the server does not hang.
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `no handler for ${method}` } });
      return;
    }
    let settled = false;
    const reply: ServerRequestReply = {
      respond: (result: unknown) => {
        if (settled) return;
        settled = true;
        this.write({ jsonrpc: '2.0', id, result });
      },
      respondError: (code: number, message: string, data?: unknown) => {
        if (settled) return;
        settled = true;
        this.write({ jsonrpc: '2.0', id, error: { code, message, data } });
      },
    };
    try {
      handler(method, params, reply);
    } catch (error) {
      reply.respondError(-32603, `handler error: ${errText(error)}`);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
