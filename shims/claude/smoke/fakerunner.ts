/**
 * Fake ClaudeRunner for smoke tests: emits canned SDK-normalized events
 * (assistant partials, tool_use, permission gate, tool_result, result)
 * without touching the real Agent SDK or any credentials.
 */
import type { ClaudeRunner, RunnerCallbacks, RunnerFactory } from '../src/claude.ts';

export const fakeRunnerFactory: RunnerFactory = (config, cb: RunnerCallbacks): ClaudeRunner => {
  let turn = 0;
  return {
    isAlive: () => true,
    async start(): Promise<void> {},
    sendPrompt(text: string): void {
      turn += 1;
      void (async () => {
        cb.onRunnerMessage({ kind: 'delta', text: 'Hel' });
        cb.onRunnerMessage({ kind: 'delta', text: 'lo' });
        cb.onRunnerMessage({ kind: 'assistant_text', text: `Hello ${text}` });
        cb.onRunnerMessage({
          kind: 'tool_call',
          id: 'toolu_1',
          tool: 'Bash',
          input: { command: 'npm test' },
        });
        const decision = await cb.requestPermission('Bash', { command: 'npm test' });
        cb.onRunnerMessage({
          kind: 'tool_result',
          id: 'toolu_1',
          output: `exit 0 (${decision.behavior})`,
          isError: false,
        });
        cb.onRunnerMessage({
          kind: 'result',
          success: true,
          subtype: 'success',
          summary: 'fake turn done',
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.01,
          sessionId: `fake-session-${turn}`,
          errors: [],
        });
      })();
    },
    async setModel(): Promise<void> {},
    async setPermissionMode(): Promise<void> {},
    async abort(): Promise<void> {},
    close(): void {},
  };
};
