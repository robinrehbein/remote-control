import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AdapterId,
  AgentEvent,
  AgentMode,
  ClientMessage,
  DiffEntry,
  ModelInfo,
  NetworkPolicy,
  PermissionDecision,
  PromptRequest,
  ReasoningEffort,
  ServerMessage,
  SessionInfo,
  SessionStatus,
} from '@pocketagent/protocol';
import { SERVER_VERSION, config, isNetworkPolicy } from './config.js';
import type { LinkRow, RepoRow, SessionRow, Store } from './db.js';
import { decrypt } from './vault.js';
import * as docker from './docker.js';
import { getAdapter } from './adapters.js';
import { ShimClient, normalizeModels } from './shim-client.js';
import { sendPush } from './fcm.js';

const TENANT = 'default';

const AGENT_MODES: readonly AgentMode[] = ['yolo', 'auto', 'acceptEdits', 'ask'];
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

export function isAgentMode(v: unknown): v is AgentMode {
  return typeof v === 'string' && (AGENT_MODES as readonly string[]).includes(v);
}

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === 'string' && (REASONING_EFFORTS as readonly string[]).includes(v);
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
  readonly startedAt = Date.now();

  constructor(
    private readonly store: Store,
    private readonly broadcast: (m: ServerMessage) => void,
  ) {}

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

  createSession(msg: CreateMsg, tenant: string = TENANT): SessionRow {
    const repo = this.store.getRepo(msg.repoId);
    if (!repo) throw new Error('repo not found');
    if (!getAdapter(msg.adapter)) throw new Error(`unknown adapter "${msg.adapter}"`);
    if (msg.networkPolicy !== undefined && !isNetworkPolicy(msg.networkPolicy)) {
      throw new Error(`invalid networkPolicy "${String(msg.networkPolicy)}"`);
    }
    const networkPolicy: NetworkPolicy = msg.networkPolicy ?? config.networkPolicyDefault;
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
      created_at: now,
      last_active_at: now,
    };
    this.store.insertSession(row);
    void this.provision(row, repo, msg.branch ?? repo.default_branch);
    return row;
  }

  private async provision(row: SessionRow, repo: RepoRow, baseBranch: string): Promise<void> {
    try {
      if (!config.dockerEnabled) throw new Error('docker is disabled on this server');
      await docker.ensureNetwork();
      const shimToken = randomBytes(24).toString('hex');
      const staged: SessionRow = { ...row, volume_name: `pocketagent-sess-${row.id}` };
      const env = this.buildEnv(staged, repo, shimToken, baseBranch);
      const cid = await docker.createSessionContainer(staged, env);
      if (!cid) throw new Error('failed to create session container');
      if (!(await docker.startContainer(cid))) throw new Error('failed to start session container');
      const endpoint = await docker.shimEndpoint(cid, row.id);
      this.store.setProvisioned(row.id, cid, staged.volume_name as string, shimToken);
      this.store.setShimEndpoint(row.id, endpoint);
      const base = this.shimBase(row.id, endpoint);
      await this.waitForShim(base, shimToken, 60_000);
      this.connectEvents(row.id, base, shimToken);
      this.setStatus(row.id, 'idle');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.updateSessionStatus(row.id, 'error');
      this.emitEvent(row.id, { type: 'error', message, fatal: true });
      this.broadcastStatus(row.id, 'error');
    }
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
    };
    const gh = this.store.getSecretByKind('github', row.tenant_id);
    if (gh) env.GITHUB_PAT = decrypt({ ciphertext: gh.ciphertext, nonce: gh.nonce });
    const setKey = (kind: string, key: string): void => {
      const s = this.store.getSecretByKind(kind, row.tenant_id);
      if (s) env[key] = decrypt({ ciphertext: s.ciphertext, nonce: s.nonce });
    };
    for (const [kind, vars] of Object.entries(desc.credentials ?? {})) {
      for (const v of vars) setKey(kind, v);
    }
    const envVar = desc.providerEnv?.[row.provider];
    if (envVar) setKey(row.provider, envVar);
    return env;
  }

  private async waitForShim(base: string, token: string, timeoutMs: number): Promise<void> {
    const client = this.shimClient(base, token);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await client.status()) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error('shim did not become ready in time');
  }

  private connectEvents(id: string, base: string, token: string): void {
    this.clients.get(id)?.stop();
    const client = this.shimClient(base, token);
    this.clients.set(id, client);
    client.startEvents((ev) => this.onEvent(id, ev));
  }

  private onEvent(sessionId: string, ev: AgentEvent): void {
    this.store.appendEvent(sessionId, ev.type, JSON.stringify(ev));
    this.store.touchSession(sessionId);
    this.broadcast({ type: 'session.event', sessionId, event: ev });
    if (ev.type === 'status' && ev.sessionRef) this.store.setSessionRef(sessionId, ev.sessionRef);
    else if (ev.type === 'permission.request') void this.notifyPermission(sessionId, ev.title);
    else if (ev.type === 'turn.completed' || ev.type === 'turn.failed') {
      if (this.store.getSession(sessionId)?.status === 'running') this.setStatus(sessionId, 'idle');
    } else if (ev.type === 'pushed' && ev.prUrl) this.store.setPrUrl(sessionId, ev.prUrl);
  }

  private async notifyPermission(sessionId: string, title: string): Promise<void> {
    const tokens = this.store.listFcmTokens(TENANT);
    if (tokens.length === 0) return;
    await sendPush(tokens, {
      sessionId,
      eventType: 'permission.request',
      title: 'Permission required',
      body: title,
    }).catch(() => {});
  }

  private emitEvent(sessionId: string, ev: AgentEvent): void {
    this.store.appendEvent(sessionId, ev.type, JSON.stringify(ev));
    this.broadcast({ type: 'session.event', sessionId, event: ev });
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

  async prompt(id: string, text: string, mode?: AgentMode): Promise<void> {
    const row = this.requireSession(id);
    const body = buildPromptBody(row, text, mode);
    if (row.link_id) {
      const res = await this.linkCall(row, '/prompt', 'POST', body);
      if (!res.ok) {
        this.emitEvent(id, { type: 'error', message: res.error, fatal: true });
        throw new Error(res.error);
      }
      this.setStatus(id, 'running');
      return;
    }
    const client = this.client(id);
    this.setStatus(id, 'running');
    const res = await client.prompt(body);
    if (!res || !res.ok) {
      const message = res && !res.ok ? res.error : 'prompt request failed';
      this.setStatus(id, 'error');
      this.emitEvent(id, { type: 'error', message, fatal: true });
    }
  }

  /**
   * Persist switchable session settings. The next prompt carries them to the
   * shim; the updated session is broadcast to every device as `session.status`.
   */
  updateSession(msg: UpdateMsg): SessionInfo {
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
    this.store.updateSessionSettings(row.id, {
      ...(msg.mode !== undefined ? { mode: msg.mode } : {}),
      ...(msg.model !== undefined ? { model: msg.model.trim() } : {}),
      ...(msg.reasoningEffort !== undefined ? { reasoningEffort: msg.reasoningEffort } : {}),
    });
    const updated = this.requireSession(row.id);
    const info = this.toInfo(updated);
    this.broadcast({
      type: 'session.status',
      sessionId: info.id,
      status: info.status,
      session: info,
    });
    return info;
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
    return await this.client(id).models();
  }

  async permission(id: string, permissionId: string, decision: PermissionDecision): Promise<void> {
    const row = this.requireSession(id);
    if (row.link_id) {
      const res = await this.linkCall(row, `/permissions/${encodeURIComponent(permissionId)}`, 'POST', { response: decision });
      if (!res.ok) throw new Error(res.error);
      return;
    }
    const res = await this.client(id).permission(permissionId, decision);
    if (!res?.ok) throw new Error(res && !res.ok ? res.error : 'permission request failed');
  }

  async abort(id: string): Promise<void> {
    const row = this.requireSession(id);
    if (row.link_id) {
      const res = await this.linkCall(row, '/abort', 'POST');
      if (!res.ok) throw new Error(res.error);
      return;
    }
    const res = await this.client(id).abort();
    if (!res?.ok) throw new Error(res && !res.ok ? res.error : 'abort request failed');
  }

  async diff(id: string): Promise<DiffEntry[]> {
    const row = this.requireSession(id);
    if (row.link_id) {
      const res = await this.linkCall(row, '/diff', 'GET');
      if (!res.ok) throw new Error(res.error);
      return Array.isArray(res.body) ? (res.body as DiffEntry[]) : [];
    }
    const diff = await this.client(id).diff();
    if (!diff) throw new Error('diff request failed');
    return diff;
  }

  async stopSession(id: string): Promise<void> {
    const row = this.requireSession(id);
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

  async resumeSession(id: string): Promise<void> {
    const row = this.requireSession(id);
    if (row.link_id) {
      if (!this.linkTransport?.isConnected(row.link_id)) {
        throw new Error('link agent not connected - restart it on the agent host');
      }
      this.setStatus(id, 'idle');
      return;
    }
    if (!row.shim_token || !row.volume_name) throw new Error('session not provisioned');
    if (!config.dockerEnabled) throw new Error('docker is disabled on this server');
    await docker.ensureNetwork();
    let cid = row.container_id;
    let started = cid ? await docker.startContainer(cid) : false;
    if (!started) {
      const repo = this.store.getRepo(row.repo_id);
      if (!repo) throw new Error('repo missing');
      cid = await docker.createSessionContainer(
        row,
        this.buildEnv(row, repo, row.shim_token, repo.default_branch),
      );
      if (!cid) throw new Error('failed to recreate session container');
      started = await docker.startContainer(cid);
      if (!started) throw new Error('failed to start session container');
    }
    if (cid && cid !== row.container_id) this.store.setContainer(id, cid);
    // remote mode assigns a new published port per (re)created container
    const endpoint = cid ? await docker.shimEndpoint(cid, id) : row.shim_endpoint;
    this.store.setShimEndpoint(id, endpoint);
    const base = this.shimBase(id, endpoint);
    await this.waitForShim(base, row.shim_token, 60_000);
    if (row.session_ref) {
      const res = await this.shimClient(base, row.shim_token).resume(row.session_ref);
      if (!res?.ok) throw new Error(res && !res.ok ? res.error : 'resume failed');
    }
    this.connectEvents(id, base, row.shim_token);
    this.setStatus(id, 'idle');
  }

  async push(id: string): Promise<void> {
    const row = this.requireSession(id);
    if (row.link_id) {
      throw new Error('tap-push is not supported for linked sessions (yolo mode auto-pushes from the agent host)');
    }
    if (!row.volume_name) throw new Error('session not provisioned');
    const repo = this.store.getRepo(row.repo_id);
    if (!repo) throw new Error('repo missing');
    const env = this.buildEnv(row, repo, row.shim_token ?? '', repo.default_branch);
    if (!(await docker.oneShotPush(row, env))) throw new Error('push failed');
    this.emitEvent(id, { type: 'pushed', branch: row.branch, auto: false });
  }

  async deleteSession(id: string): Promise<void> {
    const row = this.store.getSession(id);
    this.clients.get(id)?.stop();
    this.clients.delete(id);
    if (row?.link_id) {
      this.linkTransport?.bye(row.link_id);
      this.store.deleteSession(id);
      return;
    }
    if (row) {
      if (row.container_id) {
        await docker.stopContainer(row.container_id);
        await docker.removeContainer(row.container_id);
      }
      if (row.volume_name) await docker.removeVolume(row.volume_name);
      await docker.removeSessionNetwork(row.id);
    }
    this.store.deleteSession(id);
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

  start(): void {
    this.timers.push(
      setInterval(() => void this.reapIdle().catch(() => {}), 60_000),
      setInterval(() => void this.gc().catch(() => {}), 24 * 3_600_000),
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

  private async gc(): Promise<void> {
    const cutoff = Date.now() - config.gcDays * 86_400_000;
    for (const row of this.store.listSessions(TENANT)) {
      if (Date.parse(row.created_at) < cutoff) await this.deleteSession(row.id).catch(() => {});
    }
  }

  shutdown(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    for (const c of this.clients.values()) c.stop();
    this.clients.clear();
  }
}
