import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AgentEvent, AgentMode, PermissionDecision } from '@pocketagent/protocol';
import {
  PermissionGate,
  PromptError,
  normalizePiEvent,
  type PiRunner,
  type PromptOptions,
  type PromptOutcome,
  type RunnerStatus,
} from '../src/pi';

type AssistantMessageUpdate = Extract<AgentSessionEvent, { type: 'message_update' }>['assistantMessageEvent'];
type FakeMessage = Extract<AssistantMessageUpdate, { type: 'text_delta' }>['partial'];

function fakeAssistantMessage(text: string, stopReason: 'pending' | 'stop' | 'aborted'): FakeMessage {
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    api: 'openai-completions',
    provider: 'fake-provider',
    model: 'fake-model',
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0003 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

export interface FakeRunnerOptions {
  workDir: string;
  mode: AgentMode;
  permissionTimeoutMs: number;
  emit: (event: AgentEvent) => void;
}

/**
 * PiRunner implementation emitting canned pi-like session events through the
 * real normalizer; used by the smoke test (no SDK/API access needed).
 */
export class FakeRunner implements PiRunner {
  readonly kind = 'fake' as const;

  private mode: AgentMode;
  private readonly gate: PermissionGate;
  private sessionRef = 'fake-session.jsonl';
  private busy = false;
  private abortRequested: (() => void) | undefined;

  constructor(private readonly options: FakeRunnerOptions) {
    this.mode = options.mode;
    this.gate = new PermissionGate(options.emit, () => this.mode, options.permissionTimeoutMs);
  }

  private fire(event: AgentSessionEvent): void {
    for (const normalized of normalizePiEvent(event)) this.options.emit(normalized);
  }

  async init(): Promise<void> {}

  // Spiegelt PiRunner.validateModel. Diese Nachbildung trug lange dieselbe
  // Regel wie das Original — beide verlangten Provider und Modell gemeinsam.
  // Dadurch hätte der Smoke-Test den Fehler auch dann nicht gefunden, wenn er
  // den richtigen Fall geprüft hätte: er hätte die Nachbildung bestätigt.
  async validateModel(provider?: string, model?: string): Promise<void> {
    if (model === undefined) return;
    if (!provider) {
      throw new PromptError('provider and model must be set together');
    }
    if (provider !== 'fake-provider' || model !== 'fake-model') {
      throw new PromptError(`unknown model ${provider}/${model}`);
    }
  }

  async prompt(text: string, options?: PromptOptions): Promise<PromptOutcome> {
    if (this.busy) throw new PromptError('prompt already running');
    if (options?.mode) this.mode = options.mode;
    this.busy = true;

    if (text.includes('hang')) {
      try {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => resolve(), 10_000);
          this.abortRequested = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.fire({
          type: 'message_end',
          message: fakeAssistantMessage('Partial work before abort.', 'aborted'),
        });
        return { aborted: true, summary: 'Partial work before abort.' };
      } finally {
        this.abortRequested = undefined;
        this.busy = false;
      }
    }

    if (text.includes('fail')) {
      this.busy = false;
      throw new Error('fake provider stream error');
    }

    try {
      const message = fakeAssistantMessage('', 'pending');
      this.fire({
        type: 'message_update',
        message,
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'Working on it. ',
          partial: message,
        },
      });
      this.fire({
        type: 'message_update',
        message,
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'I will run a command.',
          partial: message,
        },
      });

      const toolCallId = randomUUID();
      const command = 'echo hello > hello.txt';
      this.fire({ type: 'tool_execution_start', toolCallId, toolName: 'bash', args: { command } });
      const verdict = await this.gate.decide('bash', { command });
      if (verdict.block) {
        this.fire({
          type: 'tool_execution_end',
          toolCallId,
          toolName: 'bash',
          result: { content: [{ type: 'text', text: verdict.reason ?? 'blocked' }], details: {} },
          isError: true,
        });
      } else {
        await writeFile(join(this.options.workDir, 'hello.txt'), 'hello\n', 'utf8');
        this.fire({
          type: 'tool_execution_end',
          toolCallId,
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'hello.txt written' }], details: {} },
          isError: false,
        });
      }

      const finalText = 'Done. Created hello.txt.';
      this.fire({ type: 'message_end', message: fakeAssistantMessage(finalText, 'stop') });
      return {
        aborted: false,
        summary: finalText,
        usage: { input: 10, output: 20, costUsd: 0.001 },
      };
    } finally {
      this.busy = false;
    }
  }

  async abort(): Promise<void> {
    this.abortRequested?.();
  }

  async resume(sessionRef: string): Promise<void> {
    if (this.busy) throw new PromptError('cannot resume while a prompt is running');
    this.sessionRef = sessionRef;
  }

  status(): RunnerStatus {
    return {
      sessionRef: this.sessionRef,
      provider: 'fake-provider',
      model: 'fake-model',
      mode: this.mode,
      busy: this.busy,
    };
  }

  resolvePermission(permissionId: string, decision: PermissionDecision): boolean {
    return this.gate.resolve(permissionId, decision);
  }

  dispose(): void {}
}
