import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AdapterId,
  AgentEvent,
  AgentMode,
  ClientMessage,
  DiffEntry,
  PermissionDecision,
  ServerMessage,
  SessionInfo,
  SessionStatus,
} from '@pocketagent/protocol';
import { SERVER_VERSION, config } from './config.js';
import type { RepoRow, SessionRow, Store } from './db.js';
import { decrypt } from './vault.js';
import * as docker from './docker.js';
import { getAdapter } from './adapters.js';
import { ShimClient } from './shim-client.js';
import { sendPush } from './fcm.js';

const TENANT = 'default';

type CreateMsg = Extract<ClientMessage, { type: 'session.create' }>;

export class SessionManager {
  private readonly clients = new Map<string, ShimClient>();
  private readonly timers: NodeJS.Timeout[] = [];
  readonly startedAt = Date.now();

  constructor(
    private readonly store: Store,
    private readonly broadcast: (m: ServerMessage) => void,
  ) {}

  createSession(msg: CreateMsg, tenant: string = TENANT): SessionRow {
    const repo = this.store.getRepo(msg.repoId);
    if (!repo) throw new Error('repo not found');
    if (!getAdapter(msg.adapter)) throw new Error(`unknown adapter "${msg.adapter}"`);
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
      this.store.setProvisioned(row.id, cid, staged.volume_name as string, shimToken);
      await this.waitForShim(row.id, shimToken, 60_000);
      this.connectEvents(row.id, shimToken);
      this.setStatus(row.id, 'idle');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.updateSessionStatus(row.id, 'error');
      this.emitEvent(row.id, { type: 'error', message, fatal: true });
      this.broadcastStatus(row.id, 'error');
    }
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

  private async waitForShim(id: string, token: string, timeoutMs: number): Promise<void> {
    const client = new ShimClient(id, token);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await client.status()) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error('shim did not become ready in time');
  }

  private connectEvents(id: string, token: string): void {
    this.clients.get(id)?.stop();
    const client = new ShimClient(id, token);
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
    return this.clients.get(id) ?? new ShimClient(id, row.shim_token);
  }

  async prompt(id: string, text: string, mode?: AgentMode): Promise<void> {
    const client = this.client(id);
    this.setStatus(id, 'running');
    const res = await client.prompt({ text, mode });
    if (!res || !res.ok) {
      const message = res && !res.ok ? res.error : 'prompt request failed';
      this.setStatus(id, 'error');
      this.emitEvent(id, { type: 'error', message, fatal: true });
    }
  }

  async permission(id: string, permissionId: string, decision: PermissionDecision): Promise<void> {
    const res = await this.client(id).permission(permissionId, decision);
    if (!res?.ok) throw new Error(res && !res.ok ? res.error : 'permission request failed');
  }

  async abort(id: string): Promise<void> {
    const res = await this.client(id).abort();
    if (!res?.ok) throw new Error(res && !res.ok ? res.error : 'abort request failed');
  }

  async diff(id: string): Promise<DiffEntry[]> {
    const diff = await this.client(id).diff();
    if (!diff) throw new Error('diff request failed');
    return diff;
  }

  async stopSession(id: string): Promise<void> {
    const row = this.requireSession(id);
    this.clients.get(id)?.stop();
    this.clients.delete(id);
    if (row.container_id) await docker.stopContainer(row.container_id);
    this.setStatus(id, 'stopped');
  }

  async resumeSession(id: string): Promise<void> {
    const row = this.requireSession(id);
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
    await this.waitForShim(id, row.shim_token, 60_000);
    if (row.session_ref) {
      const res = await new ShimClient(id, row.shim_token).resume(row.session_ref);
      if (!res?.ok) throw new Error(res && !res.ok ? res.error : 'resume failed');
    }
    this.connectEvents(id, row.shim_token);
    this.setStatus(id, 'idle');
  }

  async push(id: string): Promise<void> {
    const row = this.requireSession(id);
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
    if (row) {
      if (row.container_id) {
        await docker.stopContainer(row.container_id);
        await docker.removeContainer(row.container_id);
      }
      if (row.volume_name) await docker.removeVolume(row.volume_name);
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
