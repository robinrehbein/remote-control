/**
 * Claude Code SDK wrapper + session orchestration.
 *
 * Runner abstraction: the production SdkRunner talks to
 * @anthropic-ai/claude-agent-sdk (streaming-input mode); smoke tests inject a
 * FakeRunner emitting the same RunnerMessage stream.
 */
import type {
  AgentEvent,
  AgentMode,
  PermissionDecision,
  PermissionKind,
  ShimStatus,
  TokenUsage,
} from '@pocketagent/protocol';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  Options,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* Runner abstraction                                                  */
/* ------------------------------------------------------------------ */

export type RunnerPermissionDecision =
  | { behavior: 'allow'; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string };

export type RunnerMessage =
  | { kind: 'delta'; text: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool_call'; id: string; tool: string; input: unknown }
  | { kind: 'tool_result'; id: string; output: string; isError: boolean }
  | {
      kind: 'result';
      success: boolean;
      subtype: string;
      summary?: string;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      sessionId?: string;
      errors: string[];
    };

export interface RunnerConfig {
  cwd: string;
  permissionMode: PermissionMode;
  model?: string;
  resumeSessionId?: string;
}

export interface RunnerCallbacks {
  onRunnerMessage(msg: RunnerMessage): void;
  onRunnerSessionId(sessionId: string): void;
  onRunnerError(message: string): void;
  requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    suggestions?: PermissionUpdate[],
  ): Promise<RunnerPermissionDecision>;
}

export interface ClaudeRunner {
  isAlive(): boolean;
  start(): Promise<void>;
  sendPrompt(text: string): void;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  abort(): Promise<void>;
  close(): void;
}

export type RunnerFactory = (config: RunnerConfig, callbacks: RunnerCallbacks) => ClaudeRunner;

export function mapMode(mode: AgentMode): PermissionMode {
  switch (mode) {
    case 'yolo':
      return 'bypassPermissions';
    case 'auto':
      return 'auto';
    case 'acceptEdits':
      return 'acceptEdits';
    case 'ask':
      return 'default';
  }
}

/* ------------------------------------------------------------------ */
/* Production runner (official Agent SDK, streaming input)             */
/* ------------------------------------------------------------------ */

/** Unbounded push queue used as the query's streaming input. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: SDKUserMessage[] = [];
  private readonly waiters: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];

  push(msg: SDKUserMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: msg, done: false });
    else this.pending.push(msg);
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return this;
  }

  next(): Promise<IteratorResult<SDKUserMessage>> {
    const msg = this.pending.shift();
    if (msg) return Promise.resolve({ value: msg, done: false });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

class SdkRunner implements ClaudeRunner {
  private q: Query | null = null;
  private controller: AbortController | null = null;
  private input: MessageQueue | null = null;
  private alive = false;
  private aborting = false;

  constructor(
    private readonly config: RunnerConfig,
    private readonly cb: RunnerCallbacks,
  ) {}

  isAlive(): boolean {
    return this.alive;
  }

  async start(): Promise<void> {
    this.controller = new AbortController();
    this.input = new MessageQueue();
    const options: Options = {
      cwd: this.config.cwd,
      permissionMode: this.config.permissionMode,
      includePartialMessages: true,
      abortController: this.controller,
      env: { ...process.env, IS_SANDBOX: '1' },
      canUseTool: this.canUseTool,
    };
    if (this.config.model) options.model = this.config.model;
    if (this.config.resumeSessionId) options.resume = this.config.resumeSessionId;
    if (this.config.permissionMode === 'bypassPermissions') {
      options.allowDangerouslySkipPermissions = true;
    }
    this.q = query({ prompt: this.input, options });
    this.alive = true;
    void this.consume(this.q);
  }

  sendPrompt(text: string): void {
    if (!this.alive || !this.input) throw new Error('runner not started');
    this.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
  }

  async setModel(model?: string): Promise<void> {
    await this.q?.setModel(model);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.q?.setPermissionMode(mode);
  }

  /** Graceful interrupt first; AbortController guarantees loop termination
   *  even if the CLI does not support interrupt receipts. After abort the
   *  runner is dead and gets recreated (with resume) on the next prompt. */
  async abort(): Promise<void> {
    this.aborting = true;
    try {
      await this.q?.interrupt();
    } catch {
      /* older CLI without interrupt support */
    }
    this.controller?.abort();
  }

  close(): void {
    this.alive = false;
    this.controller?.abort();
    this.q?.close();
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const msg of q) this.dispatch(msg);
      this.alive = false;
      if (!this.aborting) this.cb.onRunnerError('claude process exited unexpectedly');
    } catch (err) {
      this.alive = false;
      if (!this.aborting) {
        this.cb.onRunnerError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      this.aborting = false;
    }
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const decision = await this.cb.requestPermission(toolName, input, options.suggestions);
    const result: PermissionResult =
      decision.behavior === 'allow'
        ? {
            behavior: 'allow',
            ...(decision.updatedPermissions
              ? { updatedPermissions: decision.updatedPermissions }
              : {}),
            decisionClassification: decision.updatedPermissions
              ? 'user_permanent'
              : 'user_temporary',
          }
        : {
            behavior: 'deny',
            message: decision.message,
            decisionClassification: 'user_reject',
          };
    return result;
  };

  /** SDKMessage -> narrow RunnerMessage (replayed history is skipped). */
  private dispatch(msg: SDKMessage): void {
    if (msg.session_id) this.cb.onRunnerSessionId(msg.session_id);

    if (msg.type === 'stream_event') {
      const ev = msg.event;
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        this.cb.onRunnerMessage({ kind: 'delta', text: ev.delta.text });
      }
      return;
    }

    if (msg.type === 'assistant') {
      let text = '';
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          text += block.text;
        } else if (block.type === 'tool_use') {
          this.cb.onRunnerMessage({
            kind: 'tool_call',
            id: block.id,
            tool: block.name,
            input: block.input,
          });
        }
      }
      if (text) this.cb.onRunnerMessage({ kind: 'assistant_text', text });
      return;
    }

    if (msg.type === 'user') {
      if ('isReplay' in msg && msg.isReplay) return;
      const content = msg.message.content;
      if (typeof content !== 'string') {
        for (const block of content) {
          if (block.type === 'tool_result') {
            this.cb.onRunnerMessage({
              kind: 'tool_result',
              id: block.tool_use_id,
              output: stringifyToolResult(block.content),
              isError: block.is_error === true,
            });
          }
        }
      }
      return;
    }

    if (msg.type === 'result') {
      const success = msg.subtype === 'success';
      this.cb.onRunnerMessage({
        kind: 'result',
        success,
        subtype: msg.subtype,
        summary: success ? msg.result : undefined,
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        costUsd: msg.total_cost_usd,
        sessionId: msg.session_id,
        errors: success ? [] : [...msg.errors],
      });
    }
  }
}

function stringifyToolResult(
  content: string | Array<{ type: string; text?: string }> | undefined,
): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  const text = content
    .map((b) => (b.type === 'text' ? (b.text ?? '') : `[{${b.type}}]`))
    .join('\n');
  return text;
}

export const sdkRunnerFactory: RunnerFactory = (config, callbacks) =>
  new SdkRunner(config, callbacks);

/* ------------------------------------------------------------------ */
/* Auth bootstrap                                                      */
/* ------------------------------------------------------------------ */

/** Suppress onboarding prompts: ~/.claude.json with 0600 before first query. */
export async function writeClaudeAuthBootstrap(): Promise<void> {
  const cfgPath = path.join(os.homedir(), '.claude.json');
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    /* fresh container */
  }
  const merged = {
    ...existing,
    hasCompletedOnboarding: true,
    primaryApiKey: false,
  };
  await fs.writeFile(cfgPath, JSON.stringify(merged), { mode: 0o600 });
  try {
    await fs.chmod(cfgPath, 0o600);
  } catch {
    /* best effort */
  }
}

export function hasCredentials(): boolean {
  return Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
}

/* ------------------------------------------------------------------ */
/* Session orchestration                                               */
/* ------------------------------------------------------------------ */

interface PendingPermission {
  resolve(decision: RunnerPermissionDecision): void;
  suggestions?: PermissionUpdate[];
}

export interface ClaudeSessionDeps {
  cwd: string;
  mode: AgentMode;
  model?: string;
  autoPush: boolean;
  runnerFactory: RunnerFactory;
  publish(event: AgentEvent): void;
  commitTurn(): Promise<string>;
  pushBranch(): Promise<{ branch: string; prUrl?: string } | undefined>;
}

const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;

export class ClaudeSession {
  private mode: AgentMode;
  private model?: string;
  private sessionId?: string;
  private busy = false;
  private runner: ClaudeRunner | null = null;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly toolNames = new Map<string, string>();

  constructor(private readonly deps: ClaudeSessionDeps) {
    this.mode = deps.mode;
    this.model = deps.model;
  }

  status(): ShimStatus {
    return {
      adapter: 'claude',
      sessionRef: this.sessionId,
      provider: 'anthropic',
      model: this.model,
      mode: this.mode,
      busy: this.busy,
    };
  }

  private publishStatus(): void {
    const s = this.status();
    this.deps.publish({
      type: 'status',
      adapter: s.adapter,
      sessionRef: s.sessionRef,
      provider: s.provider,
      model: s.model,
      mode: s.mode,
      busy: s.busy,
    });
  }

  private readonly runnerCallbacks: RunnerCallbacks = {
    onRunnerMessage: (msg) => this.handleRunnerMessage(msg),
    onRunnerSessionId: (id) => {
      this.sessionId = id;
    },
    onRunnerError: (message) => this.handleRunnerError(message),
    requestPermission: (toolName, input, suggestions) =>
      this.requestPermission(toolName, input, suggestions),
  };

  private async ensureRunner(): Promise<{ runner: ClaudeRunner; reused: boolean }> {
    if (this.runner?.isAlive()) return { runner: this.runner, reused: true };
    this.runner?.close();
    const runner = this.deps.runnerFactory(
      {
        cwd: this.deps.cwd,
        permissionMode: mapMode(this.mode),
        model: this.model,
        resumeSessionId: this.sessionId,
      },
      this.runnerCallbacks,
    );
    await runner.start();
    this.runner = runner;
    return { runner, reused: false };
  }

  async prompt(text: string, opts?: { mode?: AgentMode; model?: string }): Promise<void> {
    if (this.busy) throw new Error('busy');
    if (opts?.mode) this.mode = opts.mode;
    if (opts?.model) this.model = opts.model;
    const { runner, reused } = await this.ensureRunner();
    if (reused) {
      if (opts?.mode) {
        try {
          await runner.setPermissionMode(mapMode(opts.mode));
        } catch {
          /* control request unsupported */
        }
      }
      if (opts?.model) {
        try {
          await runner.setModel(opts.model);
        } catch {
          /* control request unsupported */
        }
      }
    }
    this.busy = true;
    this.publishStatus();
    runner.sendPrompt(text);
  }

  async abort(): Promise<void> {
    this.settlePendingAsDenied();
    try {
      await this.runner?.abort();
    } catch {
      /* ignore */
    }
    this.busy = false;
    this.publishStatus();
  }

  async resume(sessionRef: string): Promise<void> {
    if (this.busy) throw new Error('busy');
    this.sessionId = sessionRef;
    this.runner?.close();
    this.runner = null;
    await this.ensureRunner();
    this.publishStatus();
  }

  private handleRunnerMessage(msg: RunnerMessage): void {
    switch (msg.kind) {
      case 'delta':
        this.deps.publish({ type: 'message.delta', role: 'assistant', delta: msg.text });
        break;
      case 'assistant_text':
        this.deps.publish({ type: 'message.completed', role: 'assistant', text: msg.text });
        break;
      case 'tool_call':
        this.toolNames.set(msg.id, msg.tool);
        this.deps.publish({
          type: 'tool.call',
          id: msg.id,
          tool: msg.tool,
          input: msg.input,
          title: toolTitle(msg.tool, msg.input),
        });
        break;
      case 'tool_result':
        this.deps.publish({
          type: 'tool.result',
          id: msg.id,
          tool: this.toolNames.get(msg.id) ?? 'unknown',
          output: msg.output,
          isError: msg.isError,
        });
        break;
      case 'result':
        void this.finishTurn(msg);
        break;
    }
  }

  private async finishTurn(msg: Extract<RunnerMessage, { kind: 'result' }>): Promise<void> {
    try {
      if (msg.sessionId) this.sessionId = msg.sessionId;
      if (msg.success) {
        let commitSha: string | undefined;
        try {
          commitSha = await this.deps.commitTurn();
        } catch (err) {
          this.deps.publish({
            type: 'error',
            message: `auto-commit failed: ${errMessage(err)}`,
          });
        }
        const usage: TokenUsage = {};
        if (msg.inputTokens !== undefined) usage.input = msg.inputTokens;
        if (msg.outputTokens !== undefined) usage.output = msg.outputTokens;
        if (msg.costUsd !== undefined) usage.costUsd = msg.costUsd;
        this.deps.publish({
          type: 'turn.completed',
          ...(msg.summary !== undefined ? { summary: msg.summary } : {}),
          usage,
          ...(commitSha !== undefined ? { commitSha } : {}),
        });
        if (this.deps.autoPush) {
          try {
            const pushed = await this.deps.pushBranch();
            if (pushed) {
              this.deps.publish({
                type: 'pushed',
                branch: pushed.branch,
                ...(pushed.prUrl !== undefined ? { prUrl: pushed.prUrl } : {}),
                auto: true,
              });
            }
          } catch (err) {
            this.deps.publish({ type: 'error', message: `push failed: ${errMessage(err)}` });
          }
        }
      } else {
        this.deps.publish({
          type: 'turn.failed',
          error: msg.errors.length > 0 ? msg.errors.join('; ') : `turn failed (${msg.subtype})`,
        });
      }
    } finally {
      this.busy = false;
      this.publishStatus();
    }
  }

  private handleRunnerError(message: string): void {
    if (this.busy) {
      this.busy = false;
      this.deps.publish({ type: 'turn.failed', error: message });
    } else {
      this.deps.publish({ type: 'error', message });
    }
    this.publishStatus();
  }

  /* ---------------- permission bridge ---------------- */

  private async requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    suggestions?: PermissionUpdate[],
  ): Promise<RunnerPermissionDecision> {
    const permissionId = randomUUID();
    const { kind, title, detail, diff } = describeToolUse(toolName, input);
    const patterns = (suggestions ?? [])
      .filter((s) => s.type === 'addRules')
      .flatMap((s) => s.rules.map((r) => [r.toolName, r.ruleContent].filter(Boolean).join(':')));
    this.deps.publish({
      type: 'permission.request',
      permissionId,
      kind,
      title,
      ...(detail !== undefined ? { detail } : {}),
      ...(diff !== undefined ? { diff } : {}),
      ...(patterns.length > 0 ? { patterns } : {}),
    });
    return new Promise<RunnerPermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(permissionId);
        resolve({ behavior: 'deny', message: 'PocketAgent: permission request timed out' });
      }, PERMISSION_TIMEOUT_MS);
      this.pendingPermissions.set(permissionId, {
        suggestions,
        resolve: (decision) => {
          clearTimeout(timer);
          resolve(decision);
        },
      });
    });
  }

  /** Returns false when the permissionId is unknown/expired. */
  replyPermission(permissionId: string, response: PermissionDecision): boolean {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) return false;
    this.pendingPermissions.delete(permissionId);
    const decision: RunnerPermissionDecision =
      response === 'reject'
        ? { behavior: 'deny', message: 'Rejected by user via PocketAgent' }
        : {
            behavior: 'allow',
            updatedPermissions: response === 'always' ? pending.suggestions : undefined,
          };
    pending.resolve(decision);
    this.deps.publish({ type: 'permission.resolved', permissionId, decision: response });
    return true;
  }

  private settlePendingAsDenied(): void {
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ behavior: 'deny', message: 'PocketAgent: turn aborted' });
    }
    this.pendingPermissions.clear();
  }

  close(): void {
    this.settlePendingAsDenied();
    this.runner?.close();
    this.runner = null;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function toolTitle(tool: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (tool === 'Bash' && typeof input.command === 'string') return truncate(input.command, 80);
  const filePath = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof filePath === 'string') return filePath;
  if (typeof input.url === 'string') return input.url;
  if (typeof input.description === 'string') return input.description;
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function pseudoDiff(
  filePath: string,
  oldString: unknown,
  newString: unknown,
): string | undefined {
  const header = `--- a/${filePath}\n+++ b/${filePath}\n@@ pseudo @@\n`;
  const parts: string[] = [];
  if (typeof oldString === 'string' && oldString.length > 0) {
    parts.push(oldString.split('\n').map((l) => `-${l}`).join('\n'));
  }
  if (typeof newString === 'string' && newString.length > 0) {
    parts.push(newString.split('\n').map((l) => `+${l}`).join('\n'));
  }
  if (parts.length === 0) return undefined;
  return header + parts.join('\n') + '\n';
}

function describeToolUse(toolName: string, input: Record<string, unknown>): {
  kind: PermissionKind;
  title: string;
  detail?: string;
  diff?: string;
} {
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : JSON.stringify(input);
    return {
      kind: 'bash',
      title: `bash: ${truncate(command, 100)}`,
      detail: command,
    };
  }
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    const filePath =
      typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.notebook_path === 'string'
          ? input.notebook_path
          : 'unknown';
    let diff: string | undefined;
    if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
      diff = input.edits
        .filter(isRecord)
        .map((e) => pseudoDiff(filePath, e.old_string, e.new_string) ?? '')
        .filter(Boolean)
        .join('\n');
    } else {
      diff = pseudoDiff(filePath, input.old_string, input.new_string);
    }
    return {
      kind: 'edit',
      title: `${toolName}: ${filePath}`,
      detail: filePath,
      diff,
    };
  }
  if (toolName === 'Write') {
    const filePath = typeof input.file_path === 'string' ? input.file_path : 'unknown';
    const content = typeof input.content === 'string' ? input.content : '';
    return {
      kind: 'edit',
      title: `Write: ${filePath}`,
      detail: filePath,
      diff: pseudoDiff(filePath, undefined, content),
    };
  }
  if (toolName === 'WebFetch') {
    const url = typeof input.url === 'string' ? input.url : '';
    return { kind: 'webfetch', title: `webfetch: ${truncate(url, 100)}`, detail: url };
  }
  if (toolName.startsWith('mcp__')) {
    return { kind: 'external', title: toolName, detail: JSON.stringify(input).slice(0, 2000) };
  }
  return { kind: 'other', title: toolName, detail: JSON.stringify(input).slice(0, 2000) };
}
