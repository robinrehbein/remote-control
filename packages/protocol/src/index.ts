/**
 * PocketAgent shared protocol.
 *
 * Single source of truth for:
 *  - Shim REST API (orchestrator -> session container), see docs in /README.md
 *  - Normalized agent event stream (SSE from shim, forwarded over WS to the app)
 *  - App <-> Orchestrator WebSocket messages
 *  - Pairing REST types
 *
 * Pure TypeScript types, zero runtime dependencies.
 */

/* ------------------------------------------------------------------ */
/* Common enums                                                        */
/* ------------------------------------------------------------------ */

/**
 * Adapter ids are open-ended: built-in ids are 'opencode' | 'kilo' | 'claude'
 * | 'pi' | 'junie', but the server loads adapters from manifests at boot, so
 * any harness plugin can register additional ids.
 */
export type AdapterId = (string & {});

export interface AdapterCapabilities {
  /** Remote permission flow (permission.request events + /permissions/:id). */
  approvals: boolean;
  /** Runtime-native session resume across container restarts. */
  resume: boolean;
  /** Token-level message deltas vs turn-granularity only. */
  streaming: boolean;
  /** Shim performs auto-push + draft PR itself (yolo mode). */
  autoPush: boolean;
}

/**
 * Adapter plugin manifest. Each `shims/<id>/adapter.json` describes one
 * harness; the orchestrator registry loads them at boot and serves the list
 * to apps via `adapter.list`.
 */
export interface AdapterDescriptor {
  id: AdapterId;
  name: string;
  description?: string;
  /** Docker image; falls back to `<ADAPTER_IMAGE_PREFIX>/<id>-shim:latest` when omitted. */
  image?: string;
  /** In-container path of the standalone push script (tap-push); default `/app/shims/<id>/scripts/push.js`. */
  pushScript?: string;
  capabilities: AdapterCapabilities;
  /**
   * Fixed credential injection: secret kind -> env vars that are always set
   * when a secret of that kind exists (e.g. claude_oauth -> CLAUDE_CODE_OAUTH_TOKEN).
   */
  credentials?: Record<string, string[]>;
  /**
   * Provider-key mapping: provider name (== secret kind) -> env var, injected
   * based on the session's chosen provider (e.g. openai -> OPENAI_API_KEY).
   */
  providerEnv?: Record<string, string>;
  defaults: { provider: string; model?: string };
}

export type AgentMode = 'yolo' | 'auto' | 'acceptEdits' | 'ask';

/**
 * Per-session network isolation:
 *  - 'allowlist' (default): internal docker network, egress only via the
 *    orchestrator's HTTP(S) proxy restricted to an allowlist of hosts.
 *  - 'isolated': internal docker network, no proxy => no internet at all.
 *  - 'open': regular docker network with direct internet access.
 */
export type NetworkPolicy = 'allowlist' | 'isolated' | 'open';

export type SessionStatus =
  | 'creating'   // container being created / repo being cloned
  | 'running'    // agent actively processing a prompt
  | 'idle'       // container up, waiting for input
  | 'stopped'    // container stopped, volume retained (resumable)
  | 'error';

export type PermissionDecision = 'once' | 'always' | 'reject';

export type PermissionKind = 'bash' | 'edit' | 'webfetch' | 'external' | 'other';

/**
 * Secret kinds understood by the orchestrator vault.
 * `claude_oauth` = long-lived token from `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN).
 * Custom kinds are allowed (open string) so new providers need no protocol change.
 */
export type SecretKind =
  | 'openai'
  | 'zai'
  | 'moonshot'
  | 'anthropic'
  | 'github'
  | 'claude_oauth'
  | 'junie'
  | (string & {});

/* ------------------------------------------------------------------ */
/* Shim REST API (orchestrator -> shim, inside session container)      */
/* ------------------------------------------------------------------ */

/** POST /prompt */
export interface PromptRequest {
  text: string;
  /** May override the mode the container was started with. */
  mode?: AgentMode;
  provider?: string;
  model?: string;
}

/** POST /resume */
export interface ResumeRequest {
  sessionRef: string;
}

/** POST /permissions/:id */
export interface PermissionReplyBody {
  response: PermissionDecision;
}

/** GET /status */
export interface ShimStatus {
  adapter: AdapterId;
  /** Runtime-native session reference (opencode session id, claude session_id, pi session file). */
  sessionRef?: string;
  provider?: string;
  model?: string;
  mode: AgentMode;
  busy: boolean;
}

/** GET /diff */
export interface DiffEntry {
  path: string;
  patch: string;
  binary?: boolean;
}

/** Standard success envelope */
export interface OkResponse { ok: true }
export interface ErrorResponse { ok: false; error: string }

export type ShimApiResponse = OkResponse | ErrorResponse;

/**
 * Env vars the orchestrator injects into every session container.
 * The shim reads these at startup.
 */
export interface ShimEnv {
  /** Random per-session token; orchestrator sends it as `authorization: Bearer <token>`. */
  SHIM_TOKEN: string;
  WORK_DIR: string;              // e.g. /work (repo checkout)
  AGENT_MODE: AgentMode;
  ADAPTER: AdapterId;
  SESSION_ID: string;            // orchestrator session id (uuid)
  REPO_URL: string;              // https clone url (no token embedded)
  REPO_BRANCH?: string;          // base branch to start from (default: repo default branch)
  GITHUB_PAT?: string;           // injected when push is allowed
  REPO_FULL_NAME: string;        // owner/name for PR API calls
  AUTO_PUSH: '1' | '0';          // yolo => 1 (auto push + draft PR after each completed turn)
  /** Only provider credential relevant for this session, e.g. OPENAI_API_KEY / ZAI_API_KEY / CLAUDE_CODE_OAUTH_TOKEN. */
  [key: string]: string | undefined;
}

/* ------------------------------------------------------------------ */
/* Normalized event stream                                             */
/* ------------------------------------------------------------------ */

export interface TokenUsage {
  input?: number;
  output?: number;
  costUsd?: number;
}

export type AgentEvent =
  | {
      type: 'status';
      adapter: AdapterId;
      sessionRef?: string;
      provider?: string;
      model?: string;
      mode: AgentMode;
      busy: boolean;
    }
  | { type: 'message.delta'; role: 'assistant'; delta: string }
  | { type: 'message.completed'; role: 'assistant' | 'user'; text: string }
  | { type: 'tool.call'; id: string; tool: string; input: unknown; title?: string }
  | { type: 'tool.result'; id: string; tool: string; output: string; isError?: boolean }
  | {
      type: 'permission.request';
      permissionId: string;
      kind: PermissionKind;
      /** Short human title, e.g. "bash: npm install". */
      title: string;
      /** Longer detail (full command, file contents for edits...). */
      detail?: string;
      /** Unified diff for edit permissions. */
      diff?: string;
      /** Suggested patterns when decision === 'always'. */
      patterns?: string[];
    }
  | { type: 'permission.resolved'; permissionId: string; decision: PermissionDecision }
  | { type: 'turn.completed'; summary?: string; usage?: TokenUsage; commitSha?: string }
  | { type: 'turn.failed'; error: string }
  | { type: 'pushed'; branch: string; prUrl?: string; auto: boolean }
  | { type: 'error'; message: string; fatal?: boolean }
  | { type: 'ping'; ts: number };

/** SSE wire format: `event: agent` + `data: <AgentEvent JSON>` */
export interface AgentSseEvent {
  event: 'agent';
  data: AgentEvent;
}

/* ------------------------------------------------------------------ */
/* App <-> Orchestrator WebSocket                                      */
/* ------------------------------------------------------------------ */

export interface SessionInfo {
  id: string;
  repoId: string;
  repoFullName?: string;
  adapter: AdapterId;
  provider: string;
  model: string;
  mode: AgentMode;
  status: SessionStatus;
  /** Branch the session works on: agent/<session-id> */
  branch: string;
  createdAt: string;
  lastActiveAt: string;
  prUrl?: string;
  networkPolicy?: NetworkPolicy;
}

export interface RepoInfo {
  id: string;
  fullName: string;
  defaultBranch: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  enrolledAt: string;
  /** True while the device has a live authenticated WS connection. */
  online: boolean;
}

export interface LinkInfo {
  id: string;
  name: string;
  createdAt: string;
}

export interface SecretInfo {
  id: string;
  kind: SecretKind;
  createdAt: string;
  /** Never contains the plaintext value. */
}

export type ClientMessage =
  | { type: 'hello'; deviceId: string; token: string }
  | {
      /** Link-agent (devcontainer/VPS/bare metal) registration; outbound WS, no inbound ports needed. */
      type: 'agent.hello';
      token: string;
      name?: string;
      adapter: AdapterId;
      mode?: AgentMode;
      branch?: string;
      workDir?: string;
      sessionRef?: string;
    }
  | {
      type: 'session.create';
      requestId: string;
      repoId: string;
      adapter: AdapterId;
      provider: string;
      model: string;
      mode: AgentMode;
      branch?: string;
      networkPolicy?: NetworkPolicy;
    }
  | { type: 'session.prompt'; sessionId: string; text: string; mode?: AgentMode }
  | { type: 'session.permission'; sessionId: string; permissionId: string; decision: PermissionDecision }
  | { type: 'session.abort'; sessionId: string }
  | { type: 'session.stop'; sessionId: string }
  | { type: 'session.resume'; sessionId: string }
  /** Tap-triggered push + draft PR (non-yolo mode). */
  | { type: 'session.push'; sessionId: string }
  | { type: 'session.diff.get'; requestId: string; sessionId: string }
  | { type: 'session.list'; requestId: string }
  | { type: 'session.delete'; requestId: string; sessionId: string }
  | { type: 'adapter.list'; requestId: string }
  | { type: 'repo.list'; requestId: string }
  | { type: 'repo.add'; requestId: string; fullName: string; defaultBranch: string }
  | { type: 'secret.set'; requestId: string; kind: SecretKind; value: string }
  | { type: 'secret.list'; requestId: string }
  | { type: 'secret.delete'; requestId: string; id: string }
  | { type: 'device.list'; requestId: string }
  | { type: 'device.revoke'; requestId: string; deviceId: string }
  | { type: 'link.list'; requestId: string }
  | { type: 'link.revoke'; requestId: string; linkId: string }
  | { type: 'server.stats'; requestId: string };

export type ServerMessage =
  | { type: 'welcome'; ok: true; serverVersion: string }
  /** server -> link agent: registration accepted, session bound */
  | { type: 'agent.ready'; sessionId: string }
  /** server -> link agent: proxy a shim HTTP call over the outbound WS */
  | { type: 'agent.command'; sessionId: string; callId: string; path: string; method: 'GET' | 'POST'; body?: unknown }
  /** link agent -> server: response to an agent.command */
  | { type: 'agent.response'; callId: string; status: number; body?: unknown }
  /** link agent -> server: normalized shim event */
  | { type: 'agent.event'; sessionId: string; event: AgentEvent }
  /** link agent -> server / server -> link agent keepalive */
  | { type: 'agent.ping'; ts: number }
  | { type: 'agent.pong'; ts: number }
  /** server -> link agent: session stopped from the app; link agent should shut down */
  | { type: 'agent.bye'; sessionId: string }
  | { type: 'error'; requestId?: string; sessionId?: string; message: string }
  | { type: 'request.ok'; requestId: string; payload?: unknown }
  | { type: 'session.list'; requestId: string; sessions: SessionInfo[] }
  | { type: 'session.event'; sessionId: string; event: AgentEvent }
  | { type: 'session.diff'; requestId: string; sessionId: string; diff: DiffEntry[] }
  | { type: 'session.status'; sessionId: string; status: SessionStatus; session?: SessionInfo }
  | { type: 'session.deleted'; requestId: string; sessionId: string }
  | { type: 'adapter.list'; requestId: string; adapters: AdapterDescriptor[] }
  | { type: 'repo.list'; requestId: string; repos: RepoInfo[] }
  | { type: 'repo.added'; requestId: string; repo: RepoInfo }
  | { type: 'secret.list'; requestId: string; secrets: SecretInfo[] }
  | { type: 'secret.saved'; requestId: string; secret: SecretInfo }
  | { type: 'secret.deleted'; requestId: string; id: string }
  | { type: 'device.list'; requestId: string; devices: DeviceInfo[] }
  | { type: 'device.revoked'; requestId: string; deviceId: string }
  | { type: 'link.list'; requestId: string; links: LinkInfo[] }
  | { type: 'link.revoked'; requestId: string; linkId: string }
  | { type: 'server.stats'; requestId: string; stats: ServerStats };

export interface ServerStats {
  sessionsActive: number;
  sessionsTotal: number;
  containersRunning: number;
  uptimeSec: number;
  versions: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* Pairing (REST before WS)                                            */
/* ------------------------------------------------------------------ */

/**
 * POST /api/pairing/confirm
 * The app scans a QR code containing `<serverUrl>` + one-time 12-hex-char code
 * (code is generated by the operator via `npm run pair` on the server, TTL 10 min,
 * invalidated after 5 failed confirm attempts).
 */
export interface PairingConfirmBody {
  code: string;
  deviceName: string;
}

export interface PairingConfirmResponse {
  ok: true;
  deviceId: string;
  /** Long-lived device token; stored in Android Keystore-backed storage. */
  deviceToken: string;
}

/* ------------------------------------------------------------------ */
/* FCM push payload                                                    */
/* ------------------------------------------------------------------ */

export interface FcmPushPayload {
  sessionId: string;
  eventType: 'permission.request' | 'turn.completed' | 'turn.failed' | 'session.status';
  title: string;
  body: string;
}
