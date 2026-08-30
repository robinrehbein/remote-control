import { randomUUID } from 'node:crypto';
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
  type InlineExtension,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentEvent,
  AgentMode,
  ModelInfo,
  PermissionDecision,
  PermissionKind,
  ReasoningEffort,
  TokenUsage,
} from '@pocketagent/protocol';
import { PI_MODE_SEMANTICS } from '@pocketagent/protocol';

/** Error that maps to a synchronous 4xx response instead of a turn.failed event. */
export class PromptError extends Error {}

type PiModel = Parameters<AgentSession['setModel']>[0];

export interface PromptOptions {
  provider?: string;
  model?: string;
  mode?: AgentMode;
  /** Mapped onto the pi SDK's thinking level (same level names). */
  reasoningEffort?: ReasoningEffort;
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

export interface PiRunner {
  readonly kind: 'pi' | 'fake';
  init(): Promise<void>;
  validateModel(provider?: string, model?: string): Promise<void>;
  /** Optional model catalog for GET /models; absent -> empty list. */
  listModels?(): ModelInfo[];
  prompt(text: string, options?: PromptOptions): Promise<PromptOutcome>;
  abort(): Promise<void>;
  resume(sessionRef: string): Promise<void>;
  status(): RunnerStatus;
  resolvePermission(permissionId: string, decision: PermissionDecision): boolean;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/* Event normalization (pi AgentSessionEvent -> AgentEvent)            */
/* ------------------------------------------------------------------ */

interface AssistantLike {
  role: 'assistant';
  content: unknown;
  stopReason?: string;
  errorMessage?: string;
}

function isTextPart(part: unknown): part is { type: 'text'; text: string } {
  if (typeof part !== 'object' || part === null) return false;
  const candidate = part as { type?: unknown; text?: unknown };
  return candidate.type === 'text' && typeof candidate.text === 'string';
}

export function collectText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isTextPart)
    .map(part => part.text)
    .join('\n');
}

function toolResultOutput(result: unknown): string {
  if (typeof result === 'object' && result !== null && Array.isArray((result as { content?: unknown }).content)) {
    const text = collectText((result as { content: unknown[] }).content);
    if (text.length > 0) return text;
  }
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result) ?? '(no output)';
  } catch {
    return '(no output)';
  }
}

/** Map a pi session event onto zero or more normalized protocol events. */
export function normalizePiEvent(event: AgentSessionEvent): AgentEvent[] {
  switch (event.type) {
    case 'message_update':
      if (event.assistantMessageEvent.type === 'text_delta') {
        return [{ type: 'message.delta', role: 'assistant', delta: event.assistantMessageEvent.delta }];
      }
      return [];
    case 'message_end': {
      const message = event.message as unknown as { role?: string; content?: unknown };
      if (message.role === 'assistant') {
        const text = collectText(message.content);
        if (text.length > 0) return [{ type: 'message.completed', role: 'assistant', text }];
      }
      return [];
    }
    case 'tool_execution_start':
      return [{ type: 'tool.call', id: event.toolCallId, tool: event.toolName, input: event.args }];
    case 'tool_execution_end':
      return [
        {
          type: 'tool.result',
          id: event.toolCallId,
          tool: event.toolName,
          output: toolResultOutput(event.result),
          isError: event.isError,
        },
      ];
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ */
/* Permission gate (used by the real runner and the fake runner)       */
/* ------------------------------------------------------------------ */

const RISKY_BASH_PATTERNS: readonly RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)/i,
  /\bsudo\b/i,
  /\bgit\s+push\b/i,
  /\bnpm\s+publish\b/i,
  /(?:curl|wget)[^|;&]*\|\s*(?:ba|z|da)?sh\b/i,
  /\bdd\s+if=/i,
  /\bmkfs/i,
  /\b(shutdown|reboot|halt)\b/i,
  /chmod\s+-R\s+777/i,
  /\bdocker\s+system\s+prune\b/i,
  /\bkill(all)?\s+-9\b/i,
];

const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls']);

function isRiskyBash(command: string): boolean {
  return RISKY_BASH_PATTERNS.some(pattern => pattern.test(command));
}

interface Classification {
  kind: PermissionKind;
  key: string;
  title: string;
  detail?: string;
  diff?: string;
  patterns?: string[];
  command?: string;
}

function classifyToolCall(toolName: string, input: Record<string, unknown>): Classification {
  if (toolName === 'bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    const program = command.trim().split(/\s+/)[0] ?? '';
    const key = `bash:${program}`;
    return {
      kind: 'bash',
      key,
      title: `bash: ${command.slice(0, 120)}`,
      detail: command,
      patterns: [key],
      command,
    };
  }
  if (toolName === 'edit' || toolName === 'write') {
    const path = typeof input.path === 'string' ? input.path : '(unknown path)';
    const key = `edit:${path}`;
    const classification: Classification = {
      kind: 'edit',
      key,
      title: `${toolName}: ${path}`,
      detail: path,
      patterns: [key],
    };
    if (toolName === 'edit' && Array.isArray(input.edits)) {
      classification.diff = input.edits
        .filter((edit): edit is { oldText: string; newText: string } => {
          if (typeof edit !== 'object' || edit === null) return false;
          const candidate = edit as { oldText?: unknown; newText?: unknown };
          return typeof candidate.oldText === 'string' && typeof candidate.newText === 'string';
        })
        .map(edit =>
          [
            `--- a/${path}`,
            `+++ b/${path}`,
            ...edit.oldText.split('\n').map(line => `-${line}`),
            ...edit.newText.split('\n').map(line => `+${line}`),
          ].join('\n'),
        )
        .join('\n')
        // Wie beim write-Diff unten: der Permission-Request ist eine
        // Vorschau, kein vollständiger Patch - bei riesigen Multi-Edit-Aufrufen
        // auf 8192 Zeichen kappen.
        .slice(0, 8192);
    }
    if (toolName === 'write' && typeof input.content === 'string') {
      classification.diff = [`--- /dev/null`, `+++ b/${path}`, ...input.content.split('\n').map(line => `+${line}`)]
        .join('\n')
        .slice(0, 8192);
    }
    return classification;
  }
  // Unerreichbar für die feste Toolliste (['read','bash','edit','write','grep',
  // 'find','ls']): read/grep/find/ls sind Lese-Tools (in decide() vor dem
  // Klassifizieren freigegeben), bash/edit/write sind oben abgehandelt.
  // Sollte doch je ein unbekanntes, nicht-lesendes Tool hier landen, wird es
  // fail-closed als edit-Klasse behandelt (in ask gegated), nie stillschweigend
  // durchgewinkt.
  const key = `edit:${toolName}`;
  return { kind: 'edit', key, title: toolName, patterns: [key] };
}

export interface GateVerdict {
  block: boolean;
  reason?: string;
}

const ALLOW: GateVerdict = { block: false };

/**
 * Emits permission.request and awaits the orchestrator's /permissions/:id answer.
 * Gating per classification kind is read straight off `PI_MODE_SEMANTICS`
 * (@pocketagent/protocol) — the single source that App, Server and Runner all
 * read, so the modes cannot silently drift apart between the three. Reine
 * Lese-Tools (siehe READ_ONLY_TOOLS) werden in keinem Modus gegated, das ist
 * Eigenschaft des Tools und taucht in der Matrix bewusst nicht auf.
 * 'always' adds the suggested pattern to an in-memory allowlist for the session.
 */
export class PermissionGate {
  private readonly pending = new Map<string, (decision: PermissionDecision) => void>();
  private readonly alwaysAllowed = new Set<string>();

  constructor(
    private readonly emit: (event: AgentEvent) => void,
    private readonly getMode: () => AgentMode,
    private readonly timeoutMs: number,
  ) {}

  resolve(permissionId: string, decision: PermissionDecision): boolean {
    const settle = this.pending.get(permissionId);
    if (!settle) return false;
    this.pending.delete(permissionId);
    this.emit({ type: 'permission.resolved', permissionId, decision });
    settle(decision);
    return true;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  async decide(toolName: string, input: Record<string, unknown>): Promise<GateVerdict> {
    // Lese-Tools vor dem Klassifizieren freigeben - so klassifiziert der Gate nur
    // die tatsächlich genehmigungspflichtigen Tools (bash/edit/write).
    if (READ_ONLY_TOOLS.has(toolName)) return ALLOW;
    const classification = classifyToolCall(toolName, input);
    if (!this.gateRequired(classification)) return ALLOW;
    if (this.alwaysAllowed.has(classification.key)) return ALLOW;

    const permissionId = randomUUID();
    this.emit({
      type: 'permission.request',
      permissionId,
      kind: classification.kind,
      title: classification.title,
      detail: classification.detail,
      diff: classification.diff,
      patterns: classification.patterns,
    });
    const decision = await this.awaitDecision(permissionId);
    if (decision === 'reject') {
      return { block: true, reason: 'User rejected this tool call' };
    }
    if (decision === 'always') {
      for (const pattern of classification.patterns ?? [classification.key]) {
        this.alwaysAllowed.add(pattern);
      }
    }
    return ALLOW;
  }

  private awaitDecision(permissionId: string): Promise<PermissionDecision> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.pending.delete(permissionId)) {
          this.emit({ type: 'permission.resolved', permissionId, decision: 'reject' });
          this.emit({
            type: 'error',
            message: `permission ${permissionId} timed out after ${this.timeoutMs}ms; rejected`,
          });
          resolve('reject');
        }
      }, this.timeoutMs);
      this.pending.set(permissionId, decision => {
        clearTimeout(timer);
        resolve(decision);
      });
    });
  }

  private gateRequired(classification: Classification): boolean {
    const semantics = PI_MODE_SEMANTICS[this.getMode()];
    if (classification.kind === 'edit') return semantics.edits === 'all';
    // classification.kind === 'bash'
    if (semantics.bash === 'none') return false;
    if (semantics.bash === 'all') return true;
    return isRiskyBash(classification.command ?? '');
  }
}

/* ------------------------------------------------------------------ */
/* Real runner: embeds the pi SDK                                      */
/* ------------------------------------------------------------------ */

export interface RealPiRunnerOptions {
  workDir: string;
  agentDir: string;
  sessionDir: string;
  mode: AgentMode;
  provider?: string;
  model?: string;
  authPath: string;
  autoContinue: boolean;
  permissionTimeoutMs: number;
  emit: (event: AgentEvent) => void;
}

export class RealPiRunner implements PiRunner {
  readonly kind = 'pi' as const;

  private mode: AgentMode;
  private readonly gate: PermissionGate;
  private runtime?: ModelRuntime;
  private session?: AgentSession;
  private unsubscribe?: () => void;
  private busy = false;

  constructor(private readonly options: RealPiRunnerOptions) {
    this.mode = options.mode;
    this.gate = new PermissionGate(options.emit, () => this.mode, options.permissionTimeoutMs);
  }

  async init(): Promise<void> {
    this.runtime = await ModelRuntime.create({ authPath: this.options.authPath });
    const manager = this.options.autoContinue
      ? SessionManager.continueRecent(this.options.workDir, this.options.sessionDir)
      : SessionManager.create(this.options.workDir, this.options.sessionDir);
    await this.attach(manager, this.initialModel());
  }

  private initialModel(): PiModel | undefined {
    if (!this.options.provider || !this.options.model || !this.runtime) return undefined;
    const model = this.runtime.getModel(this.options.provider, this.options.model);
    if (!model) {
      this.options.emit({
        type: 'error',
        message: `unknown boot model ${this.options.provider}/${this.options.model}; continuing with default`,
      });
      return undefined;
    }
    return model;
  }

  private requireRuntime(): ModelRuntime {
    if (!this.runtime) throw new PromptError('runner not initialized');
    return this.runtime;
  }

  private requireSession(): AgentSession {
    if (!this.session) throw new PromptError('runner not initialized');
    return this.session;
  }

  private async attach(manager: SessionManager, model?: PiModel): Promise<void> {
    this.requireRuntime();
    const loader = new DefaultResourceLoader({
      cwd: this.options.workDir,
      agentDir: this.options.agentDir,
      noExtensions: true,
      noThemes: true,
      extensionFactories: [this.gateExtension()],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: this.options.workDir,
      agentDir: this.options.agentDir,
      modelRuntime: this.requireRuntime(),
      sessionManager: manager,
      resourceLoader: loader,
      model,
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
    });
    this.unsubscribe?.();
    this.session?.dispose();
    this.session = session;
    this.unsubscribe = session.subscribe(event => {
      for (const normalized of normalizePiEvent(event)) this.options.emit(normalized);
    });
  }

  private gateExtension(): InlineExtension {
    return {
      name: 'pocketagent-permissions',
      factory: pi => {
        pi.on('tool_call', async event => {
          const input = (event.input ?? {}) as Record<string, unknown>;
          const verdict = await this.gate.decide(event.toolName, input);
          if (verdict.block) {
            return { block: true, reason: verdict.reason, terminate: false };
          }
          return undefined;
        });
      },
    };
  }

  /** `<provider>/<modelId>` entries, matching what /prompt accepts. */
  listModels(): ModelInfo[] {
    const out: ModelInfo[] = [];
    for (const model of this.requireRuntime().getModels()) {
      const provider = typeof model.provider === 'string' ? model.provider : undefined;
      if (provider === undefined || typeof model.id !== 'string') continue;
      out.push({
        id: `${provider}/${model.id}`,
        name: `${provider} · ${typeof model.name === 'string' ? model.name : model.id}`,
      });
    }
    return out;
  }

  async validateModel(provider?: string, model?: string): Promise<void> {
    // Kein Modell angefragt, also nichts zu prüfen. Die App schickt für
    // "Standard des Agenten" ein leeres model bei gesetztem Provider — der
    // Provider benennt dort den Zugang, nicht einen Modellwechsel. prompt()
    // setzt unten ohnehin nur dann ein Modell, wenn beides da ist; dieser
    // Wächter war strenger als die Stelle, die er schützt, und ließ genau
    // die Kombination auflaufen, die im Normalbetrieb ankommt.
    if (model === undefined) return;
    // Umgekehrt gilt das nicht: ein Modell ohne Provider bliebe unten
    // wirkungslos liegen. Das ist ein Fehler, kein Standard.
    if (!provider) {
      throw new PromptError('provider and model must be set together');
    }
    if (!this.requireRuntime().getModel(provider, model)) {
      throw new PromptError(`unknown model ${provider}/${model}`);
    }
  }

  async prompt(text: string, options?: PromptOptions): Promise<PromptOutcome> {
    const session = this.requireSession();
    if (this.busy) throw new PromptError('prompt already running');
    this.busy = true;
    try {
      if (options?.mode) this.mode = options.mode;
      if (options?.provider && options?.model) {
        const model = this.requireRuntime().getModel(options.provider, options.model);
        if (!model) throw new PromptError(`unknown model ${options.provider}/${options.model}`);
        await session.setModel(model);
      }
      if (options?.reasoningEffort) {
        // pi thinking levels are a superset of the protocol's low|medium|high;
        // the SDK clamps to what the active model supports.
        if (session.supportsThinking()) session.setThinkingLevel(options.reasoningEffort);
      }
      await session.prompt(text);
    } finally {
      this.busy = false;
    }
    return this.outcome();
  }

  private outcome(): PromptOutcome {
    const session = this.requireSession();
    const stats = session.getSessionStats();
    const usage: TokenUsage = {
      input: stats.tokens.input,
      output: stats.tokens.output,
      costUsd: stats.cost,
    };
    const messages = session.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as unknown as { role?: string };
      if (message.role !== 'assistant') continue;
      const assistant = messages[i] as unknown as AssistantLike;
      if (assistant.stopReason === 'error') {
        return {
          aborted: false,
          errorMessage: assistant.errorMessage ?? 'assistant turn failed',
          usage,
        };
      }
      return {
        aborted: assistant.stopReason === 'aborted',
        summary: collectText(assistant.content) || undefined,
        usage,
      };
    }
    return { aborted: false, usage };
  }

  async abort(): Promise<void> {
    await this.requireSession().abort();
  }

  async resume(sessionRef: string): Promise<void> {
    if (this.busy) throw new PromptError('cannot resume while a prompt is running');
    await this.attach(SessionManager.open(sessionRef, this.options.sessionDir, this.options.workDir));
  }

  status(): RunnerStatus {
    const model = this.session?.model;
    return {
      sessionRef: this.session?.sessionFile,
      provider: typeof model?.provider === 'string' ? model.provider : undefined,
      model: typeof model?.id === 'string' ? model.id : undefined,
      mode: this.mode,
      busy: this.busy,
    };
  }

  resolvePermission(permissionId: string, decision: PermissionDecision): boolean {
    return this.gate.resolve(permissionId, decision);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
  }
}
