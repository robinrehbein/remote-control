import type { AgentMode } from '@pocketagent/protocol';

const MODES: readonly AgentMode[] = ['yolo', 'auto', 'acceptEdits', 'ask'];

export interface ShimEnvConfig {
  shimToken: string;
  workDir: string;
  agentMode: AgentMode;
  sessionId: string;
  repoUrl: string;
  repoBranch: string | undefined;
  githubPat: string | undefined;
  repoFullName: string;
  autoPush: boolean;
  opencodePort: number;
  opencodeBase: string;
  opencodeSpawn: boolean;
  opencodePermission: string | undefined;
  port: number;
}

function num(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function readEnv(env: Record<string, string | undefined> = process.env): ShimEnvConfig {
  const port = num(env.OPENCODE_PORT, 4096);
  const mode = env.AGENT_MODE;
  return {
    shimToken: env.SHIM_TOKEN ?? '',
    workDir: env.WORK_DIR ?? '/work',
    agentMode: MODES.includes(mode as AgentMode) ? (mode as AgentMode) : 'ask',
    sessionId: env.SESSION_ID ?? 'unknown-session',
    repoUrl: env.REPO_URL ?? '',
    repoBranch: env.REPO_BRANCH,
    githubPat: env.GITHUB_PAT,
    repoFullName: env.REPO_FULL_NAME ?? '',
    autoPush: env.AUTO_PUSH === '1',
    opencodePort: port,
    opencodeBase: env.OPENCODE_BASE_URL ?? `http://127.0.0.1:${port}`,
    opencodeSpawn: env.OPENCODE_SPAWN !== '0',
    opencodePermission: env.OPENCODE_PERMISSION,
    port: num(env.PORT, 8080),
  };
}
