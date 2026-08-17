/**
 * OpenAI Codex runtime wrapper.
 *
 * Integration surface is `codex app-server` (JSON-RPC over stdio) — the same
 * layer the official VS Code / JetBrains plugins use. `codex exec --json` is
 * unusable here because it has no approval prompts, which the acceptEdits/ask
 * modes need.
 *
 * The production RealCodexRunner spawns the binary and speaks JSON-RPC through
 * `JsonRpcEndpoint`; the smoke test spawns a fake app-server that replies with
 * the same message shapes, so all of this code path is exercised without the
 * real binary and without network.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  AgentMode,
  ModelInfo,
  PermissionDecision,
  PermissionKind,
  TokenUsage,
} from '@pocketagent/protocol';
import { JsonRpcEndpoint, type ServerRequestReply } from './jsonrpc.js';

/** Error that maps to a synchronous 4xx response instead of a turn.failed event. */
export class PromptError extends Error {}

export interface PromptOptions {
  provider?: string;
  model?: string;
  mode?: AgentMode;
  /** Codex has no public reasoning knob wired here; accepted and ignored. */
  reasoningEffort?: string;
}

export interface PromptOutcome {
  aborted: boolean;
  errorMessage?: string;
  summary?: string;
  usage?: TokenUsage;
}

export interface RunnerStatus {
  sessionRef?: string;
  provider?: string;
  model?: string;
  mode: AgentMode;
  busy: boolean;
}

export interface CodexRunner {
  readonly kind: 'codex' | 'fake';
  init(): Promise<void>;
  listModels?(): ModelInfo[];
  prompt(text: string, options?: PromptOptions): Promise<PromptOutcome>;
  abort(): Promise<void>;
  resume(sessionRef: string): Promise<void>;
  status(): RunnerStatus;
  resolvePermission(permissionId: string, decision: PermissionDecision): boolean;
  dispose(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Mode -> Codex policy mapping                                         */
/* ------------------------------------------------------------------ */

export type CodexApprovalPolicy = 'never' | 'on-request' | 'untrusted';
export type CodexSandboxMode = 'danger-full-access' | 'workspace-write';
export type CodexDecision = 'accept' | 'decline' | 'acceptWithExecpolicyAmendment';

export interface CodexPolicy {
  approvalPolicy: CodexApprovalPolicy;
  sandboxMode: CodexSandboxMode;
  networkAccess: boolean;
}

/**
 * PocketAgent mode -> Codex `approval_policy` + `sandbox_mode`.
 *  - yolo:       never    + danger-full-access (the container is the sandbox)
 *  - auto:       never    + workspace-write (+ network access)
 *  - acceptEdits on-request+ workspace-write (file changes auto-accepted, commands forwarded)
 *  - ask:        untrusted+ workspace-write (everything forwarded)
 */
export function mapMode(mode: AgentMode): CodexPolicy {
  switch (mode) {
    case 'yolo':
      return { approvalPolicy: 'never', sandboxMode: 'danger-full-access', networkAccess: true };
    case 'auto':
      return { approvalPolicy: 'never', sandboxMode: 'workspace-write', networkAccess: true };
    case 'acceptEdits':
      return { approvalPolicy: 'on-request', sandboxMode: 'workspace-write', networkAccess: false };
    case 'ask':
      return { approvalPolicy: 'untrusted', sandboxMode: 'workspace-write', networkAccess: false };
  }
}

/* ------------------------------------------------------------------ */
/* Event normalization (codex notifications -> AgentEvent)             */
/* ------------------------------------------------------------------ */

/** Normalize a codex item type (`command_execution`, `commandExecution`, ...). */
export function normItemType(raw: unknown): string {
  return typeof raw === 'string' ? raw.toLowerCase().replace(/[_-]/g, '') : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function commandText(item: Record<string, unknown>): string {
  const command = item.command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) return command.filter((c) => typeof c === 'string').join(' ');
  return '';
}

function firstChangedPath(item: Record<string, unknown>): string | undefined {
  const direct = str(item.path);
  if (direct) return direct;
  const changes = item.changes;
  if (Array.isArray(changes)) {
    for (const change of changes) {
      const path = str(asRecord(change).path);
      if (path) return path;
    }
  }
  return undefined;
}

function usageFrom(params: Record<string, unknown>): TokenUsage | undefined {
  const raw = asRecord(params.usage);
  const input = num(raw.inputTokens) ?? num(raw.input_tokens) ?? num(raw.input);
  const output = num(raw.outputTokens) ?? num(raw.output_tokens) ?? num(raw.output);
  const costUsd = num(raw.costUsd) ?? num(raw.cost_usd) ?? num(raw.cost);
  if (input === undefined && output === undefined && costUsd === undefined) return undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/**
 * Map a codex app-server notification onto zero or more protocol events.
 * `itemTypes` tracks id -> normalized item type across started/delta/completed
 * so a delta that omits the type can still be classified. Unknown methods and
 * item types are ignored (forward-compatible with newer app-server versions).
 *
 * turn/completed and turn/failed are NOT emitted here: they resolve the active
 * prompt() promise so index.ts can attach the auto-commit sha to turn.completed.
 */
export function normalizeCodexNotification(
  method: string,
  rawParams: unknown,
  itemTypes: Map<string, string>,
): AgentEvent[] {
  const params = asRecord(rawParams);

  // item/<segment>/delta or item/delta
  const deltaMatch = /^item\/(.+)\/delta$/.exec(method);
  if (deltaMatch || method === 'item/delta') {
    const itemId = str(params.itemId) ?? str(params.id);
    const type = deltaMatch
      ? normItemType(deltaMatch[1])
      : normItemType(params.itemType) || (itemId ? itemTypes.get(itemId) ?? '' : '');
    const delta = str(params.delta) ?? str(params.text) ?? '';
    if (type === 'agentmessage' && delta) {
      return [{ type: 'message.delta', role: 'assistant', delta }];
    }
    // reasoning deltas carry chain-of-thought; the protocol has no thinking
    // channel, so drop them. command_execution output deltas have no slot
    // either (the final tool.result carries the aggregated output).
    return [];
  }

  if (method === 'item/started') {
    const item = asRecord(params.item);
    const id = str(item.id) ?? str(params.itemId) ?? randomUUID();
    const type = normItemType(item.type ?? item.itemType ?? params.itemType);
    itemTypes.set(id, type);
    if (type === 'commandexecution') {
      const command = commandText(item);
      return [
        {
          type: 'tool.call',
          id,
          tool: 'shell',
          input: { command },
          title: `bash: ${command.slice(0, 80)}`,
        },
      ];
    }
    if (type === 'filechange') {
      const path = firstChangedPath(item);
      return [
        {
          type: 'tool.call',
          id,
          tool: 'apply_patch',
          input: item.changes ?? { path },
          ...(path ? { title: path } : {}),
        },
      ];
    }
    return [];
  }

  if (method === 'item/completed') {
    const item = asRecord(params.item);
    const id = str(item.id) ?? str(params.itemId) ?? '';
    const type = normItemType(item.type ?? item.itemType ?? params.itemType) || itemTypes.get(id) || '';
    if (type === 'agentmessage') {
      const text = str(item.text) ?? str(item.message) ?? '';
      return text ? [{ type: 'message.completed', role: 'assistant', text }] : [];
    }
    if (type === 'commandexecution') {
      const output = str(item.aggregatedOutput) ?? str(item.output) ?? str(item.stdout) ?? '';
      const exitCode = num(item.exitCode) ?? num(item.exit_code);
      return [
        {
          type: 'tool.result',
          id,
          tool: 'shell',
          output,
          ...(exitCode !== undefined && exitCode !== 0 ? { isError: true } : {}),
        },
      ];
    }
    if (type === 'filechange') {
      return [{ type: 'tool.result', id, tool: 'apply_patch', output: 'applied' }];
    }
    return [];
  }

  // Unknown notification: ignore tolerantly.
  return [];
}

/* ------------------------------------------------------------------ */
/* Approval routing (server-initiated requestApproval -> app / auto)   */
/* ------------------------------------------------------------------ */

export type CodexApprovalKind = 'command' | 'fileChange';

export interface ApprovalInfo {
  title: string;
  detail?: string;
  diff?: string;
  patterns?: string[];
}

interface PendingApproval {
  settle(decision: PermissionDecision): void;
  timer: NodeJS.Timeout;
}

/**
 * Decides how a codex approval request is answered:
 *  - yolo/auto: auto-accept (should not occur under approval_policy=never)
 *  - acceptEdits: file changes auto-accept; commands forwarded to the app
 *  - ask: everything forwarded to the app
 * A forwarded request emits permission.request and blocks on /permissions/:id;
 * a timeout declines. `always` on a command becomes an execpolicy amendment.
 */
export class ApprovalRouter {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly emit: (event: AgentEvent) => void,
    private readonly getMode: () => AgentMode,
    private readonly timeoutMs: number,
  ) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  async route(kind: CodexApprovalKind, info: ApprovalInfo): Promise<CodexDecision> {
    const mode = this.getMode();
    if (mode === 'yolo' || mode === 'auto') return 'accept';
    if (mode === 'acceptEdits' && kind === 'fileChange') return 'accept';

    const permissionId = randomUUID();
    const permKind: PermissionKind = kind === 'command' ? 'bash' : 'edit';
    this.emit({
      type: 'permission.request',
      permissionId,
      kind: permKind,
      title: info.title,
      ...(info.detail !== undefined ? { detail: info.detail } : {}),
      ...(info.diff !== undefined ? { diff: info.diff } : {}),
      ...(info.patterns !== undefined ? { patterns: info.patterns } : {}),
    });
    const decision = await this.awaitDecision(permissionId);
    return toCodexDecision(decision, kind);
  }

  resolve(permissionId: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(permissionId);
    if (!pending) return false;
    this.pending.delete(permissionId);
    clearTimeout(pending.timer);
    this.emit({ type: 'permission.resolved', permissionId, decision });
    pending.settle(decision);
    return true;
  }

  /** Deny everything still outstanding (used on abort / shutdown). */
  drainDenied(): void {
    for (const [permissionId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.emit({ type: 'permission.resolved', permissionId, decision: 'reject' });
      pending.settle('reject');
    }
    this.pending.clear();
  }

  private awaitDecision(permissionId: string): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(permissionId)) {
          this.emit({ type: 'permission.resolved', permissionId, decision: 'reject' });
          this.emit({
            type: 'error',
            message: `permission ${permissionId} timed out after ${this.timeoutMs}ms; declined`,
          });
          resolve('reject');
        }
      }, this.timeoutMs);
      this.pending.set(permissionId, { settle: resolve, timer });
    });
  }
}

function toCodexDecision(decision: PermissionDecision, kind: CodexApprovalKind): CodexDecision {
  if (decision === 'reject') return 'decline';
  if (decision === 'always' && kind === 'command') return 'acceptWithExecpolicyAmendment';
  return 'accept';
}

/* ------------------------------------------------------------------ */
/* Device-code login output parsing                                    */
/* ------------------------------------------------------------------ */

export interface DeviceCodePrompt {
  verificationUrl: string;
  userCode: string;
}

const USER_CODE_RE = /\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/;
const URL_RE = /\bhttps?:\/\/\S+/;

/**
 * Best-effort parse of one `codex login --device-auth` output line. The CLI
 * prints a verification URL and a user code; we surface them to the app via a
 * notice event. Matches lines that carry a code (with or without the URL on the
 * same line); returns undefined for lines without a recognizable code.
 */
export function parseDeviceCodePrompt(line: string): DeviceCodePrompt | undefined {
  const code = USER_CODE_RE.exec(line);
  if (!code) return undefined;
  const url = URL_RE.exec(line);
  return { verificationUrl: url ? url[0] : '', userCode: code[1] as string };
}

/* ------------------------------------------------------------------ */
/* Real runner: drives `codex app-server`                              */
/* ------------------------------------------------------------------ */

export interface RealCodexRunnerOptions {
  workDir: string;
  codexHome: string;
  mode: AgentMode;
  provider?: string;
  model?: string;
  permissionTimeoutMs: number;
  emit: (event: AgentEvent) => void;
  /** Binary + args to spawn; defaults to `codex app-server --ignore-user-config`. */
  command?: string;
  args?: string[];
  overloadRetries?: number;
}

interface ActiveTurn {
  resolve(outcome: PromptOutcome): void;
  settled: boolean;
  summary?: string;
  turnId?: string;
}

export class RealCodexRunner implements CodexRunner {
  readonly kind = 'codex' as const;

  private mode: AgentMode;
  private model?: string;
  private child?: ChildProcessWithoutNullStreams;
  private rpc?: JsonRpcEndpoint;
  private threadId?: string;
  private busy = false;
  private active?: ActiveTurn;
  private readonly router: ApprovalRouter;
  private readonly itemTypes = new Map<string, string>();

  constructor(private readonly options: RealCodexRunnerOptions) {
    this.mode = options.mode;
    this.model = options.model;
    this.router = new ApprovalRouter(options.emit, () => this.mode, options.permissionTimeoutMs);
  }

  async init(): Promise<void> {
    const command = this.options.command ?? 'codex';
    const args = this.options.args ?? ['app-server', '--ignore-user-config'];
    const child = spawn(command, args, {
      cwd: this.options.workDir,
      env: { ...process.env, CODEX_HOME: this.options.codexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    child.on('error', (error) => {
      this.options.emit({ type: 'error', message: `codex app-server spawn failed: ${error.message}`, fatal: true });
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const line = chunk.trim();
      if (line.length > 0) console.error(`[codex app-server] ${line}`);
    });
    child.on('exit', (code, signal) => {
      if (this.active && !this.active.settled) {
        this.settleActive({ aborted: false, errorMessage: `codex app-server exited (code=${code} signal=${signal})` });
      }
    });
    this.child = child;

    const rpc = new JsonRpcEndpoint(child.stdin, child.stdout, {
      overloadRetries: this.options.overloadRetries ?? 5,
    });
    rpc.onNotification((method, params) => this.onNotification(method, params));
    rpc.onServerRequest((method, params, reply) => this.onServerRequest(method, params, reply));
    this.rpc = rpc;

    // Handshake: initialize (request) then initialized (notification).
    await rpc.request('initialize', {
      clientInfo: { name: 'pocketagent-codex-shim', version: '0.1.0' },
    }, { timeoutMs: 30_000, retryOnOverload: true });
    rpc.notify('initialized', {});

    // Start a thread bound to the workspace; carries the initial policy.
    const policy = mapMode(this.mode);
    const started = await rpc.request<{ threadId?: string }>(
      'thread/start',
      {
        cwd: this.options.workDir,
        approvalPolicy: policy.approvalPolicy,
        sandboxMode: policy.sandboxMode,
        networkAccess: policy.networkAccess,
        ...(this.model ? { model: this.model } : {}),
      },
      { timeoutMs: 30_000, retryOnOverload: true },
    );
    this.threadId = str(asRecord(started).threadId);
  }

  listModels(): ModelInfo[] {
    // Codex resolves model ids server-side; the shim ships no static catalog.
    return [];
  }

  async prompt(text: string, options?: PromptOptions): Promise<PromptOutcome> {
    if (this.busy) throw new PromptError('prompt already running');
    if (!this.rpc || !this.threadId) throw new PromptError('runner not initialized');
    if (options?.mode) this.mode = options.mode;
    if (options?.model !== undefined) this.model = options.model.length > 0 ? options.model : undefined;

    this.busy = true;
    const policy = mapMode(this.mode);
    const turnPromise = new Promise<PromptOutcome>((resolve) => {
      this.active = { resolve, settled: false };
    });
    try {
      const result = await this.rpc.request<{ turnId?: string }>(
        'turn/start',
        {
          threadId: this.threadId,
          input: [{ type: 'text', text }],
          approvalPolicy: policy.approvalPolicy,
          sandboxMode: policy.sandboxMode,
          networkAccess: policy.networkAccess,
          ...(this.model ? { model: this.model } : {}),
        },
        { timeoutMs: 60_000, retryOnOverload: true },
      );
      if (this.active) this.active.turnId = str(asRecord(result).turnId);
    } catch (error) {
      this.settleActive({ aborted: false, errorMessage: errText(error) });
    }
    const outcome = await turnPromise;
    this.busy = false;
    return outcome;
  }

  async abort(): Promise<void> {
    this.router.drainDenied();
    const turnId = this.active?.turnId;
    try {
      await this.rpc?.request('turn/interrupt', { threadId: this.threadId, turnId }, { timeoutMs: 15_000 });
    } catch {
      /* interrupt best-effort: settle locally regardless */
    }
    this.settleActive({ aborted: true, summary: this.active?.summary });
  }

  async resume(sessionRef: string): Promise<void> {
    if (this.busy) throw new PromptError('cannot resume while a prompt is running');
    if (!this.rpc) throw new PromptError('runner not initialized');
    const result = await this.rpc.request<{ threadId?: string }>(
      'thread/resume',
      { threadId: sessionRef },
      { timeoutMs: 30_000, retryOnOverload: true },
    );
    this.threadId = str(asRecord(result).threadId) ?? sessionRef;
  }

  status(): RunnerStatus {
    return {
      sessionRef: this.threadId,
      provider: this.options.provider ?? 'openai',
      model: this.model,
      mode: this.mode,
      busy: this.busy,
    };
  }

  resolvePermission(permissionId: string, decision: PermissionDecision): boolean {
    return this.router.resolve(permissionId, decision);
  }

  /** Graceful SIGTERM drain: ask the server to shut down, then kill the child. */
  async dispose(): Promise<void> {
    this.router.drainDenied();
    try {
      this.rpc?.notify('shutdown', {});
    } catch {
      /* ignore */
    }
    this.rpc?.close();
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3_000);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /* ---------------- internals ---------------- */

  private settleActive(outcome: PromptOutcome): void {
    const active = this.active;
    if (!active || active.settled) return;
    active.settled = true;
    this.active = undefined;
    this.busy = false;
    active.resolve(outcome);
  }

  private onNotification(method: string, params: unknown): void {
    if (method === 'turn/completed') {
      const usage = usageFrom(asRecord(params));
      this.settleActive({ aborted: false, summary: this.active?.summary, ...(usage ? { usage } : {}) });
      return;
    }
    if (method === 'turn/failed') {
      const error = asRecord(asRecord(params).error);
      const message = str(error.message) ?? str(asRecord(params).message) ?? 'turn failed';
      this.settleActive({ aborted: false, errorMessage: message });
      return;
    }
    // Track final assistant text as the turn summary while normalizing.
    for (const event of normalizeCodexNotification(method, params, this.itemTypes)) {
      if (event.type === 'message.completed' && event.role === 'assistant' && this.active) {
        this.active.summary = event.text;
      }
      this.options.emit(event);
    }
  }

  private onServerRequest(method: string, rawParams: unknown, reply: ServerRequestReply): void {
    const params = asRecord(rawParams);
    if (/commandexecution/i.test(method.replace(/[_-]/g, '')) && /approval/i.test(method)) {
      const command = commandText(params);
      void this.routeApproval(reply, 'command', {
        title: `bash: ${command.slice(0, 100)}`,
        detail: command,
        patterns: ['bash'],
      });
      return;
    }
    if (/filechange/i.test(method.replace(/[_-]/g, '')) && /approval/i.test(method)) {
      const path = firstChangedPath(params) ?? '(file change)';
      void this.routeApproval(reply, 'fileChange', {
        title: `edit: ${path}`,
        detail: path,
      });
      return;
    }
    // Unknown server request: decline politely.
    reply.respondError(-32601, `unhandled server request ${method}`);
  }

  private async routeApproval(reply: ServerRequestReply, kind: CodexApprovalKind, info: ApprovalInfo): Promise<void> {
    try {
      const decision = await this.router.route(kind, info);
      reply.respond({ decision });
    } catch (error) {
      reply.respondError(-32603, `approval routing failed: ${errText(error)}`);
    }
  }
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
