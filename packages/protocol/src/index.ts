/**
 * PocketAgent shared protocol.
 *
 * Single source of truth for:
 *  - Shim REST API (orchestrator -> session container), see docs in /README.md
 *  - Normalized agent event stream (SSE from shim, forwarded over WS to the app)
 *  - App <-> Orchestrator WebSocket messages
 *  - Pairing REST types
 *
 * Pure TypeScript types, zero runtime dependencies, and at the end of this file
 * the one deliberate exception: pure helpers shared verbatim by the opencode
 * and kilo shims.
 *
 * This package MUST stay a single file. Shim containers run compiled JS on
 * plain node and load this package as TypeScript source via node's type
 * stripping, which - unlike tsx and tsc - does not resolve a './x.js' import
 * onto './x.ts'. A second file would therefore load everywhere in development
 * and crash every session container at startup.
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
  /**
   * Shim maps `PromptRequest.reasoningEffort` onto a runtime option.
   * Optional for backwards compatibility; treated as false when absent.
   */
  reasoning?: boolean;
  /**
   * Shim honours `PromptRequest.model` per prompt (live model switching).
   * Optional for backwards compatibility; treated as false when absent.
   */
  modelSwitch?: boolean;
}

/**
 * Human-facing metadata for one credential an adapter can use. Purely
 * cosmetic: the app renders display names, "create key" links and setup
 * hints from it instead of hard-coding a provider table.
 */
export interface ProviderDescriptor {
  /** Secret kind == provider key, i.e. a key of `providerEnv` or `credentials`. */
  id: string;
  /** Display name, e.g. "Google Gemini". */
  name: string;
  /** Page where the user creates/copies the key. */
  keyUrl?: string;
  /** One-line setup hint shown in the secret dialog. */
  hint?: string;
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
  /**
   * Optional display metadata for the credentials above (ids are the same
   * secret kinds). Absent on older manifests — the app falls back to its own
   * table then.
   */
  providers?: ProviderDescriptor[];
  defaults: { provider: string; model?: string };
}

export type AgentMode = 'yolo' | 'auto' | 'acceptEdits' | 'ask';

/**
 * Normalized reasoning/thinking budget. Adapters that expose an effort knob map
 * these three levels onto their runtime option; all others ignore the field
 * (and report `capabilities.reasoning === false`).
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

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
  /**
   * May override the model for this and following turns. Adapters whose runtime
   * addresses models as provider + model accept the `"<provider>/<model>"` form
   * (the same ids their GET /models returns); an empty string means
   * "adapter default".
   */
  model?: string;
  /** Ignored by adapters without `capabilities.reasoning`. */
  reasoningEffort?: ReasoningEffort;
}

/** One entry of the shim's model catalog (GET /models). */
export interface ModelInfo {
  /** Id accepted by `PromptRequest.model` for this adapter. */
  id: string;
  /** Human-readable label; falls back to `id` in the UI. */
  name?: string;
}

/** GET /models — an empty list is valid (adapter has no catalog). */
export interface ModelsResponse {
  models: ModelInfo[];
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
  /**
   * Start value only (yolo => 1): auto push + draft PR after each completed
   * turn. Since mode is switchable mid-session, shims derive the decision per
   * turn from `PromptRequest.mode` and fall back to this env when it is absent.
   */
  AUTO_PUSH: '1' | '0';
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

/**
 * Step a session start is currently in, carried by progress notices:
 *  - 'image-build'     : the adapter image is being built on the daemon
 *  - 'container-start' : the session container is being started
 *  - 'shim-start'      : the container boots (repo clone, agent process)
 *  - 'ready'           : the shim answers, the session can take prompts
 * The order is the order of a start, but clients must not assume every phase
 * occurs (a cached image skips 'image-build').
 */
export type NoticePhase = 'image-build' | 'container-start' | 'shim-start' | 'ready';

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
  /**
   * Informational, non-fatal line for the session log (e.g. "the agent image is
   * being built"). Purely additive: clients that predate this variant ignore
   * unknown event types.
   *
   * With `phase` it is live progress of a starting session: the client replaces
   * its status display with it (same phase = update of the same line, new phase
   * = next step). Without `phase` it stays an ordinary timeline entry
   * (e.g. "Agent gewechselt: kilo → claude").
   */
  | { type: 'notice'; message: string; phase?: NoticePhase; detail?: string }
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
  /** Persisted reasoning budget; absent when the session never set one. */
  reasoningEffort?: string;
  /** User-set name (`session.rename`); absent => the client derives one as before. */
  title?: string;
  /** Absent => false. Archived sessions stay in `session.list`; the client filters. */
  archived?: boolean;
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
  /**
   * With `requestId` the server acknowledges acceptance via `request.ok`
   * (or `error` on failure) carrying the same id; without it the call stays
   * fire-and-forget as before, for older clients.
   */
  | { type: 'session.prompt'; sessionId: string; text: string; mode?: AgentMode; requestId?: string }
  /**
   * Change mode / model / reasoning effort / harness of a live session. Every
   * field is optional; the server persists what is set and answers with
   * `session.status` (carrying the updated session) to all devices.
   */
  | {
      type: 'session.update';
      requestId: string;
      sessionId: string;
      mode?: AgentMode;
      /** Empty string resets the session to the adapter default. */
      model?: string;
      reasoningEffort?: ReasoningEffort;
      /**
       * Switch the session to another harness. The volume (repo checkout +
       * branch) is kept, everything harness-bound is dropped: the runtime
       * session reference, the model and the reasoning effort reset, provider
       * falls back to the new adapter's default. The container is recreated
       * asynchronously - `request.ok` only acknowledges the switch.
       */
      adapter?: AdapterId;
    }
  /** Ask the session's shim for its model catalog (proxied GET /models). */
  | { type: 'session.models.get'; requestId: string; sessionId: string }
  | { type: 'session.permission'; sessionId: string; permissionId: string; decision: PermissionDecision }
  | { type: 'session.abort'; sessionId: string }
  | { type: 'session.stop'; sessionId: string }
  | { type: 'session.resume'; sessionId: string }
  /** Tap-triggered push + draft PR (non-yolo mode). */
  | { type: 'session.push'; sessionId: string }
  | { type: 'session.diff.get'; requestId: string; sessionId: string }
  | { type: 'session.list'; requestId: string }
  /**
   * Stored timeline of a session, so a client that dropped its in-memory
   * messages (screen left, app restarted) can show the conversation again.
   * `limit` counts the most recent events (default 200, max 1000); the answer
   * carries them in chronological order, oldest first.
   */
  | { type: 'session.events.get'; requestId: string; sessionId: string; limit?: number }
  /** Rename a session; an empty title removes it (client derives a name again). */
  | { type: 'session.rename'; requestId: string; sessionId: string; title: string }
  | { type: 'session.archive'; requestId: string; sessionId: string; archived: boolean }
  | { type: 'session.delete'; requestId: string; sessionId: string }
  | { type: 'adapter.list'; requestId: string }
  | { type: 'repo.list'; requestId: string }
  | { type: 'repo.add'; requestId: string; fullName: string; defaultBranch: string }
  | { type: 'secret.set'; requestId: string; kind: SecretKind; value: string }
  /**
   * Live-check a key against its provider before/without storing it. The value
   * is used for the outbound provider request only — it is never persisted,
   * logged or echoed back.
   */
  | { type: 'secret.validate'; requestId: string; kind: SecretKind; value: string }
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
  /** Answer to `session.events.get`: chronological, oldest first. */
  | { type: 'session.events'; requestId: string; sessionId: string; events: AgentEvent[] }
  | { type: 'session.diff'; requestId: string; sessionId: string; diff: DiffEntry[] }
  | { type: 'session.status'; sessionId: string; status: SessionStatus; session?: SessionInfo }
  | { type: 'session.models'; requestId: string; sessionId: string; models: ModelInfo[] }
  | { type: 'session.deleted'; requestId: string; sessionId: string }
  | { type: 'adapter.list'; requestId: string; adapters: AdapterDescriptor[] }
  | { type: 'repo.list'; requestId: string; repos: RepoInfo[] }
  | { type: 'repo.added'; requestId: string; repo: RepoInfo }
  | { type: 'secret.list'; requestId: string; secrets: SecretInfo[] }
  | { type: 'secret.saved'; requestId: string; secret: SecretInfo }
  /**
   * Result of a `secret.validate`. Never carries the value.
   * `unverified: true` means no live check exists for this kind — `ok` is
   * true so the app keeps the flow going, but the UI must present it
   * neutrally rather than as a confirmed key.
   */
  | {
      type: 'secret.validated';
      requestId: string;
      kind: SecretKind;
      ok: boolean;
      detail?: string;
      unverified?: boolean;
    }
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

/* ------------------------------------------------------------------ */
/* Shared opencode-wire helpers (opencode + kilo shims)                */
/*                                                                     */
/* kilo is an OpenCode fork, so both shims speak the same              */
/* `/config/providers` catalog format and the same `provider/model` id */
/* form. The logic is pure, synchronous and dependency-free, so it     */
/* stays as portable as the type declarations above.                   */
/* ------------------------------------------------------------------ */
/**
 * Flatten opencode's `GET /config/providers` catalog into `provider/model` ids
 * (the form POST /session/:id/prompt accepts as {providerID, modelID}).
 * Shape: { providers: [{ id, name, models: { <modelID>: { id?, name? } } }] };
 * anything unexpected yields an empty catalog instead of an error.
 */
export function parseProviderCatalog(raw: unknown): ModelInfo[] {
  const providers = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { providers?: unknown }).providers)
      ? ((raw as { providers: unknown[] }).providers)
      : [];
  const out: ModelInfo[] = [];
  for (const entry of providers) {
    if (typeof entry !== 'object' || entry === null) continue;
    const p = entry as { id?: unknown; name?: unknown; models?: unknown };
    const providerId = typeof p.id === 'string' ? p.id : undefined;
    if (providerId === undefined) continue;
    const providerName = typeof p.name === 'string' ? p.name : providerId;
    const models = p.models;
    const list: Array<[string, { name?: unknown } | null]> = Array.isArray(models)
      ? models.map((m) => {
          const rec = typeof m === 'object' && m !== null ? (m as { id?: unknown; name?: unknown }) : null;
          return [typeof rec?.id === 'string' ? rec.id : '', rec] as [string, { name?: unknown } | null];
        })
      : typeof models === 'object' && models !== null
        ? Object.entries(models as Record<string, unknown>).map(([key, value]) => {
            const rec = typeof value === 'object' && value !== null ? (value as { id?: unknown; name?: unknown }) : null;
            const id = typeof rec?.id === 'string' ? rec.id : key;
            return [id, rec] as [string, { name?: unknown } | null];
          })
        : [];
    for (const [modelId, rec] of list) {
      if (modelId.length === 0) continue;
      const modelName = typeof rec?.name === 'string' ? rec.name : modelId;
      out.push({ id: `${providerId}/${modelId}`, name: `${providerName} · ${modelName}` });
    }
  }
  return out;
}

/**
 * Model selection for one prompt. opencode addresses models as
 * {providerID, modelID}, so `model` may carry the `provider/model` form the
 * shim's GET /models returns; an empty string falls back to the runtime's own
 * default (the documented "adapter default" reset).
 */
export function selectModel(
  current: { provider?: string; model?: string },
  body: { provider?: unknown; model?: unknown },
): { provider?: string; model?: string } {
  const next = { ...current };
  if (typeof body.provider === 'string' && body.provider.length > 0) next.provider = body.provider;
  if (typeof body.model !== 'string') return next;
  const raw = body.model.trim();
  if (raw.length === 0) {
    // explicit reset: let the runtime pick its configured default again
    next.model = undefined;
    return next;
  }
  const slash = raw.indexOf('/');
  if (slash > 0) {
    next.provider = raw.slice(0, slash);
    next.model = raw.slice(slash + 1);
  } else {
    next.model = raw;
  }
  return next;
}
