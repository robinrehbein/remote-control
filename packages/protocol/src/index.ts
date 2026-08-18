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
 * the one deliberate exception: pure helpers used verbatim by the kilo shim
 * (kilo is an OpenCode fork and speaks the same wire format).
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
 * Adapter ids are open-ended: built-in ids are 'kilo' | 'claude' | 'pi' |
 * 'junie', but the server loads adapters from manifests at boot, so any
 * harness plugin can register additional ids.
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
  /**
   * How a user signs this adapter in, declared by the manifest so the app can
   * render the right login affordance generically instead of hard-coding a
   * per-adapter table (CODEX-OAUTH.md §5). Absent on older manifests — the app
   * then offers only the plain secret-paste flow it always had.
   */
  authFlows?: AuthFlow[];
  defaults: { provider: string; model?: string };
}

/**
 * One sign-in method an adapter supports (AdapterDescriptor.authFlows):
 *  - `oauth-loopback`: browser login whose provider redirects to a localhost
 *    callback (codex: 127.0.0.1:1455, fallback 1457). `ports` lists the ports
 *    the provider's redirect allowlist permits; the app opens the auth URL and
 *    runs a matching loopback listener (see the `auth.*` messages below).
 *  - `device-code`: the provider shows a verification URL + a short user code
 *    the user enters on any device; no loopback listener needed.
 *  - `token-paste`: the user pastes a long-lived token from a CLI (`hint`
 *    names it, e.g. "claude setup-token").
 *  - `api-key`: a plain provider API key (`keyUrl` links the create-key page).
 * The type stays open so a new flow needs no protocol change; an app that does
 * not know a type simply skips it.
 */
export type AuthFlowType = 'oauth-loopback' | 'device-code' | 'token-paste' | 'api-key' | (string & {});

export interface AuthFlow {
  type: AuthFlowType;
  /** oauth-loopback: the localhost ports the provider's redirect allowlist permits. */
  ports?: number[];
  /** token-paste: names the CLI command that mints the token. */
  hint?: string;
  /** api-key: page where the user creates/copies the key. */
  keyUrl?: string;
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

/**
 * Per-turn lifecycle (KILO-CLOUD-ANALYSE.md P1, "Message-Status als eigene
 * Ressource"). Distinct from `SessionStatus`: a session is a long-lived
 * container, a turn is one prompt-to-answer round inside it. The states are a
 * linear machine — `queued` (admitted, persisted, not yet handed to the
 * shim/agent) → `running` (the agent is working) → one terminal state:
 *  - `completed`   : the agent finished the turn (`turn.completed`).
 *  - `failed`      : the turn ended in an error, see `TurnFailureReason`.
 *  - `interrupted` : cut short from outside (user abort, or a server restart
 *                    that dropped the in-flight turn).
 * After a reconnect the app reads the turns of a session instead of guessing a
 * turn's fate from the event stream.
 */
export type TurnState = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';

/**
 * Structured reason a turn reached `failed`, modelled on Kilo's failure object.
 * `stage` names where it broke (e.g. 'transport', 'shim', 'provision'), `code`
 * is an optional machine-readable tag, `retryable` tells the app whether a
 * fresh attempt could succeed. Only `message` is guaranteed.
 */
export interface TurnFailureReason {
  message: string;
  stage?: string;
  code?: string;
  retryable?: boolean;
}

/**
 * One turn as the orchestrator persists and reports it. `turnId` is the
 * orchestrator's own id; `messageId` is the app-generated id that admitted it
 * (absent for a prompt from an older client that sent none).
 */
export interface TurnInfo {
  turnId: string;
  sessionId: string;
  messageId?: string;
  state: TurnState;
  createdAt: string;
  updatedAt: string;
  /** Present only in the `failed` state. */
  reason?: TurnFailureReason;
}

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
  /**
   * ChatGPT OAuth backup for codex (CODEX-OAUTH.md §4). The canonical copy of
   * codex `auth.json` lives in the shared CODEX_HOME volume; this vault entry
   * is an encrypted backup so a volume loss does not force a re-login. The
   * refresh token rotates and is single-use, so a *stale* backup may already be
   * dead — validate on restore and re-login if needed.
   */
  | 'codex_oauth'
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
  /**
   * App-generated, per-turn message id (`msg_<random>`), echoed end to end
   * (KILO-CLOUD-ANALYSE.md P1). Optional for backwards compatibility: a prompt
   * without one behaves exactly as before. The orchestrator uses it to make a
   * re-sent prompt idempotent (no duplicate agent turn after a radio-hole
   * reconnect); shims may echo it but are not required to.
   */
  messageId?: string;
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
  /** Runtime-native session reference (kilo session id, claude session_id, pi session file). */
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

/**
 * Sequence metadata every normalized event carries once a shim's sequenced
 * broadcaster has stamped it (see SequencedSseBroadcaster):
 *  - `seq`: a per-session, per-stream monotone sequence number, mirrored in the
 *    SSE `id:` field. It is the basis for Last-Event-ID replay (the orchestrator
 *    reconnects with the last seq it saw, the shim replays from there) and for
 *    client-side dedup between the live stream and the stored history. Named
 *    `seq`, not `id`, because `tool.call`/`tool.result` already carry a string
 *    `id` (the tool-call id) that this must not collide with.
 *  - `ts`: emit time in epoch milliseconds.
 *
 * Both are optional for backward compatibility: events from an older shim (or
 * decoded by an older client) simply lack them, so every decoder must treat
 * them as "may be absent". The seq resets to 0 whenever a shim process restarts
 * (a new container / adapter switch / resume), so it is unique only within one
 * shim stream, not across the whole life of a session.
 */
export interface AgentEventMeta {
  seq?: number;
  ts?: number;
}

export type AgentEventBody =
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

/**
 * A normalized event as it travels the wire: the event body plus the optional
 * sequence metadata a shim stamps on it. Consumers keep switching on `type`
 * exactly as before (the intersection preserves the discriminated union); `id`
 * and `ts` are simply available when present.
 */
export type AgentEvent = AgentEventBody & AgentEventMeta;

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
  /**
   * True for link-agent sessions: the agent runs on the user's own machine
   * (outbound WS, no container). Absent => false; the status semantics of a
   * linked session differ ('stopped' means "agent host currently offline").
   */
  linked?: boolean;
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

/* ------------------------------------------------------------------ */
/* Link-agent relay (Kilo "remote connections" pattern, see            */
/* KILO-CLOUD-ANALYSE.md P2)                                           */
/* ------------------------------------------------------------------ */

/**
 * Wire protocol version a link agent speaks, carried on `agent.hello` and
 * `agent.heartbeat`. Bump only for a breaking change to the link<->server
 * wire format; additive features (new optional fields, new
 * `LinkCapabilities` flags) never need a bump. Absent on the wire means
 * version 1 - a pre-W2.4 link agent that predates heartbeats/capabilities
 * entirely; the server treats that exactly like version 1 explicitly.
 */
export const LINK_PROTOCOL_VERSION = 2;

/**
 * Feature flags a link agent advertises on `agent.hello`/`agent.heartbeat`.
 * Every flag is optional and MUST be treated as `false` when absent, so an
 * older link agent (which sends none of this) keeps working unchanged
 * against a newer server, and a newer link agent talking to an older server
 * (which just ignores fields it does not read) degrades to the old
 * behaviour instead of breaking. New flags are additive-only: never repurpose
 * or remove one, add another instead.
 */
export interface LinkCapabilities {
  /**
   * Sends periodic `agent.heartbeat` frames carrying the link's complete
   * session list (see `LinkSessionState`) instead of relying solely on
   * `agent.event`/connect-disconnect for status. Purely informational today
   * (the server reconciles from any `agent.heartbeat` it receives regardless
   * of this flag - the message itself is the capability signal); kept as an
   * explicit flag for parity with Kilo's advertisement pattern and so a
   * future capability that truly changes server behaviour has a precedent to
   * follow.
   */
  heartbeat?: boolean;
}

/**
 * Per-session status a link agent reports in its heartbeat, modelled on
 * Kilo's `idle|busy|question|permission`. PocketAgent's shim event stream
 * has no distinct "waiting for a free-text answer" signal today (only
 * `permission.request`), so no link agent currently emits `'question'` - it
 * exists for wire parity with Kilo and so a future adapter can use it
 * without a protocol change.
 */
export type LinkSessionStatus = 'idle' | 'busy' | 'question' | 'permission';

/** One session a link agent currently manages, as carried by `agent.heartbeat`. */
export interface LinkSessionState {
  /** Orchestrator-assigned id, i.e. the `sessionId` from `agent.ready`. */
  sessionId: string;
  status: LinkSessionStatus;
}

/**
 * WebSocket close codes the app<->orchestrator and link<->orchestrator
 * connections use (the 4000-4999 range is private-use per RFC 6455).
 * Centralized here so `server/` (which sends them) and `link/` (which reacts
 * to them) cannot drift apart; `android/` mirrors `WS_CLOSE_UNAUTHORIZED` as
 * a literal in `WsClient.kt` since Kotlin cannot import this package.
 */
/** Another connection already registered with this link's token; this socket lost the race. */
export const WS_CLOSE_REPLACED = 4000;
/** Bad/missing/revoked token, or no `hello`/`agent.hello` within the auth timeout. */
export const WS_CLOSE_UNAUTHORIZED = 4001;
/** Per-source-address connection cap (coarse DoS guard), see ws.ts MAX_CONNS_PER_ADDRESS. */
export const WS_CLOSE_TOO_MANY_CONNECTIONS = 4002;

/**
 * Terminal in the sense Kilo's 4401/4403/4409 are: retrying with the same
 * registration can never succeed, so a link agent stops its reconnect loop
 * for good instead of retrying with backoff.
 *  - `WS_CLOSE_UNAUTHORIZED`: the token is wrong or revoked - it stays wrong
 *    until a human changes it.
 *  - `WS_CLOSE_REPLACED`: another process already holds this link's slot.
 *    Reconnecting would just re-trigger the same replace on the other side
 *    (or flap forever if both sides keep retrying), so this side backs off
 *    for good and leaves it to whatever supervises the process (systemd,
 *    Docker's restart policy, a human) to decide about a restart.
 * Every other code - including `WS_CLOSE_TOO_MANY_CONNECTIONS`, a transient
 * resource cap, and any ordinary network drop or server restart - keeps
 * reconnecting with the existing exponential backoff.
 */
export function isTerminalLinkCloseCode(code: number): boolean {
  return code === WS_CLOSE_UNAUTHORIZED || code === WS_CLOSE_REPLACED;
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
      /** Absent => version 1 (pre-W2.4 link agent), no known capabilities. */
      protocolVersion?: number;
      capabilities?: LinkCapabilities;
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
  /**
   * `requestId` acks this one WS request (see above). `messageId` is the
   * app-generated, per-turn id (`msg_<random>`) that is stable across a resend:
   * the server admits a given messageId exactly once (idempotent), and echoes
   * it in the `request.ok` payload so the app can match the ack to the turn it
   * sent. Both are optional — a client that sends neither keeps the old
   * fire-and-forget, no-dedup behaviour.
   */
  | { type: 'session.prompt'; sessionId: string; text: string; mode?: AgentMode; requestId?: string; messageId?: string }
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
  /**
   * Per-turn lifecycle of a session (KILO-CLOUD-ANALYSE.md P1). Lets a client
   * that reconnected reconstruct every turn's fate (`TurnState`) instead of
   * inferring it from the event stream. `limit` counts the most recent turns
   * (default 50, max 500); the answer carries them oldest first.
   */
  | { type: 'session.turns.get'; requestId: string; sessionId: string; limit?: number }
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
  /**
   * Start an in-app browser/device sign-in for an adapter (CODEX-OAUTH.md
   * Variante A). The orchestrator starts a short-lived auth container, drives
   * the runtime's login (codex `login_chatgpt`), and answers with `auth.url`.
   * `flow` selects the manifest `AuthFlow.type` to use (default: the adapter's
   * first oauth-loopback flow, falling back to device-code). `requestId`
   * correlates the whole exchange (`auth.url`/`auth.callback`/`auth.done`).
   */
  | { type: 'auth.start'; requestId: string; adapter: AdapterId; flow?: AuthFlowType }
  /**
   * Forward a loopback OAuth callback the app captured (browser redirected to
   * `http://localhost:<port>/auth/callback?code&state` on the phone) to the
   * login server inside the auth container. The orchestrator never inspects
   * `code`/`state` — the runtime's own login server validates the state. They
   * are single-use and travel over the already device-authenticated WSS.
   */
  | { type: 'auth.callback'; requestId: string; code: string; state: string }
  /** Abort an in-flight auth flow (app closed the sheet / user cancelled). */
  | { type: 'auth.cancel'; requestId: string }
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
  /**
   * link agent -> server periodic full-state snapshot (~10s; Kilo P2
   * pattern). Carries every session the link currently manages instead of a
   * delta: the orchestrator needs no per-event bookkeeping to stay correct,
   * and a session id that stops appearing here is gone from the link
   * agent's point of view - the same conclusion as a socket close, just
   * without needing one. `protocolVersion`/`capabilities` ride along so the
   * server can gate future additive behaviour; both are optional and a
   * server that predates this message type never receives it at all (an
   * older link agent simply never sends `agent.heartbeat`).
   */
  | { type: 'agent.heartbeat'; sessions: LinkSessionState[]; protocolVersion?: number; capabilities?: LinkCapabilities }
  /** server -> link agent: session stopped from the app; link agent should shut down */
  | { type: 'agent.bye'; sessionId: string }
  | { type: 'error'; requestId?: string; sessionId?: string; message: string }
  | { type: 'request.ok'; requestId: string; payload?: unknown }
  | { type: 'session.list'; requestId: string; sessions: SessionInfo[] }
  | { type: 'session.event'; sessionId: string; event: AgentEvent }
  /** Answer to `session.events.get`: chronological, oldest first. */
  | { type: 'session.events'; requestId: string; sessionId: string; events: AgentEvent[] }
  /** Answer to `session.turns.get`: chronological, oldest first. */
  | { type: 'session.turns'; requestId: string; sessionId: string; turns: TurnInfo[] }
  /**
   * Live push on every turn-state transition (queued/running/terminal). Purely
   * additive: a client that predates the turn resource ignores this type and
   * keeps working off `session.status`/`session.event` as before.
   */
  | { type: 'turn.status'; sessionId: string; turn: TurnInfo }
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
  /**
   * Answer to `auth.start`: the runtime's login URL to open in the browser and
   * the loopback `port` its redirect will target — the app must run its
   * loopback listener on exactly this port (codex binds 1455, fallback 1457,
   * and the server reports whichever it actually got). For a `device-code`
   * flow `userCode` carries the code to show and `port` is 0 (no listener).
   */
  | { type: 'auth.url'; requestId: string; url: string; port: number; flow?: AuthFlowType; userCode?: string }
  /**
   * Terminal result of an auth flow. `ok` with an optional `account` label
   * (e.g. "ChatGPT Plus, user@example.com") on success; `error` describes the
   * failure otherwise. After `ok` the orchestrator has written the vault backup
   * (secret kind `codex_oauth`) from the shared CODEX_HOME volume.
   */
  | { type: 'auth.done'; requestId: string; ok: boolean; account?: string; error?: string }
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
  /**
   * Only set for `permission.request`: lets the app answer directly from an
   * actionable notification (Allow/Deny) without opening the session first —
   * `session.permission` needs it to address the right approval.
   */
  permissionId?: string;
}

/* ------------------------------------------------------------------ */
/* Shared opencode-wire helpers (used by the kilo shim)                */
/*                                                                     */
/* kilo is an OpenCode fork, so it speaks the same `/config/providers` */
/* catalog format and the same `provider/model` id form OpenCode does. */
/* The logic is pure, synchronous and dependency-free, so it stays as  */
/* portable as the type declarations above.                            */
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

/* ------------------------------------------------------------------ */
/* Shared event sequencing + replay (used by every shim's broadcaster) */
/*                                                                     */
/* All shims speak the same normalized SSE stream, and all of them lost */
/* events on a reconnect gap because the broadcaster buffered nothing   */
/* and carried no ids. This one implementation gives every shim a       */
/* monotone `id` per event, a ring buffer of the recent past, and       */
/* Last-Event-ID replay - the orchestrator side reconnects with the id  */
/* it last saw, and the shim resends whatever is still in the ring. It  */
/* stays pure and dependency-free (loaded verbatim in shim containers   */
/* via node's type stripping), so the sink is a structural type, never  */
/* an import of node:http.                                              */
/* ------------------------------------------------------------------ */

/** How many recent events a shim keeps for Last-Event-ID replay. */
export const EVENT_RING_CAPACITY = 1000;

/**
 * Minimal SSE client the broadcaster writes to. `ServerResponse` satisfies it
 * structurally, so nothing here depends on node:http. `writableEnded` lets the
 * broadcaster drop a client whose socket already closed.
 */
export interface SseSink {
  write(chunk: string): unknown;
  readonly writableEnded?: boolean;
}

/**
 * Parse a `Last-Event-ID` header (SSE reconnect) into a sequence number. Node
 * lower-cases header names and may hand back an array for a repeated header;
 * anything that is not a non-negative integer means "no cursor" (a fresh
 * connection), which replays nothing.
 */
export function parseLastEventId(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Fan-out broadcaster for the normalized AgentEvent SSE stream with per-event
 * sequence ids and a replay ring.
 *
 * `publish` stamps the next id (and a `ts`) into the event, formats the SSE
 * frame with an `id:` line, buffers it, and writes it to every live client.
 * `add` registers a client; on a reconnect the caller passes the client's
 * Last-Event-ID and every buffered frame after it is replayed first, so a gap
 * in the connection loses no event still held in the ring.
 *
 * `ping` keepalives are deliberately unsequenced: they are fanned out to keep
 * the socket warm but never consume an id or a ring slot, so a long-idle
 * session's pings cannot evict the real events (a missed `turn.completed`) that
 * a reconnecting client still needs to replay.
 */
export class SequencedSseBroadcaster {
  private seq = 0;
  private readonly ring: { id: number; frame: string }[] = [];
  private readonly clients = new Set<SseSink>();
  private readonly capacity: number;

  constructor(capacity: number = EVENT_RING_CAPACITY) {
    this.capacity = capacity > 0 ? capacity : EVENT_RING_CAPACITY;
  }

  /**
   * Stamp, buffer and fan out an event. Returns the assigned id, or `undefined`
   * for a `ping` (which is sent live but never sequenced).
   */
  publish(event: AgentEvent): number | undefined {
    if (event.type === 'ping') {
      this.fanout(`event: agent\ndata: ${JSON.stringify(event)}\n\n`);
      return undefined;
    }
    const id = ++this.seq;
    const stamped: AgentEvent = { ...event, seq: id, ts: event.ts ?? Date.now() };
    const frame = `id: ${id}\nevent: agent\ndata: ${JSON.stringify(stamped)}\n\n`;
    this.ring.push({ id, frame });
    if (this.ring.length > this.capacity) this.ring.shift();
    this.fanout(frame);
    return id;
  }

  /**
   * Register an SSE client. `lastEventId` (from its Last-Event-ID header on a
   * reconnect) replays every still-buffered frame after it before the client
   * starts receiving live frames again.
   */
  add(sink: SseSink, lastEventId?: number): void {
    if (lastEventId !== undefined) {
      for (const entry of this.ring) if (entry.id > lastEventId) this.writeTo(sink, entry.frame);
    }
    this.clients.add(sink);
  }

  remove(sink: SseSink): void {
    this.clients.delete(sink);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** The id of the last sequenced event (0 before anything was published). */
  get lastId(): number {
    return this.seq;
  }

  private fanout(frame: string): void {
    for (const sink of this.clients) this.writeTo(sink, frame);
  }

  private writeTo(sink: SseSink, frame: string): void {
    if (sink.writableEnded === true) {
      this.clients.delete(sink);
      return;
    }
    try {
      sink.write(frame);
    } catch {
      this.clients.delete(sink);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Egress proxy wiring (used at process start by every shim)          */
/* Under network policy 'allowlist' a session container hangs on an   */
/* internal docker network with no route out: the only way to the     */
/* internet is the orchestrator's egress proxy, handed in as          */
/* HTTP_PROXY / HTTPS_PROXY / NO_PROXY (server/src/docker.ts,         */
/* sessionNetworking). Node honours none of those on its own - not    */
/* fetch (undici), not http.request - so whether a provider call went */
/* through the proxy came down to which HTTP client the SDK happened  */
/* to use. The clients that ignore the variables died with a bare     */
/* "Connection error." and left no line in the proxy log at all,      */
/* because nothing ever reached the proxy. Pinning undici's *global*  */
/* dispatcher fixes that for the whole process at once, an SDK's own  */
/* bundled undici copy included: the global dispatcher lives on a     */
/* globalThis symbol that every copy reads.                           */
/*                                                                    */
/* Pure and node-free like the rest of this file (it is loaded        */
/* verbatim in the containers via node's type stripping): the undici  */
/* call comes in as a callback, and the caller does the logging.      */
/* ------------------------------------------------------------------ */

/**
 * The proxy URL the environment asks outbound traffic to take, or `undefined`
 * when the session was started without one (policy 'open': direct internet).
 * https wins over http because every provider endpoint is https, and both
 * spellings are read - these variables are conventionally lowercase, but the
 * orchestrator injects the uppercase form.
 */
export function envProxyUrl(env: Record<string, string | undefined>): string | undefined {
  const raw = env.https_proxy ?? env.HTTPS_PROXY ?? env.http_proxy ?? env.HTTP_PROXY;
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Proxy URL without its userinfo. The injected URL carries the session's shim
 * token as Basic credentials for the egress proxy, so only this form may be
 * logged.
 */
export function redactProxyUrl(url: string): string {
  return url.replace(/\/\/[^/@]*@/, '//***@');
}

/**
 * Pin every outbound HTTP(S) request of this process to the egress proxy - but
 * only when one is configured. Without proxy variables the container has direct
 * internet access and must keep it: installing a dispatcher there would aim
 * every request at a proxy that does not exist.
 *
 * `install` is expected to set undici's global dispatcher to an
 * `EnvHttpProxyAgent`, which reads HTTP_PROXY/HTTPS_PROXY/NO_PROXY itself - so
 * loopback traffic named in NO_PROXY (the shim's own HTTP surface, kilo's local
 * `kilo serve`) keeps going direct. It is a callback because this package is
 * loaded as TypeScript source from /app/packages/protocol in the shim images,
 * where a bare `import 'undici'` would resolve against the package's own
 * (nonexistent) node_modules instead of the shim's.
 *
 * Returns the redacted proxy URL now in force, or `undefined` when nothing was
 * installed.
 */
export function installEnvProxyDispatcher(
  env: Record<string, string | undefined>,
  install: () => void,
): string | undefined {
  const proxy = envProxyUrl(env);
  if (proxy === undefined) return undefined;
  install();
  return redactProxyUrl(proxy);
}
