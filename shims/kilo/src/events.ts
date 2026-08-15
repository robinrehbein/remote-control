import type { ServerResponse } from 'node:http';
import type { AgentEvent, AgentMode, PermissionKind } from '@pocketagent/protocol';
import type { OpenCodeClient } from './opencode-client';

export class Broadcaster {
  private readonly clients = new Set<ServerResponse>();

  add(client: ServerResponse): void {
    this.clients.add(client);
  }

  remove(client: ServerResponse): void {
    this.clients.delete(client);
  }

  broadcast(event: AgentEvent): void {
    const frame = `event: agent\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

export interface NormalizerDeps {
  client: OpenCodeClient;
  broadcaster: Broadcaster;
  getSessionId(): string | undefined;
  getBranch(): string;
  getMode(): AgentMode;
  getProviderModel(): { provider?: string; model?: string };
  isAutoPush(): boolean;
  commitTurn(): Promise<string | undefined>;
  pushTurn(): Promise<{ ok: true; prUrl?: string } | { ok: false; error: string }>;
}

const FALLBACK_POLL_AFTER_MS = 10_000;
const QUIET_FINALIZE_MS = 30_000;
const SUMMARY_MAX = 2000;

function field(obj: unknown, key: string): unknown {
  if (typeof obj === 'object' && obj !== null && key in obj) return (obj as Record<string, unknown>)[key];
  return undefined;
}

function strField(obj: unknown, key: string): string | undefined {
  const v = field(obj, key);
  return typeof v === 'string' ? v : undefined;
}

function numField(obj: unknown, key: string): number {
  const v = field(obj, key);
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function strArray(obj: unknown, key: string): string[] | undefined {
  const v = field(obj, key);
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length > 0 ? out : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function permissionKind(metadata: unknown, title: string): PermissionKind {
  const t = strField(metadata, 'type');
  if (t === 'bash' || t === 'edit' || t === 'webfetch') return t;
  const lower = title.toLowerCase();
  if (lower.includes('bash') || lower.includes('command')) return 'bash';
  if (lower.includes('edit') || lower.includes('write') || lower.includes('file')) return 'edit';
  if (lower.includes('fetch') || lower.includes('url')) return 'webfetch';
  return 'other';
}

function toolOutput(state: unknown): string {
  const output = field(state, 'output');
  if (typeof output === 'string') return output;
  const error = field(state, 'error');
  if (typeof error === 'string') return error;
  if (output !== undefined) {
    try {
      return JSON.stringify(output);
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Normalizes opencode bus events into the PocketAgent AgentEvent stream.
 *
 * opencode event names vary between versions, so matching is defensive:
 * direct `{type: ...}` frames as well as `{type:"bus.event", properties:{type}, payload}` wrappers
 * are accepted, and multiple aliases per concept are tried.
 */
export class EventNormalizer {
  private busy = false;
  private readonly partTextLen = new Map<string, number>();
  private readonly toolCalled = new Set<string>();
  private readonly toolDone = new Set<string>();
  private readonly messageTextParts = new Map<string, Map<string, string>>();
  private readonly messageDone = new Set<string>();
  private readonly pollSnapshot = new Map<string, number>();
  private lastSummary = '';

  constructor(private readonly deps: NormalizerDeps) {}

  isBusy(): boolean {
    return this.busy;
  }

  startPrompt(): void {
    this.busy = true;
    this.emitStatus();
  }

  abortPrompt(): void {
    this.finalizeTurn('aborted');
  }

  emitStatus(): void {
    const pm = this.deps.getProviderModel();
    this.deps.broadcaster.broadcast({
      type: 'status',
      adapter: 'kilo',
      sessionRef: this.deps.getSessionId(),
      provider: pm.provider,
      model: pm.model,
      mode: this.deps.getMode(),
      busy: this.busy,
    });
  }

  handleRaw(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const outerType = strField(raw, 'type');
    if (outerType === 'bus.event') {
      const innerType = strField(field(raw, 'properties'), 'type');
      const payload = field(raw, 'payload');
      if (innerType !== undefined && payload !== undefined) this.handleTyped(innerType, payload);
      return;
    }
    if (outerType !== undefined) this.handleTyped(outerType, raw);
  }

  private handleTyped(type: string, obj: unknown): void {
    switch (type) {
      case 'message.part.updated':
      case 'message.part.appended':
        this.onPartUpdated(obj);
        break;
      case 'message.updated':
      case 'message.completed':
        this.onMessageUpdated(obj);
        break;
      case 'permission.ask':
      case 'permission.asked':
      case 'permission.request':
        this.onPermissionAsk(obj);
        break;
      case 'permission.update':
      case 'permission.updated':
      case 'permission.responded':
        this.onPermissionUpdate(obj);
        break;
      case 'error':
      case 'session.error':
        this.onError(obj);
        break;
      default:
        break;
    }
  }

  private onPartUpdated(obj: unknown): void {
    const info = field(obj, 'info');
    const part = field(obj, 'part');
    if (part === undefined) return;
    const role = strField(info, 'role') ?? strField(part, 'role');
    const messageID = strField(info, 'messageID') ?? strField(part, 'messageID');
    const partType = strField(part, 'type');
    const partID = strField(part, 'id') ?? `${messageID ?? 'msg'}:${strField(part, 'tool') ?? partType ?? 'part'}`;

    if (partType === 'text') {
      const text = strField(part, 'text');
      if (role === 'assistant' && messageID !== undefined && typeof text === 'string') {
        const prev = this.partTextLen.get(partID) ?? 0;
        if (text.length > prev) {
          this.deps.broadcaster.broadcast({ type: 'message.delta', role: 'assistant', delta: text.slice(prev) });
          this.partTextLen.set(partID, text.length);
        }
        let parts = this.messageTextParts.get(messageID);
        if (parts === undefined) {
          parts = new Map();
          this.messageTextParts.set(messageID, parts);
        }
        parts.set(partID, text);
        this.lastSummary = [...parts.values()].join('');
      }
      return;
    }

    if (partType === 'tool') {
      const tool = strField(part, 'tool') ?? 'unknown';
      const state = field(part, 'state');
      const status = strField(state, 'status') ?? '';
      const id = strField(part, 'toolCallID') ?? partID;
      if ((status === 'pending' || status === 'running') && !this.toolCalled.has(partID)) {
        this.toolCalled.add(partID);
        this.deps.broadcaster.broadcast({
          type: 'tool.call',
          id,
          tool,
          input: field(state, 'input'),
          title: strField(state, 'title'),
        });
      }
      if ((status === 'completed' || status === 'error') && !this.toolDone.has(partID)) {
        this.toolDone.add(partID);
        this.deps.broadcaster.broadcast({
          type: 'tool.result',
          id,
          tool,
          output: toolOutput(state),
          isError: status === 'error' || undefined,
        });
      }
    }
  }

  private onMessageUpdated(obj: unknown): void {
    const info = field(obj, 'info') ?? obj;
    const id = strField(info, 'id');
    const role = strField(info, 'role');
    const end = numField(field(info, 'time'), 'end');
    if (id === undefined || role !== 'assistant' || end <= 0 || this.messageDone.has(id)) return;
    this.messageDone.add(id);
    const parts = this.messageTextParts.get(id);
    const text = parts === undefined ? '' : [...parts.values()].join('');
    this.deps.broadcaster.broadcast({ type: 'message.completed', role: 'assistant', text });
    this.finalizeTurn(text);
  }

  private onPermissionAsk(obj: unknown): void {
    const permissionId = strField(obj, 'permissionID') ?? strField(obj, 'permissionId') ?? strField(obj, 'id');
    if (permissionId === undefined) return;
    const title = strField(obj, 'title') ?? 'permission request';
    const metadata = field(obj, 'metadata');
    this.deps.broadcaster.broadcast({
      type: 'permission.request',
      permissionId,
      kind: permissionKind(metadata, title),
      title,
      detail:
        strField(metadata, 'command')
        ?? strField(metadata, 'path')
        ?? strField(metadata, 'url'),
      diff: strField(metadata, 'diff'),
      patterns: strArray(obj, 'patterns'),
    });
  }

  private onPermissionUpdate(obj: unknown): void {
    const permissionId = strField(obj, 'permissionID') ?? strField(obj, 'permissionId') ?? strField(obj, 'id');
    if (permissionId === undefined) return;
    const status = strField(obj, 'status') ?? strField(obj, 'decision') ?? '';
    if (status !== 'once' && status !== 'always' && status !== 'rejected' && status !== 'reject') return;
    this.deps.broadcaster.broadcast({
      type: 'permission.resolved',
      permissionId,
      decision: status === 'rejected' ? 'reject' : status,
    });
  }

  private onError(obj: unknown): void {
    const message = strField(obj, 'message') ?? strField(obj, 'error') ?? 'unknown opencode error';
    this.deps.broadcaster.broadcast({ type: 'error', message, fatal: false });
  }

  private finalizeTurn(summary: string | undefined): void {
    if (!this.busy) return;
    this.busy = false;
    const text = (summary !== undefined && summary.length > 0 ? summary : this.lastSummary).slice(0, SUMMARY_MAX);
    this.lastSummary = text;
    void this.finishTurn(text);
  }

  private async finishTurn(text: string): Promise<void> {
    let commitSha: string | undefined;
    try {
      commitSha = await this.deps.commitTurn();
    } catch (err) {
      this.deps.broadcaster.broadcast({ type: 'error', message: `auto-commit failed: ${errorMessage(err)}`, fatal: false });
    }
    this.deps.broadcaster.broadcast({
      type: 'turn.completed',
      summary: text.length > 0 ? text : undefined,
      commitSha,
    });
    if (this.deps.isAutoPush()) {
      const result = await this.deps.pushTurn();
      if (result.ok) {
        this.deps.broadcaster.broadcast({ type: 'pushed', branch: this.deps.getBranch(), prUrl: result.prUrl, auto: true });
      } else {
        this.deps.broadcaster.broadcast({ type: 'error', message: `auto-push failed: ${result.error}`, fatal: false });
      }
    }
    this.emitStatus();
  }

  /** Every 2s: fallback-poll messages when SSE went silent >10s; safety-finalize after 30s of silence. */
  tick(): void {
    if (!this.busy) return;
    const silentFor = Date.now() - this.deps.client.lastEventAt;
    if (silentFor > QUIET_FINALIZE_MS) {
      this.finalizeTurn(this.lastSummary);
      return;
    }
    if (silentFor > FALLBACK_POLL_AFTER_MS) void this.pollFallback();
  }

  /**
   * Approximate fallback (opencode event names are not stable across versions):
   * polls GET /session/:id/message and diffs per-message assistant text length.
   * Emits coarse deltas and completions for messages the SSE stream may have missed.
   */
  private async pollFallback(): Promise<void> {
    const sessionId = this.deps.getSessionId();
    if (sessionId === undefined) return;
    const messages = await this.deps.client.messages(sessionId);
    for (const message of messages) {
      const info = field(message, 'info') ?? message;
      const id = strField(info, 'id');
      const role = strField(info, 'role');
      if (id === undefined || role !== 'assistant') continue;
      const parts = field(message, 'parts');
      let text = '';
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (strField(part, 'type') === 'text') {
            const t = strField(part, 'text');
            if (typeof t === 'string') text += t;
          }
        }
      }
      const prev = this.pollSnapshot.get(id) ?? 0;
      this.pollSnapshot.set(id, text.length);
      if (text.length > prev && !this.messageDone.has(id)) {
        this.deps.broadcaster.broadcast({ type: 'message.delta', role: 'assistant', delta: text.slice(prev) });
        this.lastSummary = text;
      }
      const end = numField(field(info, 'time'), 'end');
      if (end > 0 && !this.messageDone.has(id)) {
        this.messageDone.add(id);
        this.deps.broadcaster.broadcast({ type: 'message.completed', role: 'assistant', text });
        this.finalizeTurn(text);
        return;
      }
    }
  }
}
