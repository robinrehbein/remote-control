import type { ServerResponse } from 'node:http';
import type { AgentEvent, AgentMode, PermissionKind } from '@pocketagent/protocol';
import type { OpenCodeClient } from './opencode-client.ts';

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

/**
 * Extracts a human readable message from the error shapes opencode 1.18 emits:
 * NamedError objects `{name: "ProviderAuthError"|"APIError"|..., data: {message}}`,
 * plain `{message}` objects, or bare strings.
 */
function errorText(err: unknown): string | undefined {
  if (typeof err === 'string') return err.length > 0 ? err : undefined;
  if (typeof err !== 'object' || err === null) return undefined;
  const name = strField(err, 'name');
  const dataMessage = strField(field(err, 'data'), 'message');
  const message = dataMessage ?? strField(err, 'message');
  if (message !== undefined) return name !== undefined ? `${name}: ${message}` : message;
  if (name !== undefined) return name;
  try {
    return JSON.stringify(err);
  } catch {
    return undefined;
  }
}

function permissionKind(metadata: unknown, title: string): PermissionKind {
  const t = strField(metadata, 'type');
  if (t === 'bash' || t === 'edit' || t === 'webfetch') return t;
  const lower = title.toLowerCase();
  if (lower.includes('bash') || lower.includes('command') || lower.includes('shell')) return 'bash';
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
 * Verified against opencode-ai 1.18.18 (`opencode serve`):
 *  - SSE frames on GET /event are `{id, type, properties}` envelopes; the event
 *    payload lives in `properties` (no legacy `bus.event` wrapper). The first
 *    frame is `server.connected`, followed by `server.heartbeat` every 10s.
 *  - Session events: `message.updated` (assistant done when `info.time.completed`
 *    is set), `message.part.updated` ({sessionID, part, time} — roles come from
 *    earlier `message.updated` frames), `message.part.delta` (live token stream),
 *    `session.error` ({error: {name, data: {message}}}), `session.status`
 *    ({status: {type: "busy"|"idle"|"retry"}}), `permission.asked`/
 *    `permission.replied` (v1 shapes with id/patterns/metadata), plus the
 *    `session.next.*` family (`session.next.step.failed` carries step errors).
 *
 * Older frame layouts (direct `{type, ...payload}` and `{type:"bus.event",
 * properties:{type}, payload}` wrappers) stay supported so the fake-server smoke
 * test and pre-1.18 runtimes keep working.
 */
export class EventNormalizer {
  private busy = false;
  private readonly messageRoles = new Map<string, string>();
  private readonly partSentLen = new Map<string, number>();
  private readonly toolCalled = new Set<string>();
  private readonly toolDone = new Set<string>();
  private readonly messageTextParts = new Map<string, Map<string, string>>();
  private readonly messageDone = new Set<string>();
  private readonly pollSnapshot = new Map<string, number>();
  private lastSummary = '';
  private lastSessionEventAt = Date.now();

  constructor(private readonly deps: NormalizerDeps) {}

  isBusy(): boolean {
    return this.busy;
  }

  startPrompt(): void {
    this.busy = true;
    this.lastSessionEventAt = Date.now();
    this.emitStatus();
  }

  abortPrompt(): void {
    this.finalizeTurn('aborted');
  }

  /** Ends the current turn as failed: emits `turn.failed` once and clears busy. */
  failTurn(error: string): void {
    if (!this.busy) return;
    this.busy = false;
    this.deps.broadcaster.broadcast({ type: 'turn.failed', error: error.slice(0, SUMMARY_MAX) });
    this.emitStatus();
  }

  emitStatus(): void {
    const pm = this.deps.getProviderModel();
    this.deps.broadcaster.broadcast({
      type: 'status',
      adapter: 'opencode',
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
    if (outerType === undefined) return;
    if (outerType === 'bus.event') {
      // legacy wrapper (pre-1.18): {type:"bus.event", properties:{type}, payload}
      const innerType = strField(field(raw, 'properties'), 'type');
      const payload = field(raw, 'payload');
      if (innerType !== undefined && payload !== undefined) this.handleTyped(innerType, payload);
      return;
    }
    // opencode >= 1.18 envelope: {id, type, properties: {...payload...}}
    const properties = field(raw, 'properties');
    this.handleTyped(outerType, typeof properties === 'object' && properties !== null ? properties : raw);
  }

  private forThisSession(obj: unknown): boolean {
    const sessionId = this.deps.getSessionId();
    if (sessionId === undefined) return true;
    const eventSession = strField(obj, 'sessionID');
    return eventSession === undefined || eventSession === sessionId;
  }

  private handleTyped(type: string, obj: unknown): void {
    // heartbeats must not count as session activity (they arrive every 10s
    // even when a model call hangs) and must not reset the quiet-finalize clock
    if (type !== 'server.heartbeat' && type !== 'server.connected') this.lastSessionEventAt = Date.now();
    if (type.startsWith('server.') || type.startsWith('global.')) return;
    if (!this.forThisSession(obj)) return;
    switch (type) {
      case 'message.part.updated':
      case 'message.part.appended':
        this.onPartUpdated(obj);
        break;
      case 'message.part.delta':
        this.onPartDelta(obj);
        break;
      case 'message.updated':
      case 'message.completed':
        this.onMessageUpdated(obj);
        break;
      case 'session.status':
        this.onSessionStatus(obj);
        break;
      case 'session.idle':
        this.finalizeTurn(this.lastSummary);
        break;
      case 'session.error':
        this.onSessionError(obj);
        break;
      case 'session.next.step.failed':
        this.onStepFailed(obj);
        break;
      case 'permission.ask':
      case 'permission.asked':
      case 'permission.request':
        this.onPermissionAsk(obj);
        break;
      case 'permission.update':
      case 'permission.updated':
      case 'permission.replied':
      case 'permission.responded':
        this.onPermissionUpdate(obj);
        break;
      case 'error':
        this.onError(obj);
        break;
      default:
        break;
    }
  }

  private onPartUpdated(obj: unknown): void {
    const part = field(obj, 'part');
    if (part === undefined) return;
    const info = field(obj, 'info'); // legacy frames carry {info, part}
    const messageID = strField(part, 'messageID') ?? strField(info, 'messageID');
    const role = strField(info, 'role') ?? (messageID !== undefined ? this.messageRoles.get(messageID) : undefined);
    const partType = strField(part, 'type');
    const partID = strField(part, 'id') ?? `${messageID ?? 'msg'}:${strField(part, 'tool') ?? partType ?? 'part'}`;

    if (partType === 'text') {
      const text = strField(part, 'text');
      if (messageID === undefined || typeof text !== 'string') return;
      if (role === 'user') return; // never echo the user prompt back as assistant output
      this.trackText(messageID, partID, text);
      return;
    }

    if (partType === 'tool') {
      const tool = strField(part, 'tool') ?? 'unknown';
      const state = field(part, 'state');
      const status = strField(state, 'status') ?? '';
      const id = strField(part, 'callID') ?? partID;
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

  private onPartDelta(obj: unknown): void {
    const messageID = strField(obj, 'messageID');
    const partID = strField(obj, 'partID');
    const delta = strField(obj, 'delta');
    if (messageID === undefined || partID === undefined || typeof delta !== 'string') return;
    if (strField(obj, 'field') !== 'text') return;
    if (this.messageRoles.get(messageID) === 'user') return;
    const parts = this.ensureParts(messageID);
    parts.set(partID, (parts.get(partID) ?? '') + delta);
    this.emitText(messageID, partID, parts);
  }

  private trackText(messageID: string, partID: string, text: string): void {
    const parts = this.ensureParts(messageID);
    parts.set(partID, text);
    this.emitText(messageID, partID, parts);
  }

  private emitText(messageID: string, partID: string, parts: Map<string, string>): void {
    const text = parts.get(partID) ?? '';
    const prev = this.partSentLen.get(partID) ?? 0;
    if (text.length > prev) {
      this.deps.broadcaster.broadcast({ type: 'message.delta', role: 'assistant', delta: text.slice(prev) });
      this.partSentLen.set(partID, text.length);
    }
    this.lastSummary = [...parts.values()].join('');
  }

  private ensureParts(messageID: string): Map<string, string> {
    let parts = this.messageTextParts.get(messageID);
    if (parts === undefined) {
      parts = new Map();
      this.messageTextParts.set(messageID, parts);
    }
    return parts;
  }

  private onMessageUpdated(obj: unknown): void {
    const info = field(obj, 'info') ?? obj;
    const id = strField(info, 'id');
    const role = strField(info, 'role');
    if (id === undefined || role === undefined) return;
    this.messageRoles.set(id, role);
    if (role !== 'assistant') return;
    // 1.18 AssistantMessage.time = {created, completed?}; older builds used {start, end}
    const completed = numField(field(info, 'time'), 'completed') || numField(field(info, 'time'), 'end');
    const err = errorText(field(info, 'error'));
    if (err !== undefined) {
      this.deps.broadcaster.broadcast({ type: 'error', message: `assistant message failed: ${err}`, fatal: false });
    }
    if (completed <= 0 || this.messageDone.has(id)) return;
    this.messageDone.add(id);
    const parts = this.messageTextParts.get(id);
    const text = parts === undefined ? '' : [...parts.values()].join('');
    this.deps.broadcaster.broadcast({ type: 'message.completed', role: 'assistant', text });
    this.finalizeTurn(text);
  }

  private onSessionStatus(obj: unknown): void {
    const status = field(obj, 'status');
    const type = strField(status, 'type');
    if (type === 'idle') {
      this.finalizeTurn(this.lastSummary);
      return;
    }
    if (type === 'retry') {
      const message = strField(status, 'message') ?? 'model call failed';
      this.deps.broadcaster.broadcast({
        type: 'error',
        message: `retrying (attempt ${numField(status, 'attempt')}): ${message}`,
        fatal: false,
      });
    }
  }

  private onSessionError(obj: unknown): void {
    const message = errorText(field(obj, 'error')) ?? 'unknown opencode error';
    this.deps.broadcaster.broadcast({ type: 'error', message, fatal: false });
    this.failTurn(message);
  }

  private onStepFailed(obj: unknown): void {
    const message = errorText(field(obj, 'error'));
    if (message === undefined) return;
    this.deps.broadcaster.broadcast({ type: 'error', message: `step failed: ${message}`, fatal: false });
    this.failTurn(message);
  }

  private onPermissionAsk(obj: unknown): void {
    const permissionId = strField(obj, 'permissionID') ?? strField(obj, 'id');
    if (permissionId === undefined) return;
    // 1.18 `permission.asked` carries `permission` (tool name) instead of a title
    const title = strField(obj, 'title') ?? strField(obj, 'permission') ?? 'permission request';
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
    const permissionId = strField(obj, 'permissionID') ?? strField(obj, 'requestID') ?? strField(obj, 'id');
    if (permissionId === undefined) return;
    // 1.18 `permission.replied` carries the decision as `reply`
    const status = strField(obj, 'reply') ?? strField(obj, 'status') ?? strField(obj, 'decision') ?? '';
    if (status !== 'once' && status !== 'always' && status !== 'rejected' && status !== 'reject') return;
    this.deps.broadcaster.broadcast({
      type: 'permission.resolved',
      permissionId,
      decision: status === 'rejected' ? 'reject' : status,
    });
  }

  private onError(obj: unknown): void {
    const message = errorText(field(obj, 'error')) ?? strField(obj, 'message') ?? 'unknown opencode error';
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

  /**
   * Every 2s: fallback-poll messages when the session event bus went silent >10s;
   * safety-finalize after 30s of silence (measured from the last session event,
   * NOT from SSE activity — 1.18 sends server.heartbeat frames every 10s that
   * must not keep a hung turn alive).
   */
  tick(): void {
    if (!this.busy) return;
    const silentFor = Date.now() - this.lastSessionEventAt;
    if (silentFor > QUIET_FINALIZE_MS) {
      this.finalizeTurn(this.lastSummary);
      return;
    }
    if (silentFor > FALLBACK_POLL_AFTER_MS) void this.pollFallback();
  }

  /**
   * Fallback when SSE events were missed: polls GET /session/:id/message
   * (returns [{info, parts}]) and diffs per-message assistant text length.
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
      const time = field(info, 'time');
      const end = numField(time, 'completed') || numField(time, 'end');
      if (end > 0 && !this.messageDone.has(id)) {
        this.messageDone.add(id);
        this.deps.broadcaster.broadcast({ type: 'message.completed', role: 'assistant', text });
        this.finalizeTurn(text);
        return;
      }
    }
  }
}
