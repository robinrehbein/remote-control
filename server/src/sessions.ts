import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AdapterId,
  AgentEvent,
  AgentMode,
  ClientMessage,
  DiffEntry,
  LinkSessionState,
  LinkSessionStatus,
  ModelInfo,
  NetworkPolicy,
  NoticePhase,
  PermissionDecision,
  PromptRequest,
  ReasoningEffort,
  ServerMessage,
  SessionInfo,
  SessionStatus,
  TurnFailureReason,
  TurnInfo,
} from '@pocketagent/protocol';
import { SERVER_VERSION, config, isNetworkPolicy } from './config.js';
import type { LinkRow, RepoRow, SessionRow, Store, TurnRow } from './db.js';
import * as docker from './docker.js';
import type { NoticeFn } from './docker.js';
import {
  LOG_TAIL_LINES,
  SHIM_LOG_POLL_MS,
  detailFrom,
  newTailLines,
  shimProgressMessage,
  splitLogLines,
} from './progress.js';

import { getAdapter } from './adapters.js';
import { matchTokenDigest, tokenDigest, type EgressSession, type TokenEntry } from './egress-proxy.js';
import { ShimClient, normalizeModels } from './shim-client.js';
import { sendPush } from './fcm.js';

const TENANT = 'default';

const AGENT_MODES: readonly AgentMode[] = ['yolo', 'auto', 'acceptEdits', 'ask'];
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];
const NOTICE_PHASES: readonly NoticePhase[] = ['image-build', 'container-start', 'shim-start', 'ready'];
const LINK_SESSION_STATUSES: readonly LinkSessionStatus[] = ['idle', 'busy', 'question', 'permission'];

export function isAgentMode(v: unknown): v is AgentMode {
  return typeof v === 'string' && (AGENT_MODES as readonly string[]).includes(v);
}

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === 'string' && (REASONING_EFFORTS as readonly string[]).includes(v);
}

export function isNoticePhase(v: unknown): v is NoticePhase {
  return typeof v === 'string' && (NOTICE_PHASES as readonly string[]).includes(v);
}

export function isLinkSessionStatus(v: unknown): v is LinkSessionStatus {
  return typeof v === 'string' && (LINK_SESSION_STATUSES as readonly string[]).includes(v);
}

/**
 * Maps a link agent's heartbeat status onto ours. `SessionStatus` has no
 * counterpart for "mid-turn, waiting on the user" (question/permission) -
 * the shim's own `busy` flag already collapses those into one boolean, and
 * `permission.request`/`.resolved` events carry the finer detail
 * separately - so both fold into 'running', same as everything else that is
 * not 'idle'.
 */
export function statusFromLinkHeartbeat(status: LinkSessionStatus): SessionStatus {
  return status === 'idle' ? 'idle' : 'running';
}

/**
 * Session states in which a container of that session may be talking to the
 * egress proxy: it is being provisioned, or it is up. A stopped, failed or
 * archived session has no running container, so its shim token must not open
 * the proxy for anyone who still holds it (it stays in the row until GC).
 * The one container that lives outside these states is the throwaway push
 * container, which gets an explicit grant for the duration of the push.
 */
const EGRESS_LIVE_STATUSES: readonly SessionStatus[] = ['creating', 'running', 'idle'];

/**
 * A 'running' session that has emitted no event for this long is treated as
 * possibly hung (a lost turn.completed) and its shim is asked directly whether
 * it is still busy - see resyncRunningStatuses. Long enough that an actually
 * working turn (which keeps touching last_active_at with its events) is never
 * caught, short enough to correct a hang well before the idle reaper would.
 */
export const RESYNC_STALE_MS = 90_000;

/** `session.events.get`: youngest events, chronological; the client may ask for fewer. */
export const EVENTS_DEFAULT_LIMIT = 200;
export const EVENTS_MAX_LIMIT = 1000;

/** `session.turns.get`: youngest turns, chronological; a session has far fewer turns than events. */
export const TURNS_DEFAULT_LIMIT = 50;
export const TURNS_MAX_LIMIT = 500;

/** Same clamping contract as clampEventLimit: unusable -> default, otherwise into [1, max]. */
export function clampTurnLimit(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return TURNS_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(v), 1), TURNS_MAX_LIMIT);
}

/**
 * Event limit of a history request. Anything unusable (missing, not a finite
 * number) falls back to the default, everything else is clamped into
 * [1, EVENTS_MAX_LIMIT] - the limit reaches sqlite, so it must never be a
 * client-controlled way to read the whole table.
 */
export function clampEventLimit(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return EVENTS_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(v), 1), EVENTS_MAX_LIMIT);
}

/**
 * Does an event belong in the stored timeline? 'ping' is pure keepalive, and a
 * notice with a `phase` is live progress of a start that is over by the time
 * anyone reloads the history. Both are dropped on write so they cannot push
 * real messages out of the 5000 events a session keeps (appendEvent); the read
 * path applies the same rule to rows written before this filter existed.
 */
export function isHistoryEvent(ev: AgentEvent): boolean {
  if (ev.type === 'ping') return false;
  return !(ev.type === 'notice' && ev.phase !== undefined);
}

/** Longest title a client may set; beyond that the list layout is unreadable anyway. */
export const MAX_TITLE_LEN = 80;

/**
 * Normalize a user-set session title: control characters (a pasted newline
 * would break every list row) collapse into spaces, and the result is cut to
 * MAX_TITLE_LEN. An empty result means "no title" - the documented way to get
 * the derived name back.
 */
export function sanitizeSessionTitle(raw: string): string | null {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, MAX_TITLE_LEN).trim();
}

/**
 * Provider a session falls back to when it switches to another harness: the
 * manifest default, else its first provider key, else none (adapters whose
 * credentials are fixed, e.g. claude).
 */
export function defaultProviderFor(adapter: string): string {
  const desc = getAdapter(adapter);
  const fallback = Object.keys(desc?.providerEnv ?? {})[0] ?? '';
  return desc?.defaults.provider || fallback;
}

/**
 * Prompt body from the session row: mode/model/reasoningEffort are session
 * state (switchable via `session.update`), so every turn carries them.
 * Provider only rides along with a model, since runtimes that address models
 * as provider+model need both.
 *
 * `model` is sent whenever the column holds a string - including the empty
 * string, which is the documented "adapter default" reset every shim
 * implements (and a no-op for sessions that never picked a model).
 */
export function buildPromptBody(row: SessionRow, text: string, mode?: AgentMode): PromptRequest {
  const effectiveMode = mode ?? (isAgentMode(row.mode) ? row.mode : undefined);
  return {
    text,
    ...(effectiveMode !== undefined ? { mode: effectiveMode } : {}),
    ...(typeof row.model === 'string'
      ? { model: row.model, ...(row.provider ? { provider: row.provider } : {}) }
      : {}),
    ...(isReasoningEffort(row.reasoning_effort) ? { reasoningEffort: row.reasoning_effort } : {}),
  };
}

/**
 * GC-Kriterium einer Session. Der Cutoff zählt ab der letzten *Aktivität*, nicht
 * ab der Erstellung: eine täglich benutzte Session ist am Tag 14 nicht alt,
 * sondern mitten in der Arbeit - ihr Volume zu löschen kostet jeden ungepushten
 * Commit auf `agent/<id>`. Weggeräumt wird deshalb nur, was der Nutzer
 * erkennbar liegen gelassen hat: eine gestoppte oder fehlgeschlagene Session,
 * die seit dem Cutoff nichts mehr getan hat.
 *
 * Link-Sessions bleiben grundsätzlich stehen. Sie sind bewusst langlebig (siehe
 * reapIdle) und überschreiten den Cutoff garantiert; ein deleteSession würde
 * ihnen zusätzlich `agent.bye` schicken und damit den Agenten auf dem Rechner
 * des Nutzers herunterfahren.
 *
 * Ein unlesbares last_active_at fällt auf created_at zurück, damit eine kaputte
 * Zeile nicht unsterblich wird.
 */
export function isCollectableSession(row: SessionRow, cutoffMs: number): boolean {
  if (row.link_id) return false;
  if (row.status !== 'stopped' && row.status !== 'error') return false;
  const lastActive = Date.parse(row.last_active_at);
  const reference = Number.isFinite(lastActive) ? lastActive : Date.parse(row.created_at);
  return Number.isFinite(reference) && reference < cutoffMs;
}

/**
 * Ein Lifecycle-Lauf (provision/reprovision/resume) wurde überholt: die Session
 * ist gelöscht oder gestoppt worden, oder ein neuerer Lauf hat übernommen. Kein
 * Fehler der Session - der abgebrochene Lauf räumt nur sein eigenes Werk ab und
 * meldet nichts an die App.
 */
class LifecycleAborted extends Error {
  constructor(sessionId: string) {
    super(`lifecycle run for ${sessionId} was superseded`);
    this.name = 'LifecycleAborted';
  }
}

type CreateMsg = Extract<ClientMessage, { type: 'session.create' }>;
type UpdateMsg = Extract<ClientMessage, { type: 'session.update' }>;
type LinkHello = Extract<ClientMessage, { type: 'agent.hello' }>;

/** Transport for link-agent sessions (agent dialed in via outbound WS). */
export interface LinkTransport {
  call(linkId: string, path: string, method: 'GET' | 'POST', body?: unknown): Promise<{ status: number; body?: unknown } | null>;
  isConnected(linkId: string): boolean;
  bye(linkId: string): void;
}

export class SessionManager {
  private readonly clients = new Map<string, ShimClient>();
  private readonly timers: NodeJS.Timeout[] = [];
  private linkTransport: LinkTransport | null = null;
  /**
   * Generation pro Session: jede Aktion, die einen laufenden Start ungültig
   * macht (Stop, Delete, Resume, Adapter-Wechsel), zählt sie hoch. Ein
   * Lifecycle-Lauf merkt sich seine eigene Generation und prüft sie nach jedem
   * `await` - siehe checkpoint().
   */
  private readonly generations = new Map<string, number>();
  /** Laufende Resumes pro Session (Doppel-Tap/zweites Gerät teilen sich einen Lauf). */
  private readonly resuming = new Map<string, Promise<void>>();
  /**
   * Sessions mit einem laufenden Push-Container. Der ist ein Wegwerf-Container
   * ohne eigene Zeile und pusht durch denselben Egress-Proxy - er braucht also
   * Egress, auch wenn die Session selbst gerade gestoppt ist.
   */
  private readonly pushing = new Set<string>();
  /**
   * Höchste bereits persistierte Event-Sequenz (AgentEventMeta.seq) pro Session.
   * persistEvent verwirft alles, was nicht darüber liegt - so schreibt ein
   * Replay nach einem Reconnect keine Duplikate in die Historie. Wird beim
   * Aufbau eines frischen Event-Streams (connectEvents) zurückgesetzt, weil die
   * Shim-Sequenz mit einem neuen Container wieder bei 0 beginnt.
   */
  private readonly lastPersistedSeq = new Map<string, number>();
  /** Abgeleitete Token-Tabelle des Egress-Gates (siehe egressTokens). */
  private egressTokenCache: { revision: number; entries: TokenEntry<string>[] } | null = null;
  readonly startedAt = Date.now();

  constructor(
    private readonly store: Store,
    private readonly broadcast: (m: ServerMessage) => void,
  ) {}

  /**
   * Egress proxy auth (wired by the caller into startEgressProxy): the session
   * a proxy token belongs to, or null.
   *
   * The token table is derived from the session rows and rebuilt whenever a row
   * that decides egress changes (Store.sessionAuthRevision), so the hot proxy
   * path costs one hash and no query. The comparison runs over SHA-256 digests
   * with timingSafeEqual and without an early exit - the tokens are 24 random
   * bytes, but a token table is not the place to leave a timing side channel.
   * Liveness is checked on the matched row itself, so a session that stopped a
   * moment ago is refused immediately instead of at the next rebuild.
   */
  egressTokenAllowed(token: string): EgressSession | null {
    const id = matchTokenDigest(token, this.egressTokens());
    return id === null ? null : this.liveEgressSession(id);
  }

  /**
   * Second, client-independent egress gate: a request coming from the IP of a
   * live session container passes without credentials. Node/undici drop the
   * userinfo of HTTP(S)_PROXY, so an agent talking to its LLM through fetch()
   * never authenticates - the token gate alone would deny every one of its
   * turns while git (which does send it) keeps working.
   */
  egressPeerAllowed(ip: string): EgressSession | null {
    const id = docker.sessionIdForPeerIp(ip);
    return id === null ? null : this.liveEgressSession(id);
  }

  /**
   * The live sessions the remote gateway has to know to gate its own egress
   * proxy the same way (docker.publishEgressTable pushes this table). A session
   * that may not egress right now is simply absent.
   */
  egressSessions(tenant: string = TENANT): { id: string; policy: NetworkPolicy; token: string | null }[] {
    const live: { id: string; policy: NetworkPolicy; token: string | null }[] = [];
    for (const row of this.store.listSessions(tenant)) {
      const session = this.egressSessionOf(row);
      if (session !== null) live.push({ ...session, token: row.shim_token });
    }
    return live;
  }

  /**
   * May this session reach the network right now, and under which policy?
   * `null` = not at all. Policy and liveness are read from the row on every
   * call: both change without the proxy noticing, and a wrong answer here is
   * either an open door or a broken session.
   */
  private egressSessionOf(row: SessionRow): EgressSession | null {
    const policy: NetworkPolicy = isNetworkPolicy(row.network_policy)
      ? row.network_policy
      : config.networkPolicyDefault;
    const live =
      this.pushing.has(row.id) ||
      (row.archived === 0 && (EGRESS_LIVE_STATUSES as readonly string[]).includes(row.status));
    return live ? { id: row.id, policy } : null;
  }

  private liveEgressSession(id: string): EgressSession | null {
    const row = this.store.getSession(id);
    return row === undefined ? null : this.egressSessionOf(row);
  }

  /** Token table for the proxy gate, rebuilt only when a session row changed. */
  private egressTokens(): readonly TokenEntry<string>[] {
    const revision = this.store.sessionAuthRevision;
    if (this.egressTokenCache === null || this.egressTokenCache.revision !== revision) {
      const entries: TokenEntry<string>[] = [];
      for (const row of this.store.listSessions(TENANT)) {
        if (row.shim_token) entries.push({ digest: tokenDigest(row.shim_token), value: row.id });
      }
      this.egressTokenCache = { revision, entries };
    }
    return this.egressTokenCache.entries;
  }

  setLinkTransport(t: LinkTransport): void {
    this.linkTransport = t;
  }

  /** Link agent (re)connected: bind or create its session row and mark idle. */
  registerLinkSession(link: LinkRow, hello: LinkHello): string {
    const now = new Date().toISOString();
    const existing = this.store.getSessionByLink(link.id);
    if (existing) {
      if (hello.mode) this.store.updateSessionMode(existing.id, hello.mode);
      if (hello.sessionRef) this.store.setSessionRef(existing.id, hello.sessionRef);
      this.store.touchSession(existing.id);
      this.setStatus(existing.id, 'idle');
      return existing.id;
    }
    const id = randomUUID();
    const row: SessionRow = {
      id,
      tenant_id: link.tenant_id,
      repo_id: '',
      repo_full_name: `link:${hello.name ?? link.name}${hello.workDir ? ` (${hello.workDir})` : ''}`,
      adapter: hello.adapter,
      provider: '',
      model: '',
      mode: hello.mode ?? 'ask',
      status: 'idle',
      branch: hello.branch ?? 'local',
      session_ref: hello.sessionRef ?? null,
      container_id: null,
      volume_name: null,
      shim_token: null,
      pr_url: null,
      shim_endpoint: null,
      link_id: null,
      network_policy: null,
      reasoning_effort: null,
      title: null,
      archived: 0,
      created_at: now,
      last_active_at: now,
    };
    this.store.insertSession(row);
    this.store.setLinkId(id, link.id);
    this.broadcastStatus(id, 'idle');
    return id;
  }

  /** Link agent socket dropped: session becomes stopped (resumes on reconnect). */
  linkDisconnected(linkId: string): void {
    const row = this.store.getSessionByLink(linkId);
    if (row && row.status !== 'stopped') this.setStatus(row.id, 'stopped');
  }

  /** Normalized event arriving from a link agent (same pipeline as shim SSE). */
  handleLinkEvent(sessionId: string, ev: AgentEvent): void {
    this.onEvent(sessionId, ev);
  }

  /**
   * Link agent's periodic full-state heartbeat (Kilo P2, KILO-CLOUD-ANALYSE.md
   * "Heartbeat als Vollzustand"). Reconciles the linked session's status from
   * the complete snapshot instead of depending on every individual
   * `agent.event` having arrived - a `turn.completed`/`.failed` lost to a
   * flaky connection no longer leaves a session 'running' forever, and a
   * reconnect is trivially correct because the next heartbeat re-states the
   * whole truth rather than a delta.
   *
   * `sessions` is untrusted wire input (JSON off the socket), so it is
   * re-validated here rather than trusted as `LinkSessionState[]`; a
   * malformed frame degrades to "no entries", never a crash. A link is bound
   * to exactly one orchestrator session (registerLinkSession), so only the
   * entry matching that session id is ever acted on - extra ids in the array
   * (a future link agent hosting more than one session) are accepted on the
   * wire but ignored today, not an error.
   *
   * Absent from the list = gone, the same conclusion `linkDisconnected` draws
   * from a closed socket: today that only happens on disconnect (the link
   * agent's own process manages exactly one session), but the server honours
   * it either way so a future multi-session link agent that drops a session
   * without closing its socket is handled correctly from day one.
   */
  handleLinkHeartbeat(linkId: string, sessions: unknown): void {
    const row = this.store.getSessionByLink(linkId);
    if (!row) return;
    const list = Array.isArray(sessions) ? sessions : [];
    const mine = list.find((s): s is LinkSessionState => {
      if (typeof s !== 'object' || s === null) return false;
      const rec = s as { sessionId?: unknown; status?: unknown };
      return rec.sessionId === row.id && isLinkSessionStatus(rec.status);
    });
    if (!mine) {
      if (row.status !== 'stopped') this.setStatus(row.id, 'stopped');
      return;
    }
    const next = statusFromLinkHeartbeat(mine.status);
    if (row.status !== next) this.setStatus(row.id, next);
  }

  createSession(msg: CreateMsg, tenant: string = TENANT): SessionRow {
    const repo = this.store.getRepo(msg.repoId);
    if (!repo) throw new Error('repo not found');
    if (!getAdapter(msg.adapter)) throw new Error(`unknown adapter "${msg.adapter}"`);
    if (msg.networkPolicy !== undefined && !isNetworkPolicy(msg.networkPolicy)) {
      throw new Error(`invalid networkPolicy "${String(msg.networkPolicy)}"`);
    }
    const networkPolicy: NetworkPolicy = msg.networkPolicy ?? config.networkPolicyDefault;
    // Remote-mode gating (skip when the gateway container provides per-session
    // networks + egress): without GATEWAY_TOKEN, allowlist/isolated cannot be
    // served and 'open' publishes plaintext shim ports - explicit consent only.
    if (docker.isRemote() && !docker.gatewayEnabled()) {
      if (networkPolicy === 'allowlist' || networkPolicy === 'isolated') {
        throw new Error('network policies require local docker socket mode or a configured gateway (GATEWAY_TOKEN)');
      }
      if (!config.remoteNetworkOpen) {
        throw new Error(
          'remote docker mode ships shim traffic plaintext over DOCKER_ADDR (published ports) unless tunneled; ' +
            'set REMOTE_NETWORK_OPEN=1 to explicitly consent to networkPolicy "open" for remote sessions',
        );
      }
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const row: SessionRow = {
      id,
      tenant_id: tenant,
      repo_id: repo.id,
      repo_full_name: repo.full_name,
      adapter: msg.adapter,
      provider: msg.provider,
      model: msg.model,
      mode: msg.mode,
      status: 'creating',
      branch: `agent/${id}`,
      session_ref: null,
      container_id: null,
      volume_name: null,
      shim_token: null,
      pr_url: null,
      shim_endpoint: null,
      link_id: null,
      network_policy: networkPolicy,
      reasoning_effort: null,
      title: null,
      archived: 0,
      created_at: now,
      last_active_at: now,
    };
    this.store.insertSession(row);
    // Announce the session to every device the moment it exists - not only
    // when provisioning finishes. Clients insert unknown sessions from this
    // broadcast, so the creating phone finds its own session deterministically
    // (by the acked id) instead of diffing the session list, and a second
    // device sees it right away.
    this.broadcastStatus(row.id, 'creating');
    void this.provision(row, repo, msg.branch ?? repo.default_branch);
    return row;
  }

  /**
   * Progress channel of a provisioning run (image build takes minutes).
   * A notice with a `phase` is live progress the app shows instead of its
   * status line; one without stays an ordinary timeline entry.
   */
  private noticeFor(sessionId: string): NoticeFn {
    return (message, progress) =>
      this.emitEvent(sessionId, {
        type: 'notice',
        message,
        ...(progress?.phase ? { phase: progress.phase } : {}),
        ...(progress?.detail ? { detail: progress.detail } : {}),
      });
  }

  /**
   * Beginn eines Lifecycle-Laufs: die neue Generation macht jeden älteren Lauf
   * derselben Session ungültig (dessen nächster checkpoint bricht ab).
   */
  private nextGeneration(id: string): number {
    const gen = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, gen);
    return gen;
  }

  /**
   * Abbruchprüfung nach jedem `await` eines Lifecycle-Laufs: existiert die
   * Session noch und ist die eigene Generation noch die aktuelle? Sonst räumt
   * der Lauf den eben erstellten Container selbst ab (niemand sonst kennt ihn -
   * eine gelöschte Zeile führt keine Container-Id mehr) und bricht ab.
   */
  private async checkpoint(id: string, gen: number, containerId: string | null = null): Promise<void> {
    const row = this.store.getSession(id);
    if (row !== undefined && this.generations.get(id) === gen) return;
    await this.discardRun(id, containerId);
    throw new LifecycleAborted(id);
  }

  /**
   * Aufräumen eines überholten Lifecycle-Laufs. Der eben erstellte Container
   * wird immer gestoppt; entfernt wird er nur, wenn die Zeile ihn nicht (mehr)
   * kennt - sonst nähme man dem Nachfolger seinen eigenen Container weg. Ist
   * die Zeile ganz verschwunden (Delete während des Starts), gehören auch
   * Volume und Netz niemandem mehr.
   */
  private async discardRun(id: string, containerId: string | null): Promise<void> {
    const short = id.slice(0, 8);
    if (containerId) {
      await docker.stopContainer(containerId).catch(() => {});
      const row = this.store.getSession(id);
      if (!row || row.container_id !== containerId) await docker.removeContainer(containerId).catch(() => {});
    }
    if (this.store.getSession(id) === undefined) {
      this.clients.get(id)?.stop();
      this.clients.delete(id);
      this.generations.delete(id);
      this.lastPersistedSeq.delete(id);
      // Same derivation as provision(): the row is gone, so the volume name is
      // no longer readable from it.
      await docker.removeVolume(`pocketagent-sess-${id}`).catch(() => {});
      await docker.removeSessionNetwork(id).catch(() => {});
      await docker.refreshSessionPeers().catch(() => {});
      console.log(`[sessions] start of ${short} aborted - session was deleted, its container was cleaned up`);
      return;
    }
    console.log(`[sessions] start of ${short} aborted - superseded by a newer lifecycle action`);
  }

  private async provision(row: SessionRow, repo: RepoRow, baseBranch: string): Promise<void> {
    const notice = this.noticeFor(row.id);
    const gen = this.nextGeneration(row.id);
    let cid: string | null = null;
    try {
      if (!config.dockerEnabled) throw new Error('docker is disabled on this server');
      await docker.ensureNetwork();
      await this.checkpoint(row.id, gen);
      const shimToken = randomBytes(24).toString('hex');
      const staged: SessionRow = { ...row, volume_name: `pocketagent-sess-${row.id}`, shim_token: shimToken };
      const env = this.buildEnv(staged, repo, shimToken, baseBranch);
      cid = await docker.createSessionContainer(staged, env, notice);
      // From here on every abort has a container to clean up.
      await this.checkpoint(row.id, gen, cid);
      const pat = this.githubPatFor(row);
      if (pat) await docker.injectCredsFile(cid, { githubPat: pat });
      await this.checkpoint(row.id, gen, cid);
      // Persist BEFORE the start: the egress proxy authorizes a session by its
      // stored shim_token (egressTokenAllowed), and an 'allowlist' shim clones
      // through that proxy the moment its container runs - a token that is
      // still unknown then turns the first clone into a 407. Recording the
      // container id here also keeps a failed start cleanable.
      this.store.setProvisioned(row.id, cid, staged.volume_name as string, shimToken);
      notice('Container startet', { phase: 'container-start' });
      if (!(await docker.startContainer(cid))) throw new Error('failed to start session container');
      await this.checkpoint(row.id, gen, cid);
      const endpoint = await docker.shimEndpoint(cid, row.id);
      await this.checkpoint(row.id, gen, cid);
      this.store.setShimEndpoint(row.id, endpoint);
      const base = this.shimBase(row.id, endpoint);
      await this.waitForShim(base, shimToken, 60_000, cid, notice);
      // The last gate before the session is declared ready: a stop during the
      // shim wait must not be overwritten with 'idle' seconds later.
      await this.checkpoint(row.id, gen, cid);
      notice('Bereit', { phase: 'ready' });
      this.connectEvents(row.id, base, shimToken);
      this.setStatus(row.id, 'idle');
    } catch (err) {
      if (err instanceof LifecycleAborted) return; // discardRun already logged and cleaned up
      const message = err instanceof Error ? err.message : String(err);
      // Also on the server log: the app is not always in reach when a session
      // dies, and provisioning failures were previously invisible in `docker logs`.
      console.error(`[sessions] provisioning failed for ${row.id.slice(0, 8)} (${row.adapter}): ${message}`);
      // A container that never became ready keeps its memory reservation and
      // may burn CPU in a crash loop; reapIdle never touches 'error' sessions.
      await this.stopFailedContainer(row.id, cid);
      this.store.updateSessionStatus(row.id, 'error');
      this.emitEvent(row.id, { type: 'error', message, fatal: true });
      this.broadcastStatus(row.id, 'error');
    }
  }

  /**
   * Container einer fehlgeschlagenen Provisionierung anhalten (best effort):
   * er bleibt bestehen, damit `session.resume` ihn wieder starten kann, frisst
   * aber bis dahin keine Ressourcen mehr.
   */
  private async stopFailedContainer(id: string, containerId: string | null): Promise<void> {
    const cid = containerId ?? this.store.getSession(id)?.container_id ?? null;
    if (!cid) return;
    await docker.stopContainer(cid).catch((e: unknown) => {
      console.warn(`[sessions] stopping the failed container of ${id.slice(0, 8)} failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  private shimBase(id: string, endpoint?: string | null): string {
    return endpoint ?? this.store.getSession(id)?.shim_endpoint ?? `http://${id}:8080`;
  }

  /**
   * Shim client for a session base URL. In remote-gateway mode the base URL
   * points at the gateway (`.../s/<id>`), which requires the shared-secret
   * header; all local modes add no extra headers.
   */
  private shimClient(base: string, token: string): ShimClient {
    return new ShimClient(base, token, docker.gatewayHeaders());
  }

  /**
   * GitHub PAT (K1 store lookup, plaintext). Never passed as container env;
   * injected as /run/secrets/pa/creds.json before container start (K2).
   */
  private githubPatFor(row: SessionRow): string | null {
    return this.store.getSecretValue('github', row.tenant_id);
  }

  private buildEnv(
    row: SessionRow,
    repo: RepoRow,
    shimToken: string,
    baseBranch: string,
  ): Record<string, string | undefined> {
    const desc = getAdapter(row.adapter);
    if (!desc) throw new Error(`unknown adapter "${row.adapter}"`);
    const env: Record<string, string | undefined> = {
      SHIM_TOKEN: shimToken,
      WORK_DIR: '/work',
      AGENT_MODE: row.mode,
      ADAPTER: row.adapter,
      SESSION_ID: row.id,
      REPO_URL: `https://github.com/${repo.full_name}.git`,
      REPO_BRANCH: baseBranch,
      REPO_FULL_NAME: repo.full_name,
      AUTO_PUSH: row.mode === 'yolo' ? '1' : '0',
      // creds file injected via putArchive before container start (see githubPatFor)
      PA_CREDS_FILE: '/run/secrets/pa/creds.json',
    };
    // getSecretValue (not a raw decrypt): secrets are AAD-bound since the
    // vault migration, and only this path knows both the AAD and the legacy
    // fallback - decrypting the row directly throws on every current key.
    const setKey = (kind: string, key: string): void => {
      const value = this.store.getSecretValue(kind, row.tenant_id);
      if (value !== null) env[key] = value;
    };
    for (const [kind, vars] of Object.entries(desc.credentials ?? {})) {
      for (const v of vars) setKey(kind, v);
    }
    const envVar = desc.providerEnv?.[row.provider];
    if (envVar) setKey(row.provider, envVar);
    return env;
  }

  private async waitForShim(
    base: string,
    token: string,
    timeoutMs: number,
    containerId?: string | null,
    notice?: NoticeFn,
  ): Promise<void> {
    const client = this.shimClient(base, token);
    const deadline = Date.now() + timeoutMs;
    const reported: string[] = [];
    let nextLogPoll = 0;
    while (Date.now() < deadline) {
      if (await client.status()) return;
      if (containerId && notice && Date.now() >= nextLogPoll) {
        nextLogPoll = Date.now() + SHIM_LOG_POLL_MS;
        await this.reportContainerProgress(containerId, notice, reported);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    // The bare timeout says nothing actionable; the container's own output does.
    const diag = containerId ? await docker.containerDiagnostics(containerId) : '';
    throw new Error(
      `Der Agent-Container ist nicht gestartet (keine Antwort nach ${Math.round(timeoutMs / 1000)}s).` +
        (diag ? `\n${diag}` : ''),
    );
  }

  /**
   * Send the container log lines that appeared since the last poll as
   * 'shim-start' progress (`reported` carries the window across calls).
   * Best effort by contract: a start must never fail because of its progress
   * display, so every failure is swallowed.
   */
  private async reportContainerProgress(id: string, notice: NoticeFn, reported: string[]): Promise<void> {
    try {
      const tail = splitLogLines(await docker.containerLogTail(id, LOG_TAIL_LINES));
      if (tail.length === 0) return;
      const fresh = newTailLines(reported, tail);
      reported.splice(0, reported.length, ...tail);
      if (fresh.length === 0) return;
      notice(shimProgressMessage(fresh), { phase: 'shim-start', detail: detailFrom(fresh) });
    } catch {
      /* no logs (yet) */
    }
  }

  /**
   * (Re)build the shim event stream for a session.
   *
   * A fresh container starts its event sequence at 0, so the dedup baseline is
   * reset with it. `resumeCursor` is for reconnecting to a shim that kept
   * running (an orchestrator redeploy): the highest seq already stored seeds
   * both the client's Last-Event-ID and the dedup baseline, so the events
   * emitted during the gap are replayed and land exactly once.
   */
  private connectEvents(id: string, base: string, token: string, resumeCursor = false): void {
    this.clients.get(id)?.stop();
    const client = this.shimClient(base, token);
    if (resumeCursor) {
      const seq = this.store.lastEventSeq(id);
      if (seq > 0) {
        client.seedEventCursor(seq);
        this.lastPersistedSeq.set(id, seq);
      } else {
        this.lastPersistedSeq.delete(id);
      }
    } else {
      this.lastPersistedSeq.delete(id);
    }
    this.clients.set(id, client);
    client.startEvents((ev) => this.onEvent(id, ev));
  }

  /**
   * Single write path into the stored timeline (noise never reaches the table).
   * Deduplicated by the event's `seq`: a replayed event (same seq the shim
   * already sent before a reconnect) is dropped instead of appended a second
   * time. Events without a seq (older shim, link agent) are always written.
   */
  private persistEvent(sessionId: string, ev: AgentEvent): void {
    if (!isHistoryEvent(ev)) return;
    if (typeof ev.seq === 'number') {
      const last = this.lastPersistedSeq.get(sessionId);
      if (last !== undefined && ev.seq <= last) return;
      this.lastPersistedSeq.set(sessionId, last === undefined ? ev.seq : Math.max(last, ev.seq));
    }
    this.store.appendEvent(sessionId, ev.type, JSON.stringify(ev));
  }

  private onEvent(sessionId: string, ev: AgentEvent): void {
    this.persistEvent(sessionId, ev);
    this.store.touchSession(sessionId);
    this.broadcast({ type: 'session.event', sessionId, event: ev });
    if (ev.type === 'status' && ev.sessionRef) this.store.setSessionRef(sessionId, ev.sessionRef);
    else if (ev.type === 'permission.request')
      void this.notifyPermission(sessionId, ev.permissionId, ev.title);
    else if (ev.type === 'turn.completed' || ev.type === 'turn.failed') {
      // Close the per-turn resource from the shim's own terminal signal: the
      // in-flight turn reaches 'completed' or 'failed' (carrying the shim's
      // error as the reason) so a reconnecting app reads its fate instead of
      // guessing it from the stream.
      if (ev.type === 'turn.completed') this.finishTurn(sessionId, 'completed');
      else this.finishTurn(sessionId, 'failed', { message: ev.error, stage: 'agent' });
      if (this.store.getSession(sessionId)?.status === 'running') this.setStatus(sessionId, 'idle');
    } else if (ev.type === 'pushed' && ev.prUrl) this.store.setPrUrl(sessionId, ev.prUrl);
  }

  private async notifyPermission(sessionId: string, permissionId: string, title: string): Promise<void> {
    const tokens = this.store.listFcmTokens(TENANT);
    if (tokens.length === 0) return;
    await sendPush(tokens, {
      sessionId,
      eventType: 'permission.request',
      title: 'Permission required',
      body: title,
      permissionId,
    }).catch(() => {});
  }

  private emitEvent(sessionId: string, ev: AgentEvent): void {
    this.persistEvent(sessionId, ev);
    this.broadcast({ type: 'session.event', sessionId, event: ev });
  }

  /* ------------------------------------------------------------------ */
  /* Per-turn lifecycle (KILO-CLOUD-ANALYSE.md P1)                       */
  /* ------------------------------------------------------------------ */

  private toTurnInfo(row: TurnRow): TurnInfo {
    let reason: TurnFailureReason | undefined;
    if (row.reason) {
      try {
        reason = JSON.parse(row.reason) as TurnFailureReason;
      } catch {
        reason = { message: row.reason };
      }
    }
    return {
      turnId: row.id,
      sessionId: row.session_id,
      ...(row.message_id ? { messageId: row.message_id } : {}),
      state: row.state as TurnInfo['state'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(reason ? { reason } : {}),
    };
  }

  /** Push a turn transition to every device (the live half of the turn resource). */
  private broadcastTurn(row: TurnRow): void {
    this.broadcast({ type: 'turn.status', sessionId: row.session_id, turn: this.toTurnInfo(row) });
  }

  /**
   * Admit a new turn (state 'queued') and announce it. `messageId` is the
   * app-generated id that admitted it; it is what getTurnByMessageId dedupes on.
   */
  private startTurn(sessionId: string, messageId?: string): TurnRow {
    const now = new Date().toISOString();
    const row: TurnRow = {
      id: randomUUID(),
      session_id: sessionId,
      message_id: messageId ?? null,
      state: 'queued',
      reason: null,
      created_at: now,
      updated_at: now,
    };
    this.store.insertTurn(row);
    this.broadcastTurn(row);
    return row;
  }

  /** Transition a turn to a new state (with a failure reason for 'failed') and announce it. */
  private setTurnState(turnId: string, state: TurnInfo['state'], reason?: TurnFailureReason): void {
    this.store.updateTurnState(turnId, state, reason ? JSON.stringify(reason) : null);
    const row = this.store.getTurn(turnId);
    if (row) this.broadcastTurn(row);
  }

  /**
   * Move a session's current (queued/running) turn to a terminal state, if it
   * has one. Used when a terminal signal arrives without a turn id of its own:
   * a shim `turn.completed`/`.failed`, an abort, or a restart that dropped the
   * turn. A no-op when nothing is in flight (e.g. a stray completed event).
   */
  private finishTurn(sessionId: string, state: 'completed' | 'failed' | 'interrupted', reason?: TurnFailureReason): void {
    const active = this.store.latestActiveTurn(sessionId);
    if (!active) return;
    this.setTurnState(active.id, state, reason);
  }

  /** Turns of a session, oldest first (see Store.listTurns). */
  turns(id: string, limit?: number): TurnInfo[] {
    this.requireSession(id);
    return this.store.listTurns(id, clampTurnLimit(limit)).map((r) => this.toTurnInfo(r));
  }

  private setStatus(id: string, status: SessionStatus): void {
    this.store.updateSessionStatus(id, status);
    this.broadcastStatus(id, status);
  }

  private broadcastStatus(id: string, status: SessionStatus): void {
    const row = this.store.getSession(id);
    if (!row) return;
    this.broadcast({ type: 'session.status', sessionId: id, status, session: this.toInfo(row) });
  }

  private requireSession(id: string): SessionRow {
    const row = this.store.getSession(id);
    if (!row) throw new Error('session not found');
    return row;
  }

  private client(id: string): ShimClient {
    const row = this.requireSession(id);
    if (!row.shim_token) throw new Error('session not provisioned');
    return this.clients.get(id) ?? this.shimClient(this.shimBase(id), row.shim_token);
  }

  /**
   * Every shim request goes through here: `null` means the shim never answered,
   * which after a redeploy simply means the new orchestrator container hangs on
   * no session network any more. Re-attach it (and the event stream that died
   * with the old attachment) once and retry before reporting a failure.
   */
  private async withShim<T>(id: string, call: (c: ShimClient) => Promise<T | null>): Promise<T | null> {
    const first = await call(this.client(id));
    if (first !== null) return first;
    const row = this.store.getSession(id);
    if (!row || !row.shim_token) return null;
    const failure = await docker.attachOrchestratorTo(row);
    if (failure !== null) {
      console.warn(`[sessions] re-attach failed for ${id.slice(0, 8)}: ${failure}`);
      return null;
    }
    // Do NOT tear the event stream down here. A live client has its own
    // reconnect loop that recovers over the freshly re-attached network and
    // replays what it missed via Last-Event-ID; recreating it on every null
    // (the old behaviour) reset that cursor mid-turn and dropped events - the
    // aggravating half of the event-loss finding. Only stand a stream up when
    // there is none, resuming its cursor from the stored history.
    if (!this.clients.has(id)) {
      this.connectEvents(id, this.shimBase(id, row.shim_endpoint), row.shim_token, true);
    }
    return await call(this.client(id));
  }

  /**
   * Message for a shim that stayed unreachable even after the re-attach. The
   * container's own state and log say what a bare "request failed" never could;
   * containerDiagnostics masks token-shaped words in that log.
   */
  private async unreachableMessage(id: string): Promise<string> {
    const row = this.store.getSession(id);
    const diag = row?.container_id ? await docker.containerDiagnostics(row.container_id) : '';
    return diag
      ? `Der Agent-Container ist nicht erreichbar.\n${diag}`
      : 'Der Agent-Container ist nicht erreichbar und liefert keine Diagnose – Session neu starten.';
  }

  private async linkCall(
    row: SessionRow,
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ): Promise<{ ok: true; body?: unknown } | { ok: false; error: string }> {
    if (!this.linkTransport || !row.link_id) return { ok: false, error: 'link not connected' };
    if (!this.linkTransport.isConnected(row.link_id)) return { ok: false, error: 'link agent disconnected' };
    const res = await this.linkTransport.call(row.link_id, path, method, body);
    if (!res) return { ok: false, error: 'link call timed out' };
    if (res.status < 200 || res.status >= 300) {
      const bodyErr = res.body as { error?: string } | undefined;
      return { ok: false, error: bodyErr?.error ?? `link call failed (HTTP ${res.status})` };
    }
    return { ok: true, body: res.body };
  }

  /**
   * Status-Gate für Prompts. Eine Session, die noch startet, hat schon einen
   * shim_token, aber noch keinen antwortenden Shim: ein Prompt in diesem
   * Fenster (zweites Gerät kennt die Session aus dem 'creating'-Broadcast)
   * setzte 'running', lief in den Transport-Timeout, meldete 'error' - und die
   * weiterlaufende Provisionierung setzte Sekunden später 'idle'. Die App sah
   * creating → running → error(fatal) → idle für eine gesunde Session.
   *
   * Eine gestoppte Session hat gar keinen laufenden Container; sie muss erst
   * fortgesetzt werden. 'running' bleibt bewusst erlaubt: mehrere Turns
   * hintereinander sind Sache des Shims, nicht des Orchestrators.
   */
  private assertPromptable(row: SessionRow): void {
    if (row.status === 'creating') {
      throw new Error('Die Session startet noch – bitte warten, bis der Agent bereit ist.');
    }
    if (row.status === 'stopped') {
      throw new Error('Die Session ist gestoppt – bitte zuerst fortsetzen.');
    }
  }

  /**
   * Send a prompt, admitting exactly one turn per app-generated `messageId`
   * (KILO-CLOUD-ANALYSE.md P1). The messageId is stable across a resend, so a
   * prompt the app repeats after an ambiguous admission (a radio hole swallowed
   * the ack) is recognised as the same turn and is NOT run a second time - no
   * duplicate agent turn on flaky mobile links. A prompt without a messageId
   * (older client) keeps the old behaviour, just without dedup.
   */
  async prompt(id: string, text: string, mode?: AgentMode, messageId?: string): Promise<void> {
    const row = this.requireSession(id);
    this.assertPromptable(row);
    // Idempotent admission: the same messageId, seen again, is the resend of an
    // already-accepted turn. Do nothing but let the caller re-ack it - starting
    // a second agent turn is exactly the failure this rule exists to prevent.
    if (messageId && this.store.getTurnByMessageId(id, messageId) !== undefined) return;
    const body: PromptRequest = { ...buildPromptBody(row, text, mode), ...(messageId ? { messageId } : {}) };
    const turn = this.startTurn(id, messageId);
    // The prompt itself, so a reloaded timeline shows the user's own message:
    // no shim reports it back, and without this line the history would start
    // at the agent's answer. Stored only, never broadcast - the sending client
    // already has the message on screen and would draw it twice.
    this.persistEvent(id, { type: 'message.completed', role: 'user', text });
    if (row.link_id) {
      const res = await this.linkCall(row, '/prompt', 'POST', body);
      if (!res.ok) {
        this.setTurnState(turn.id, 'failed', { message: res.error, stage: 'transport', retryable: true });
        this.emitEvent(id, { type: 'error', message: res.error, fatal: true });
        throw new Error(res.error);
      }
      this.setTurnState(turn.id, 'running');
      this.setStatus(id, 'running');
      return;
    }
    if (!row.shim_token) {
      // before any status change; the turn was already admitted, so mark it
      this.setTurnState(turn.id, 'failed', { message: 'session not provisioned', stage: 'provision' });
      throw new Error('session not provisioned');
    }
    this.setStatus(id, 'running');
    const res = await this.withShim(id, (c) => c.prompt(body));
    if (!res || !res.ok) {
      const message = res && !res.ok ? res.error : await this.unreachableMessage(id);
      this.setTurnState(turn.id, 'failed', { message, stage: 'transport', retryable: true });
      this.setStatus(id, 'error');
      this.emitEvent(id, { type: 'error', message, fatal: true });
      return;
    }
    this.setTurnState(turn.id, 'running');
  }

  /**
   * Persist switchable session settings. The next prompt carries them to the
   * shim; the updated session is broadcast to every device as `session.status`.
   *
   * A harness switch (`adapter`) is validated and persisted synchronously too,
   * but its container work is handed back as `reprovision`: the caller acks the
   * request first, because the new agent's image may still have to be built
   * (minutes on first use).
   */
  updateSession(msg: UpdateMsg): { session: SessionInfo; reprovision: (() => Promise<void>) | null } {
    const row = this.requireSession(msg.sessionId);
    if (msg.mode !== undefined && !isAgentMode(msg.mode)) {
      throw new Error(`invalid mode "${String(msg.mode)}"`);
    }
    if (msg.model !== undefined && typeof msg.model !== 'string') {
      throw new Error('model must be a string');
    }
    if (msg.reasoningEffort !== undefined && !isReasoningEffort(msg.reasoningEffort)) {
      throw new Error(`invalid reasoningEffort "${String(msg.reasoningEffort)}"`);
    }
    // null => no harness change (also for an update that names the current one)
    const nextAdapter = msg.adapter !== undefined && msg.adapter !== row.adapter ? msg.adapter : null;
    if (nextAdapter !== null) this.assertAdapterSwitchable(row, nextAdapter);
    this.store.updateSessionSettings(row.id, {
      ...(msg.mode !== undefined ? { mode: msg.mode } : {}),
      ...(msg.model !== undefined ? { model: msg.model.trim() } : {}),
      ...(msg.reasoningEffort !== undefined ? { reasoningEffort: msg.reasoningEffort } : {}),
      ...(nextAdapter !== null
        ? {
            adapter: nextAdapter,
            provider: defaultProviderFor(nextAdapter),
            clearSessionRef: true,
            // harness-bound settings reset unless this very update replaces them
            ...(msg.model === undefined ? { model: '' } : {}),
            ...(msg.reasoningEffort === undefined ? { reasoningEffort: '' } : {}),
          }
        : {}),
    });
    if (nextAdapter !== null) {
      this.store.updateSessionStatus(row.id, 'creating');
      this.emitEvent(row.id, {
        type: 'notice',
        message: `Agent gewechselt: ${row.adapter} → ${nextAdapter}. Der neue Agent startet frisch auf dem aktuellen Code-Stand.`,
      });
    }
    const updated = this.requireSession(row.id);
    const info = this.toInfo(updated);
    this.broadcast({
      type: 'session.status',
      sessionId: info.id,
      status: info.status,
      session: info,
    });
    return {
      session: info,
      reprovision: nextAdapter !== null ? () => this.reprovisionAdapter(row.id) : null,
    };
  }

  /** Preconditions of a harness switch; throws with the reason for the app. */
  private assertAdapterSwitchable(row: SessionRow, adapter: string): void {
    if (!getAdapter(adapter)) throw new Error(`unbekannter Adapter "${adapter}"`);
    if (row.link_id) {
      throw new Error('Agent-Wechsel ist für Link-Sessions nicht möglich – den Agenten auf dem Host neu starten.');
    }
    if (!config.dockerEnabled) {
      throw new Error('Agent-Wechsel benötigt Docker – auf diesem Server ist Docker deaktiviert.');
    }
    if (!row.volume_name || !row.shim_token) {
      throw new Error('Agent-Wechsel benötigt eine provisionierte Session.');
    }
    if (row.status !== 'idle' && row.status !== 'stopped' && row.status !== 'error') {
      throw new Error(`Agent-Wechsel im Status "${row.status}" nicht möglich – bitte warten oder Turn abbrechen.`);
    }
  }

  /**
   * Recreate the session container for the newly selected adapter on the
   * existing volume: the repo checkout and the session branch stay, only the
   * harness is exchanged (the shims clone only into an empty /work).
   */
  private async reprovisionAdapter(id: string): Promise<void> {
    const notice = this.noticeFor(id);
    const gen = this.nextGeneration(id);
    let cid: string | null = null;
    try {
      const row = this.requireSession(id);
      if (!row.shim_token || !row.volume_name) throw new Error('Session ist nicht provisioniert.');
      const repo = this.store.getRepo(row.repo_id);
      if (!repo) throw new Error('repo missing');
      this.clients.get(id)?.stop();
      this.clients.delete(id);
      if (row.container_id) {
        await docker.stopContainer(row.container_id);
        await docker.removeContainer(row.container_id); // volume survives on purpose
      }
      await docker.ensureNetwork();
      await this.checkpoint(id, gen);
      const env = this.buildEnv(row, repo, row.shim_token, repo.default_branch);
      cid = await docker.createSessionContainer(row, env, notice);
      await this.checkpoint(id, gen, cid);
      const pat = this.githubPatFor(row);
      if (pat) await docker.injectCredsFile(cid, { githubPat: pat });
      await this.checkpoint(id, gen, cid);
      // shim_token is already stored (the session keeps it across the switch),
      // so only the container id has to be recorded before the start - see
      // provision(): a container the row does not know cannot be cleaned up.
      this.store.setContainer(id, cid);
      notice('Container startet', { phase: 'container-start' });
      if (!(await docker.startContainer(cid))) throw new Error('failed to start session container');
      await this.checkpoint(id, gen, cid);
      const endpoint = await docker.shimEndpoint(cid, id);
      await this.checkpoint(id, gen, cid);
      this.store.setShimEndpoint(id, endpoint);
      const base = this.shimBase(id, endpoint);
      await this.waitForShim(base, row.shim_token, 60_000, cid, notice);
      await this.checkpoint(id, gen, cid);
      notice('Bereit', { phase: 'ready' });
      this.connectEvents(id, base, row.shim_token);
      this.setStatus(id, 'idle');
    } catch (err) {
      if (err instanceof LifecycleAborted) return;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[sessions] adapter switch failed for ${id.slice(0, 8)}: ${message}`);
      await this.stopFailedContainer(id, cid);
      this.store.updateSessionStatus(id, 'error');
      this.emitEvent(id, { type: 'error', message, fatal: true });
      this.broadcastStatus(id, 'error');
    }
  }

  /** Model catalog of the session's shim; unsupported/unreachable -> []. */
  async models(id: string): Promise<ModelInfo[]> {
    const row = this.requireSession(id);
    if (row.link_id) {
      const res = await this.linkCall(row, '/models', 'GET');
      if (!res.ok) return [];
      return normalizeModels(res.body);
    }
    if (!row.shim_token) return [];
    return (await this.withShim(id, (c) => c.models())) ?? [];
  }

  async permission(id: string, permissionId: string, decision: PermissionDecision): Promise<void> {
    const row = this.requireSession(id);
    if (row.link_id) {
      const res = await this.linkCall(row, `/permissions/${encodeURIComponent(permissionId)}`, 'POST', { response: decision });
      if (!res.ok) throw new Error(res.error);
      return;
    }
    const res = await this.withShim(id, (c) => c.permission(permissionId, decision));
    if (!res?.ok) throw new Error(res && !res.ok ? res.error : await this.unreachableMessage(id));
  }

  async abort(id: string): Promise<void> {
    const row = this.requireSession(id);
    if (row.link_id) {
      const res = await this.linkCall(row, '/abort', 'POST');
      if (!res.ok) throw new Error(res.error);
      this.finishTurn(id, 'interrupted');
      return;
    }
    const res = await this.withShim(id, (c) => c.abort());
    if (!res?.ok) throw new Error(res && !res.ok ? res.error : await this.unreachableMessage(id));
    // The turn was cut short from outside; its terminal state is 'interrupted',
    // not 'completed' - the app can tell "I stopped it" from "it finished".
    this.finishTurn(id, 'interrupted');
  }

  async diff(id: string): Promise<DiffEntry[]> {
    const row = this.requireSession(id);
    if (row.link_id) {
      const res = await this.linkCall(row, '/diff', 'GET');
      if (!res.ok) throw new Error(res.error);
      return Array.isArray(res.body) ? (res.body as DiffEntry[]) : [];
    }
    const diff = await this.withShim(id, (c) => c.diff());
    if (!diff) throw new Error(await this.unreachableMessage(id));
    return diff;
  }

  async stopSession(id: string): Promise<void> {
    const row = this.requireSession(id);
    // Invalidates a start that may still be running: without this a stop during
    // 'creating' was overwritten with 'idle' when provision() finished, and the
    // explicitly stopped container ran on.
    this.nextGeneration(id);
    if (row.link_id) {
      this.linkTransport?.bye(row.link_id);
      this.setStatus(id, 'stopped');
      return;
    }
    this.clients.get(id)?.stop();
    this.clients.delete(id);
    if (row.container_id) await docker.stopContainer(row.container_id);
    this.setStatus(id, 'stopped');
  }

  /**
   * Fortsetzen einer Session. Re-Entrancy-Schutz: ein zweiter Aufruf (Doppel-Tap,
   * zweites Gerät) wartet auf den laufenden Resume, statt einen zweiten
   * Container zu erzeugen - Session-Container tragen keinen festen Namen, der
   * Verlierer des Rennens würde also unbemerkt weiterlaufen.
   */
  async resumeSession(id: string): Promise<void> {
    const running = this.resuming.get(id);
    if (running) return running;
    const run = (async () => {
      try {
        await this.runResume(id);
      } finally {
        this.resuming.delete(id);
      }
    })();
    this.resuming.set(id, run);
    return run;
  }

  private async runResume(id: string): Promise<void> {
    const row = this.requireSession(id);
    if (row.link_id) {
      if (!this.linkTransport?.isConnected(row.link_id)) {
        throw new Error('link agent not connected - restart it on the agent host');
      }
      this.setStatus(id, 'idle');
      return;
    }
    if (!config.dockerEnabled) throw new Error('docker is disabled on this server');
    if (!row.shim_token || !row.volume_name) {
      // Never fully provisioned (the orchestrator died during the first start,
      // see reconcile): the session is built from scratch on its own id instead
      // of being refused forever with 'session not provisioned'.
      const repo = this.store.getRepo(row.repo_id);
      if (!repo) throw new Error('repo missing');
      this.setStatus(id, 'creating');
      await this.provision(row, repo, repo.default_branch);
      return;
    }
    const gen = this.nextGeneration(id);
    const notice = this.noticeFor(id);
    let created: string | null = null;
    try {
      // The session's own network, not just the shared one: an 'allowlist'/
      // 'isolated' container is reachable only through pocketagent-s-<id>, and a
      // resume after a redeploy starts out attached to neither.
      const attachFailure = await docker.attachOrchestratorTo(row);
      if (attachFailure !== null) throw new Error(attachFailure);
      await this.checkpoint(id, gen);
      let cid = row.container_id;
      notice('Container startet', { phase: 'container-start' });
      let started = cid ? await docker.startContainer(cid) : false;
      await this.checkpoint(id, gen);
      if (!started) {
        const repo = this.store.getRepo(row.repo_id);
        if (!repo) throw new Error('repo missing');
        cid = await docker.createSessionContainer(
          row,
          this.buildEnv(row, repo, row.shim_token, repo.default_branch),
          notice,
        );
        created = cid;
        await this.checkpoint(id, gen, created);
        const pat = this.githubPatFor(row);
        if (pat) await docker.injectCredsFile(cid, { githubPat: pat });
        await this.checkpoint(id, gen, created);
        // recorded before the start, like in provision()
        this.store.setContainer(id, cid);
        started = await docker.startContainer(cid);
        if (!started) throw new Error('failed to start session container');
        await this.checkpoint(id, gen, created);
      }
      if (cid && cid !== row.container_id) this.store.setContainer(id, cid);
      // remote mode assigns a new published port per (re)created container
      const endpoint = cid ? await docker.shimEndpoint(cid, id) : row.shim_endpoint;
      await this.checkpoint(id, gen, created);
      this.store.setShimEndpoint(id, endpoint);
      const base = this.shimBase(id, endpoint);
      await this.waitForShim(base, row.shim_token, 60_000, cid, notice);
      await this.checkpoint(id, gen, created);
      if (row.session_ref) {
        const res = await this.shimClient(base, row.shim_token).resume(row.session_ref);
        if (!res?.ok) throw new Error(res && !res.ok ? res.error : 'resume failed');
        await this.checkpoint(id, gen, created);
      }
      notice('Bereit', { phase: 'ready' });
      this.connectEvents(id, base, row.shim_token);
      this.setStatus(id, 'idle');
    } catch (err) {
      if (err instanceof LifecycleAborted) return; // stop/delete won, nothing to report
      await this.stopFailedContainer(id, created);
      throw err;
    }
  }

  async push(id: string): Promise<void> {
    const row = this.requireSession(id);
    if (row.link_id) {
      throw new Error('tap-push is not supported for linked sessions (yolo mode auto-pushes from the agent host)');
    }
    // The push container talks to github through the same egress proxy, and its
    // proxy credentials are the session's shim_token: without one it would be
    // started with an unauthenticated proxy URL (the only path that could).
    if (!row.volume_name || !row.shim_token) throw new Error('session not provisioned');
    const repo = this.store.getRepo(row.repo_id);
    if (!repo) throw new Error('repo missing');
    const env = this.buildEnv(row, repo, row.shim_token, repo.default_branch);
    const pat = this.githubPatFor(row);
    // Egress-Fenster für den Wegwerf-Container: er trägt das Label und den
    // Token der Session, deren Status ('stopped' nach reapIdle) sonst jeden
    // seiner git-Requests am Proxy abweisen würde.
    this.pushing.add(id);
    let ok: boolean;
    try {
      ok = await docker.oneShotPush(row, env, pat ? { githubPat: pat } : undefined, this.noticeFor(id));
    } finally {
      this.pushing.delete(id);
      await docker.refreshSessionPeers().catch(() => {});
    }
    if (!ok) throw new Error('push failed');
    this.emitEvent(id, { type: 'pushed', branch: row.branch, auto: false });
  }

  /** Stored timeline of a session, oldest first (see Store.listSessionEvents). */
  sessionEvents(id: string, limit?: number): AgentEvent[] {
    this.requireSession(id);
    return this.store.listSessionEvents(id, clampEventLimit(limit));
  }

  /**
   * Rename a session. An empty (or all-whitespace) title clears the column,
   * which is how a client asks for the derived name back. The updated session
   * goes to every device as `session.status`, like every other session change.
   */
  renameSession(id: string, title: unknown): SessionInfo {
    this.requireSession(id);
    if (typeof title !== 'string') throw new Error('title must be a string');
    this.store.setSessionTitle(id, sanitizeSessionTitle(title));
    return this.broadcastSession(id);
  }

  /**
   * Archive/unarchive a session. Archiving stops the container: an archived
   * session is one the user is done with for now, and a stopped container frees
   * RAM and CPU. Its volume stays, so `session.resume` picks the work up
   * exactly where it was - archiving is a view decision plus the resource
   * saving, never data loss. Link sessions are left running: their agent
   * process lives on the user's own machine and a 'bye' would shut it down,
   * which a list gesture must not do.
   *
   * Nothing else changes: idle-stop and GC keep treating the row as before (an
   * archived session is already stopped, so reapIdle skips it anyway, and GC
   * still removes it once it is old enough - archiving is not "keep forever").
   */
  async archiveSession(id: string, archived: unknown): Promise<SessionInfo> {
    const row = this.requireSession(id);
    if (typeof archived !== 'boolean') throw new Error('archived must be a boolean');
    this.store.setSessionArchived(id, archived);
    if (archived && !row.link_id && row.status !== 'stopped') {
      await this.stopSession(id).catch((e: unknown) => {
        console.warn(`[sessions] archive: stopping ${id.slice(0, 8)} failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    return this.broadcastSession(id);
  }

  /** Send the session's current state to every device and return it. */
  private broadcastSession(id: string): SessionInfo {
    const info = this.toInfo(this.requireSession(id));
    this.broadcast({ type: 'session.status', sessionId: info.id, status: info.status, session: info });
    return info;
  }

  async deleteSession(id: string): Promise<void> {
    const row = this.store.getSession(id);
    // A start still running for this session has to notice that its session is
    // gone: its next checkpoint aborts and removes the container it created,
    // which the deleted row could not have named any more.
    this.nextGeneration(id);
    this.clients.get(id)?.stop();
    this.clients.delete(id);
    if (row?.link_id) {
      this.linkTransport?.bye(row.link_id);
      this.store.deleteSession(id);
      this.generations.delete(id);
      return;
    }
    if (row) {
      if (row.container_id) {
        await docker.stopContainer(row.container_id);
        await docker.removeContainer(row.container_id);
      }
      // The volume name is derived from the session id (provision), so it is
      // also removable for a session deleted while it was still being created -
      // the row does not know the name yet at that point.
      await docker.removeVolume(row.volume_name ?? `pocketagent-sess-${row.id}`);
      await docker.removeSessionNetwork(row.id);
      // The egress proxy authorizes by source IP from a cached container list;
      // without this refresh the deleted container's address stays allowed
      // until the cache expires by itself.
      await docker.refreshSessionPeers().catch(() => {});
    }
    // deletes the stored events with the row (see Store.deleteSession)
    this.store.deleteSession(id);
    // A start that is still running aborts on the missing row alone (see
    // checkpoint), so the counter may go with the session.
    this.generations.delete(id);
    this.lastPersistedSeq.delete(id);
  }

  listSessions(tenant: string = TENANT): SessionInfo[] {
    return this.store.listSessions(tenant).map((r) => this.toInfo(r));
  }

  toInfo(row: SessionRow): SessionInfo {
    return {
      id: row.id,
      repoId: row.repo_id,
      repoFullName: row.repo_full_name ?? undefined,
      adapter: row.adapter as AdapterId,
      provider: row.provider,
      model: row.model,
      mode: row.mode as AgentMode,
      status: row.status as SessionStatus,
      branch: row.branch,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      ...(row.pr_url ? { prUrl: row.pr_url } : {}),
      ...(isNetworkPolicy(row.network_policy) ? { networkPolicy: row.network_policy } : {}),
      ...(row.reasoning_effort ? { reasoningEffort: row.reasoning_effort } : {}),
      // both additive: an older app ignores them, and "absent" is the default
      ...(row.title ? { title: row.title } : {}),
      ...(row.archived ? { archived: true } : {}),
      ...(row.link_id ? { linked: true } : {}),
    };
  }

  async stats(): Promise<{
    sessionsActive: number;
    sessionsTotal: number;
    containersRunning: number;
    uptimeSec: number;
    versions: Record<string, string>;
  }> {
    const rows = this.store.listSessions(TENANT);
    const active = rows.filter((r) => r.status === 'running' || r.status === 'idle').length;
    const running = await docker.listRunning();
    return {
      sessionsActive: active,
      sessionsTotal: rows.length,
      containersRunning: running ?? active,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      versions: { server: SERVER_VERSION },
    };
  }

  /**
   * A redeploy replaces the orchestrator container while the session
   * containers keep running: the new one is attached to no session network and
   * holds no event stream, so every request to a live session fails. Rebuild
   * that state once at startup and bring the rows in line with what the daemon
   * actually still has. Never blocks or fails the server start - each session
   * is guarded on its own.
   */
  async reconcile(tenant: string = TENANT): Promise<void> {
    if (!config.dockerEnabled) return;
    // The still running containers keep talking to the egress proxy while this
    // runs, so their IPs have to be known before the first of those requests.
    await docker.refreshSessionPeers().catch(() => {});
    for (const row of this.store.listSessions(tenant)) {
      if (row.link_id) continue; // link agents redial by themselves
      if (!row.container_id) {
        this.recoverUnprovisioned(row);
        continue;
      }
      if (row.status === 'stopped' || row.status === 'error') continue; // resumed explicitly
      try {
        await this.reconcileSession(row);
      } catch (e) {
        console.error(`[sessions] reconcile failed for ${row.id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await this.reapOrphanContainers();
  }

  /**
   * Eine Zeile ohne Container-Id, die trotzdem 'creating'/'running' meldet: der
   * Orchestrator ist während der Provisionierung gestorben, bevor der Container
   * überhaupt angelegt wurde (der erste Image-Build dauert Minuten). Ohne diese
   * Behandlung zeigt die App für immer 'creating' - reconcileSession sieht die
   * Zeile mangels Container gar nicht.
   *
   * Der erholbare Zustand ist 'error': `session.resume` baut eine nie fertig
   * provisionierte Session danach von vorn auf (siehe runResume).
   */
  private recoverUnprovisioned(row: SessionRow): void {
    if (row.status !== 'creating' && row.status !== 'running') return;
    this.emitEvent(row.id, {
      type: 'error',
      message:
        'Der Start dieser Session wurde durch einen Server-Neustart unterbrochen, bevor der Agent-Container existierte. ' +
        'Die Session kann neu gestartet werden.',
      fatal: true,
    });
    this.setStatus(row.id, 'error');
    console.log(`[sessions] recovered ${row.id.slice(0, 8)} from an interrupted start (${row.status} -> error)`);
  }

  /**
   * Label-basierter Orphan-Reaper beim Serverstart: Container mit dem Label
   * `pocketagent.session`, zu denen die DB nichts (mehr) sagt, werden gestoppt
   * und entfernt. Das fängt genau die Container ein, die kein anderer Pfad je
   * findet - reapIdle, gc und reconcile arbeiten alle über `row.container_id`:
   * ein Start, der vor dem Persistieren der Id abstürzte oder abgebrochen
   * wurde; der Verlierer eines Resume-Rennens; ein liegengebliebener
   * Push-Container.
   *
   * Verwaist ist ein Container, dessen Session-Label auf keine Zeile zeigt oder
   * dessen Zeile einen anderen Container führt. Container, die *nach* dem Start
   * dieses Prozesses entstanden sind, bleiben unangetastet - sie gehören einem
   * laufenden Start. Antwortet der Daemon nicht, passiert gar nichts.
   */
  async reapOrphanContainers(): Promise<number> {
    if (!config.dockerEnabled) return 0;
    const containers = await docker.listSessionContainers();
    if (containers === null) return 0;
    let removed = 0;
    for (const c of containers) {
      if (c.createdMs >= this.startedAt) continue;
      const row = c.sessionId ? this.store.getSession(c.sessionId) : undefined;
      if (row && row.container_id === c.id) continue;
      await docker.stopContainer(c.id).catch(() => {});
      await docker.removeContainer(c.id).catch(() => {});
      removed++;
      console.warn(
        `[sessions] orphan container ${c.id.slice(0, 12)} removed (session ${c.sessionId ? c.sessionId.slice(0, 8) : '?'}: ${
          row ? 'row points at another container' : 'no session row'
        })`,
      );
    }
    if (removed > 0) await docker.refreshSessionPeers().catch(() => {});
    return removed;
  }

  private async reconcileSession(row: SessionRow): Promise<void> {
    const state = await docker.containerState(row.container_id as string);
    if (state === 'unknown') {
      console.warn(`[sessions] reconcile: docker did not answer for ${row.id.slice(0, 8)} - session left as is`);
      return;
    }
    if (state === 'missing') {
      this.emitEvent(row.id, {
        type: 'error',
        message:
          'Der Agent-Container existiert nicht mehr (nach einem Server-Neustart nicht wiedergefunden). ' +
          'Die Session kann mit ihrem Arbeitsstand neu gestartet werden.',
        fatal: true,
      });
      this.setStatus(row.id, 'error');
      return;
    }
    if (state === 'stopped') {
      this.emitEvent(row.id, {
        type: 'notice',
        message: 'Der Agent-Container läuft nicht mehr – die Session wurde als gestoppt markiert und kann fortgesetzt werden.',
      });
      this.setStatus(row.id, 'stopped');
      return;
    }
    const failure = await docker.attachOrchestratorTo(row);
    if (failure !== null) throw new Error(failure);
    if (!row.shim_token) return;
    // The container kept running across the redeploy, so its shim sequence
    // continued: resume the replay cursor from the last stored seq to pick up
    // the events emitted during the restart gap.
    this.connectEvents(row.id, this.shimBase(row.id, row.shim_endpoint), row.shim_token, true);
    // A turn (or a start) that was in flight during the restart is lost: its
    // shim events went nowhere, so the session would stay 'running' forever.
    const interrupted = row.status === 'running' || row.status === 'creating';
    this.emitEvent(row.id, {
      type: 'notice',
      message: interrupted
        ? 'Server wurde neu gestartet – die Verbindung zu diesem Agenten wurde wiederhergestellt. Der laufende Turn wurde dabei abgebrochen.'
        : 'Server wurde neu gestartet – die Verbindung zu diesem Agenten wurde wiederhergestellt.',
    });
    if (interrupted) {
      // Close the dropped turn so the reconnecting app reads 'interrupted'
      // instead of a turn that is forever 'running'.
      this.finishTurn(row.id, 'interrupted', { message: 'Server-Neustart während des Turns', stage: 'restart', retryable: true });
      this.setStatus(row.id, 'idle');
    }
    console.log(`[sessions] reconciled ${row.id.slice(0, 8)} (${row.status} -> ${interrupted ? 'idle' : row.status})`);
  }

  start(): void {
    this.timers.push(
      setInterval(() => void this.reapIdle().catch(() => {}), 60_000),
      setInterval(() => void this.resyncRunningStatuses().catch(() => {}), 60_000),
      setInterval(() => void this.gc().catch(() => {}), 24 * 3_600_000),
      // Gateway-Modus: der Gateway hält die Session-Tabelle nur im Speicher,
      // ein Neustart des Containers verliert sie (no-op ohne Gateway).
      setInterval(() => void docker.syncGatewayEgress().catch(() => {}), 15_000),
    );
  }

  private async reapIdle(): Promise<void> {
    const cutoff = Date.now() - config.idleStopSec * 1000;
    for (const row of this.store.listSessions(TENANT)) {
      if (row.link_id) continue; // linked agents are long-lived, no container cost
      if (
        (row.status === 'running' || row.status === 'idle') &&
        Date.parse(row.last_active_at) < cutoff
      ) {
        await this.stopSession(row.id).catch(() => {});
      }
    }
  }

  /**
   * Backstop gegen eine fälschlich in 'running' hängende Session (die Folge
   * eines verlorenen turn.completed): Wird eine Session als laufend geführt,
   * hat aber seit RESYNC_STALE_MS kein Event mehr geliefert, fragt dieser Lauf
   * den Shim direkt nach seinem busy-Status; meldet der Shim busy:false, wird
   * die Session auf 'idle' korrigiert. Das Sequenz-/Replay-Verfahren verhindert
   * den Event-Verlust bereits an der Wurzel - dieser Resync ist die zweite
   * Sicherung, falls je ein turn.completed doch nicht ankommt.
   *
   * Öffentlich, damit der Lauf testbar ist; regulär feuert ihn nur der Timer.
   * Nur Docker-Sessions mit einem bereits verbundenen Event-Client werden
   * geprüft (kein neuer Netz-Re-Attach im Timer), und die Staleness-Schranke
   * verhindert, dass ein gerade gestarteter Turn - dessen busy-Flag der Shim
   * noch nicht gesetzt hat - vorzeitig auf idle gekippt wird.
   */
  async resyncRunningStatuses(): Promise<void> {
    if (!config.dockerEnabled) return;
    const staleBefore = Date.now() - RESYNC_STALE_MS;
    for (const row of this.store.listSessions(TENANT)) {
      if (row.link_id || row.status !== 'running' || !row.shim_token || !row.container_id) continue;
      if (Date.parse(row.last_active_at) >= staleBefore) continue; // recent event: really busy
      const client = this.clients.get(row.id);
      if (!client) continue; // no live stream to ask; reconcile/resume owns that case
      const status = await client.status().catch(() => null);
      if (!status || status.busy !== false) continue;
      // Re-read under the current state: a turn may have started meanwhile.
      const current = this.store.getSession(row.id);
      if (!current || current.status !== 'running') continue;
      if (Date.parse(current.last_active_at) >= staleBefore) continue;
      // The shim reports not busy, so the turn is over; a lost turn.completed
      // never closed it. Complete the in-flight turn to match the corrected
      // session status.
      this.finishTurn(row.id, 'completed');
      this.setStatus(row.id, 'idle');
      this.emitEvent(row.id, {
        type: 'notice',
        message: 'Turn abgeschlossen – der Status wurde nachträglich korrigiert (kein Abschluss-Event empfangen).',
      });
      console.log(`[sessions] resynced ${row.id.slice(0, 8)} from a stale 'running' to 'idle' (shim reports not busy)`);
    }
  }

  /**
   * Aufräumen alter Sessions (Kriterium: isCollectableSession). Öffentlich,
   * damit der Lauf testbar ist - regulär feuert ihn nur der Timer aus start().
   */
  async gc(): Promise<void> {
    const cutoff = Date.now() - config.gcDays * 86_400_000;
    for (const row of this.store.listSessions(TENANT)) {
      if (!isCollectableSession(row, cutoff)) continue;
      console.log(`[sessions] gc: removing ${row.id.slice(0, 8)} (status=${row.status}, last active ${row.last_active_at})`);
      await this.deleteSession(row.id).catch(() => {});
    }
  }

  shutdown(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    for (const c of this.clients.values()) c.stop();
    this.clients.clear();
  }
}
