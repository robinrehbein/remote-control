import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentEvent, AgentMode, TokenUsage } from '@pocketagent/protocol';

/**
 * Junie adapter runner.
 *
 * Junie is a one-shot CLI (no streaming/permission API): every prompt spawns
 * `junie --output-format json --json-output-file <tmp> "<text>"` in WORK_DIR.
 * stdout lines are forwarded as message.delta (best effort), the final
 * assistant message + usage are recovered from the JSON output file after
 * the process exits (structure unknown -> parsed defensively, see assumptions
 * in TEXT_KEYS / INPUT_KEYS / OUTPUT_KEYS / COST_KEYS below).
 */

/** Providers accepted by `junie --provider` with BYOK key flags. */
const BYOK_PROVIDERS: Readonly<Record<string, { flag: string; env: string }>> = {
  openai: { flag: '--openai-api-key', env: 'OPENAI_API_KEY' },
  anthropic: { flag: '--anthropic-api-key', env: 'ANTHROPIC_API_KEY' },
  google: { flag: '--google-api-key', env: 'GOOGLE_API_KEY' },
  xai: { flag: '--grok-api-key', env: 'GROK_API_KEY' },
  openrouter: { flag: '--openrouter-api-key', env: 'OPENROUTER_API_KEY' },
};

// Assumptions about junie's --json-output-file structure (defensive deep search):
// - final text: first match wins by key priority, then longest value
// - usage: any object pairing an input-ish and output-ish token count
// - cost: any numeric cost-ish key
const TEXT_KEYS: readonly string[] = [
  'result', 'response', 'answer', 'finalMessage', 'final_message',
  'message', 'content', 'text', 'summary', 'output',
];
const INPUT_KEYS: readonly string[] = ['input', 'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'];
const OUTPUT_KEYS: readonly string[] = ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens'];
const COST_KEYS: readonly string[] = ['cost_usd', 'costUsd', 'total_cost_usd', 'totalCostUsd', 'cost'];

export interface JunieRunnerStatus {
  sessionRef?: string;
  provider?: string;
  model?: string;
  mode: AgentMode;
  busy: boolean;
}

export interface JuniePromptOptions {
  mode?: AgentMode;
  provider?: string;
  model?: string;
}

export interface JuniePromptResult {
  ok: boolean;
  finalText?: string;
  usage?: TokenUsage;
  error?: string;
}

export type EmitFn = (event: AgentEvent) => void;

export interface JunieRunner {
  status(): JunieRunnerStatus;
  prompt(text: string, options?: JuniePromptOptions): Promise<JuniePromptResult>;
  abort(): Promise<void>;
  /** Degradation: junie one-shot has no session resume; stores the ref for /status only. */
  resume(sessionRef: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Defensive output parsing                                            */
/* ------------------------------------------------------------------ */

interface TextCandidate {
  priority: number;
  value: string;
}

function priorityOf(key: string): number {
  const index = TEXT_KEYS.indexOf(key);
  return index === -1 ? TEXT_KEYS.length : index;
}

function firstString(node: unknown): string | undefined {
  if (typeof node === 'string') return node.trim() ? node : undefined;
  if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) return value;
    }
  }
  return undefined;
}

function collectText(node: unknown, key: string, out: TextCandidate[]): void {
  if (typeof node === 'string') {
    if (node.trim().length > 0) out.push({ priority: priorityOf(key), value: node });
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, key, out);
    if (key === 'content') {
      const parts = node
        .map(item => firstString(item))
        .filter((part): part is string => part !== undefined && part.trim().length > 0);
      if (parts.length > 0) out.push({ priority: priorityOf(key), value: parts.join('\n') });
    }
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [childKey, value] of Object.entries(node as Record<string, unknown>)) {
      collectText(value, childKey, out);
    }
  }
}

function bestCandidate(candidates: readonly TextCandidate[]): string | undefined {
  let best: TextCandidate | undefined;
  for (const candidate of candidates) {
    if (
      best === undefined ||
      candidate.priority < best.priority ||
      (candidate.priority === best.priority && candidate.value.length > best.value.length)
    ) {
      best = candidate;
    }
  }
  return best?.value;
}

function numericKey(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function extractUsage(root: unknown): TokenUsage | undefined {
  let usage: TokenUsage | undefined;
  let cost: number | undefined;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (usage === undefined) {
      const input = numericKey(record, INPUT_KEYS);
      const output = numericKey(record, OUTPUT_KEYS);
      if (input !== undefined && output !== undefined) usage = { input, output };
    }
    if (cost === undefined) cost = numericKey(record, COST_KEYS);
    for (const value of Object.values(record)) visit(value);
  };
  visit(root);
  const merged: TokenUsage = {};
  if (usage !== undefined) {
    merged.input = usage.input;
    merged.output = usage.output;
  }
  if (cost !== undefined) merged.costUsd = cost;
  return merged.input !== undefined || merged.output !== undefined || merged.costUsd !== undefined
    ? merged
    : undefined;
}

export interface JunieOutput {
  text?: string;
  usage?: TokenUsage;
}

export function parseJunieOutput(data: unknown): JunieOutput {
  const candidates: TextCandidate[] = [];
  collectText(data, '', candidates);
  return { text: bestCandidate(candidates), usage: extractUsage(data) };
}

/** Read + parse the junie JSON output file; non-JSON fallback returns raw text. */
export async function readJunieOutput(path: string): Promise<JunieOutput> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  try {
    return parseJunieOutput(JSON.parse(raw) as unknown);
  } catch {
    const text = raw.trim();
    return text.length > 0 ? { text } : {};
  }
}

function redactAll(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('***');
  return out;
}

/* ------------------------------------------------------------------ */
/* Real runner (spawns the junie CLI)                                  */
/* ------------------------------------------------------------------ */

export interface RealRunnerOptions {
  workDir: string;
  mode: AgentMode;
  provider?: string;
  model?: string;
  env: NodeJS.ProcessEnv;
  emit: EmitFn;
  killGraceMs?: number;
}

export class RealJunieRunner implements JunieRunner {
  private readonly opts: RealRunnerOptions;
  private readonly state: JunieRunnerStatus;
  private currentChild: ChildProcess | undefined;
  private aborted = false;

  constructor(options: RealRunnerOptions) {
    this.opts = options;
    this.state = { mode: options.mode, provider: options.provider, model: options.model, busy: false };
  }

  status(): JunieRunnerStatus {
    return { ...this.state };
  }

  async resume(sessionRef: string): Promise<void> {
    this.state.sessionRef = sessionRef;
  }

  async prompt(text: string, options: JuniePromptOptions = {}): Promise<JuniePromptResult> {
    if (this.state.busy) throw new Error('junie already running');
    this.state.busy = true;
    this.aborted = false;
    if (options.mode !== undefined) this.state.mode = options.mode;
    if (options.provider !== undefined) this.state.provider = options.provider;
    if (options.model !== undefined) this.state.model = options.model;
    const outDir = await mkdtemp(join(tmpdir(), 'junie-shim-'));
    const outFile = join(outDir, 'result.json');
    try {
      return await this.runOnce(text, outFile);
    } finally {
      this.state.busy = false;
      this.currentChild = undefined;
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async runOnce(text: string, outFile: string): Promise<JuniePromptResult> {
    const provider = this.state.provider;
    const model = this.state.model;
    const env: NodeJS.ProcessEnv = { ...this.opts.env };
    if (provider !== undefined) env.JUNIE_LLM_PROVIDER = provider;
    if (model !== undefined) env.JUNIE_MODEL = model;
    const args: string[] = ['--output-format', 'json', '--json-output-file', outFile];
    if (this.opts.env.JUNIE_API_KEY !== undefined && this.opts.env.JUNIE_API_KEY !== '') {
      args.push('--auth', this.opts.env.JUNIE_API_KEY);
    }
    const byok = provider !== undefined ? BYOK_PROVIDERS[provider] : undefined;
    const byokKey = byok !== undefined ? this.opts.env[byok.env] : undefined;
    if (byok !== undefined && byokKey !== undefined && byokKey !== '') args.push(byok.flag, byokKey);
    if (model !== undefined) args.push('--model', model);
    if (provider !== undefined) args.push('--provider', provider);
    args.push(text);

    const secrets = [this.opts.env.JUNIE_API_KEY, byokKey].filter(
      (secret): secret is string => typeof secret === 'string' && secret.length > 0,
    );

    return await new Promise<JuniePromptResult>(resolve => {
      const child = spawn('junie', args, {
        cwd: this.opts.workDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.currentChild = child;

      let stdoutBuffer = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        let newline = stdoutBuffer.indexOf('\n');
        while (newline !== -1) {
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          this.emitLine(line);
          newline = stdoutBuffer.indexOf('\n');
        }
      });

      let stderrTail = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-2000);
      });

      child.on('error', error => {
        resolve({ ok: false, error: redactAll(`failed to start junie: ${error.message}`, secrets) });
      });

      child.on('close', async (code, signal) => {
        if (this.aborted) {
          resolve({ ok: false, error: 'aborted' });
          return;
        }
        if (code !== 0) {
          const reason = signal !== null && signal !== undefined ? `killed by ${signal}` : `exit code ${code ?? 'unknown'}`;
          const detail = stderrTail.trim().slice(-500) || 'no stderr output';
          resolve({ ok: false, error: redactAll(`junie failed (${reason}): ${detail}`, secrets) });
          return;
        }
        const parsed = await readJunieOutput(outFile);
        resolve({ ok: true, finalText: parsed.text, usage: parsed.usage });
      });
    });
  }

  private emitLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let delta = trimmed;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        delta = parseJunieOutput(JSON.parse(trimmed) as unknown).text ?? trimmed;
      } catch {
        /* not JSON, keep the raw line */
      }
    }
    this.opts.emit({ type: 'message.delta', role: 'assistant', delta });
  }

  async abort(): Promise<void> {
    const child = this.currentChild;
    if (child === undefined) return;
    this.aborted = true;
    const exited = new Promise<void>(resolve => {
      child.once('close', () => resolve());
    });
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, this.opts.killGraceMs ?? 5_000);
    await exited;
    clearTimeout(timer);
    await delay(0);
  }
}

/* ------------------------------------------------------------------ */
/* Fake runner (smoke test)                                            */
/* ------------------------------------------------------------------ */

export interface FakeRunnerOptions {
  workDir: string;
  mode: AgentMode;
  emit: EmitFn;
  /** Prompts containing this marker hang until abort(). */
  hangMarker?: string;
}

export class FakeJunieRunner implements JunieRunner {
  private readonly opts: FakeRunnerOptions;
  private readonly state: JunieRunnerStatus;
  private hangReject: ((error: Error) => void) | undefined;

  constructor(options: FakeRunnerOptions) {
    this.opts = options;
    this.state = { mode: options.mode, busy: false };
  }

  status(): JunieRunnerStatus {
    return { ...this.state };
  }

  async resume(sessionRef: string): Promise<void> {
    this.state.sessionRef = sessionRef;
  }

  async prompt(text: string, options: JuniePromptOptions = {}): Promise<JuniePromptResult> {
    if (this.state.busy) throw new Error('junie already running');
    this.state.busy = true;
    if (options.mode !== undefined) this.state.mode = options.mode;
    if (options.provider !== undefined) this.state.provider = options.provider;
    if (options.model !== undefined) this.state.model = options.model;
    try {
      if (this.opts.hangMarker !== undefined && text.includes(this.opts.hangMarker)) {
        this.line('FakeJunie: hanging until aborted...');
        await new Promise<never>((_resolve, reject) => {
          this.hangReject = reject;
        });
        return { ok: false };
      }
      await delay(10);
      this.line('FakeJunie: starting work');
      this.line('{"type":"progress","message":"writing hello.txt"}');
      await writeFile(join(this.opts.workDir, 'hello.txt'), 'hello fake junie\n');
      this.line('{"type":"progress","message":"done"}');
      const outDir = await mkdtemp(join(tmpdir(), 'junie-fake-'));
      const outFile = join(outDir, 'result.json');
      await writeFile(
        outFile,
        JSON.stringify({
          event: 'run.finished',
          result: 'Done. hello.txt erstellt.',
          messages: [{ role: 'assistant', content: 'Done. hello.txt erstellt.' }],
          usage: { input_tokens: 120, output_tokens: 64, cost_usd: 0.002 },
        }),
      );
      const parsed = await readJunieOutput(outFile);
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
      return { ok: true, finalText: parsed.text, usage: parsed.usage };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.state.busy = false;
      this.hangReject = undefined;
    }
  }

  private line(text: string): void {
    this.opts.emit({ type: 'message.delta', role: 'assistant', delta: text });
  }

  async abort(): Promise<void> {
    this.hangReject?.(new Error('aborted'));
  }
}
