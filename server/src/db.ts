import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AgentEvent } from '@pocketagent/protocol';
import { config } from './config.js';
import { decrypt, decryptStrict, encrypt } from './vault.js';

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export interface DeviceRow {
  id: string; tenant_id: string; name: string; token_hash: string;
  fcm_token: string | null; enrolled_at: string;
}
export interface SecretRow {
  id: string; tenant_id: string; kind: string; ciphertext: string; nonce: string; created_at: string;
}
export interface RepoRow {
  id: string; tenant_id: string; full_name: string; default_branch: string; created_at: string;
}
export interface SessionRow {
  id: string; tenant_id: string; repo_id: string; repo_full_name: string;
  adapter: string; provider: string; model: string; mode: string;
  status: string; branch: string; session_ref: string | null; container_id: string | null;
  volume_name: string | null; shim_token: string | null; pr_url: string | null;
  shim_endpoint: string | null; link_id: string | null; network_policy: string | null;
  reasoning_effort: string | null;
  /** User-set title; null = the client derives the name from repo/branch. */
  title: string | null;
  /** 0/1 (sqlite has no boolean). */
  archived: number;
  created_at: string; last_active_at: string;
}
export interface PairingCodeRow {
  code: string; tenant_id: string; expires_at: string; used: number;
  /** Failed confirm attempts against this code; >= 5 locks the code. */
  attempts: number;
}
export interface LinkRow { id: string; tenant_id: string; name: string; token_hash: string; created_at: string }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, fcm_token TEXT, enrolled_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL,
  ciphertext TEXT NOT NULL, nonce TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, full_name TEXT NOT NULL,
  default_branch TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(tenant_id, full_name)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, repo_id TEXT NOT NULL, repo_full_name TEXT NOT NULL,
  adapter TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, mode TEXT NOT NULL,
  status TEXT NOT NULL, branch TEXT NOT NULL, session_ref TEXT, container_id TEXT,
  volume_name TEXT, shim_token TEXT, pr_url TEXT, shim_endpoint TEXT,
  created_at TEXT NOT NULL, last_active_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  type TEXT NOT NULL, payload TEXT NOT NULL, ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
`;

export class Store {
  readonly db: Database.Database;
  private sessionAuthRev = 0;

  constructor(dir: string = config.dataDir) {
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, 'orchestrator.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    const sessionCols = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (!sessionCols.some((c) => c.name === 'shim_endpoint')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN shim_endpoint TEXT');
    }
    if (!sessionCols.some((c) => c.name === 'link_id')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN link_id TEXT');
    }
    if (!sessionCols.some((c) => c.name === 'network_policy')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN network_policy TEXT');
    }
    if (!sessionCols.some((c) => c.name === 'reasoning_effort')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT');
    }
    if (!sessionCols.some((c) => c.name === 'title')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN title TEXT');
    }
    if (!sessionCols.some((c) => c.name === 'archived')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    }
    const pairingCols = this.db.prepare('PRAGMA table_info(pairing_codes)').all() as Array<{ name: string }>;
    if (!pairingCols.some((c) => c.name === 'attempts')) {
      this.db.exec('ALTER TABLE pairing_codes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    }
  }

  close(): void {
    this.db.close();
  }

  createDevice(id: string, tenant: string, name: string, tokenHash: string): void {
    this.db
      .prepare('INSERT INTO devices (id, tenant_id, name, token_hash, enrolled_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, tenant, name, tokenHash, new Date().toISOString());
  }

  getDevice(id: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
  }

  setFcmToken(id: string, token: string): void {
    this.db.prepare('UPDATE devices SET fcm_token = ? WHERE id = ?').run(token, id);
  }

  listFcmTokens(tenant: string): string[] {
    const rows = this.db
      .prepare('SELECT fcm_token FROM devices WHERE tenant_id = ? AND fcm_token IS NOT NULL')
      .all(tenant) as Array<{ fcm_token: string }>;
    return rows.map((r) => r.fcm_token);
  }

  listDevices(tenant: string): DeviceRow[] {
    return this.db.prepare('SELECT * FROM devices WHERE tenant_id = ?').all(tenant) as DeviceRow[];
  }

  /** Revocation: deletes the device row (token dies with it). Returns true when a row was removed. */
  deleteDevice(id: string): boolean {
    return this.db.prepare('DELETE FROM devices WHERE id = ?').run(id).changes === 1;
  }

  listLinks(tenant: string): LinkRow[] {
    return this.db.prepare('SELECT * FROM links WHERE tenant_id = ?').all(tenant) as LinkRow[];
  }

  /** Revocation: deletes the link row. Returns true when a row was removed. */
  deleteLink(id: string): boolean {
    return this.db.prepare('DELETE FROM links WHERE id = ?').run(id).changes === 1;
  }

  createPairingCode(code: string, tenant: string, expiresAt: string): void {
    this.db
      .prepare('INSERT INTO pairing_codes (code, tenant_id, expires_at, used) VALUES (?, ?, ?, 0)')
      .run(code, tenant, expiresAt);
  }

  /**
   * Consume a pairing code atomically: exactly one caller can flip used 0->1, and
   * only while the code is unused, has < 5 failed attempts and is unexpired.
   * better-sqlite3 is synchronous, so this read-modify-write is race-free within
   * one process (the single-process trust model of this server).
   */
  consumePairingCode(code: string, nowIso: string = new Date().toISOString()): boolean {
    const consumed = this.db
      .prepare(
        'UPDATE pairing_codes SET used = 1 WHERE code = ? AND used = 0 AND attempts < 5 AND expires_at > ?',
      )
      .run(code, nowIso);
    if (consumed.changes === 1) return true;
    // Failed attempt: burn an attempt only when the row exists and was not
    // already consumed, so expired/unknown submissions don't burn unrelated rows.
    this.db
      .prepare('UPDATE pairing_codes SET attempts = attempts + 1 WHERE code = ? AND used = 0')
      .run(code);
    return false;
  }

  createLink(id: string, tenant: string, name: string, tokenHash: string): void {
    this.db
      .prepare('INSERT INTO links (id, tenant_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, tenant, name, tokenHash, new Date().toISOString());
  }

  getLinkByTokenHash(tokenHash: string): LinkRow | undefined {
    return this.db.prepare('SELECT * FROM links WHERE token_hash = ?').get(tokenHash) as
      | LinkRow
      | undefined;
  }

  getSessionByLink(linkId: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE link_id = ?').get(linkId) as
      | SessionRow
      | undefined;
  }

  saveSecret(id: string, tenant: string, kind: string, ciphertext: string, nonce: string): void {
    this.db
      .prepare('INSERT INTO secrets (id, tenant_id, kind, ciphertext, nonce, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, tenant, kind, ciphertext, nonce, new Date().toISOString());
  }

  getSecret(id: string): SecretRow | undefined {
    return this.db.prepare('SELECT * FROM secrets WHERE id = ?').get(id) as SecretRow | undefined;
  }

  getSecretByKind(kind: string, tenant: string): SecretRow | undefined {
    return this.db
      .prepare('SELECT * FROM secrets WHERE tenant_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1')
      .get(tenant, kind) as SecretRow | undefined;
  }

  /** In-place re-encryption of a secret row (used for legacy AAD-less migration). */
  updateSecret(id: string, ciphertext: string, nonce: string): void {
    this.db.prepare('UPDATE secrets SET ciphertext = ?, nonce = ? WHERE id = ?').run(ciphertext, nonce, id);
  }

  /**
   * Newest plaintext secret value for tenant+kind (same ordering as getSecretByKind),
   * decrypted with AAD `secret:<tenant>:<kind>`. Legacy rows written before AAD
   * binding decrypt via the no-AAD fallback and are transparently re-encrypted
   * with AAD and persisted. Returns null when no row exists.
   */
  getSecretValue(kind: string, tenant: string): string | null {
    const row = this.getSecretByKind(kind, tenant);
    if (!row) return null;
    const aad = `secret:${tenant}:${kind}`;
    const enc = { ciphertext: row.ciphertext, nonce: row.nonce };
    try {
      return decryptStrict(enc, aad);
    } catch {
      // AAD-strict decrypt failed => legacy row; decrypt via the no-AAD fallback
      // path (returns normally for legacy rows) and re-encrypt with AAD.
      const value = decrypt(enc);
      const re = encrypt(value, aad);
      this.updateSecret(row.id, re.ciphertext, re.nonce);
      return value;
    }
  }

  listSecrets(tenant: string): SecretRow[] {
    return this.db.prepare('SELECT * FROM secrets WHERE tenant_id = ?').all(tenant) as SecretRow[];
  }

  deleteSecret(id: string, tenant: string): void {
    this.db.prepare('DELETE FROM secrets WHERE id = ? AND tenant_id = ?').run(id, tenant);
  }

  addRepo(id: string, tenant: string, fullName: string, defaultBranch: string): RepoRow {
    this.db
      .prepare('INSERT INTO repos (id, tenant_id, full_name, default_branch, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, tenant, fullName, defaultBranch, new Date().toISOString());
    return this.getRepo(id)!;
  }

  getRepo(id: string): RepoRow | undefined {
    return this.db.prepare('SELECT * FROM repos WHERE id = ?').get(id) as RepoRow | undefined;
  }

  listRepos(tenant: string): RepoRow[] {
    return this.db.prepare('SELECT * FROM repos WHERE tenant_id = ?').all(tenant) as RepoRow[];
  }

  /**
   * Zähler über alle Änderungen an Session-Feldern, die über Egress-Auth
   * entscheiden (Existenz, Status, shim_token, Container, Archiv-Flag, Link).
   * Der Egress-Gate leitet daraus seine Token-Tabelle ab und baut sie nur neu,
   * wenn sich hier etwas bewegt hat (sessions.ts: egressTokens). Bewusst nicht
   * erhöht wird bei touchSession & Co: die laufen pro Event und ändern nichts,
   * was den Proxy interessiert.
   */
  get sessionAuthRevision(): number {
    return this.sessionAuthRev;
  }

  private bumpSessionAuth(): void {
    this.sessionAuthRev++;
  }

  insertSession(row: SessionRow): void {
    this.bumpSessionAuth();
    this.db
      .prepare(
        `INSERT INTO sessions (id, tenant_id, repo_id, repo_full_name, adapter, provider, model, mode,
         status, branch, session_ref, container_id, volume_name, shim_token, pr_url, shim_endpoint, link_id,
         network_policy, reasoning_effort, title, archived, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.tenant_id, row.repo_id, row.repo_full_name, row.adapter, row.provider,
        row.model, row.mode, row.status, row.branch, row.session_ref, row.container_id,
        row.volume_name, row.shim_token, row.pr_url, row.shim_endpoint, row.link_id,
        row.network_policy, row.reasoning_effort, row.title, row.archived ? 1 : 0,
        row.created_at, row.last_active_at,
      );
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  /**
   * All sessions of a tenant, archived ones included. No server-side archive
   * filter on purpose: the row is what a client needs to *un*archive a session,
   * so hiding it here would make archiving a one-way trip for every device. The
   * list is one small row per session, and `SessionInfo.archived` tells the
   * client what to fold away.
   */
  listSessions(tenant: string): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions WHERE tenant_id = ? ORDER BY created_at DESC')
      .all(tenant) as SessionRow[];
  }

  updateSessionStatus(id: string, status: string): void {
    this.bumpSessionAuth();
    this.db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, id);
  }

  updateSessionMode(id: string, mode: string): void {
    this.db.prepare('UPDATE sessions SET mode = ? WHERE id = ?').run(mode, id);
  }

  /**
   * Partial update of the switchable session settings (session.update).
   * `clearSessionRef` belongs to the harness switch: a runtime session
   * reference is bound to the old adapter and must not survive it.
   */
  updateSessionSettings(
    id: string,
    patch: {
      mode?: string;
      model?: string;
      reasoningEffort?: string;
      adapter?: string;
      provider?: string;
      clearSessionRef?: boolean;
    },
  ): void {
    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (patch.mode !== undefined) {
      sets.push('mode = ?');
      values.push(patch.mode);
    }
    if (patch.model !== undefined) {
      sets.push('model = ?');
      values.push(patch.model);
    }
    if (patch.reasoningEffort !== undefined) {
      sets.push('reasoning_effort = ?');
      // empty string clears the stored effort
      values.push(patch.reasoningEffort === '' ? null : patch.reasoningEffort);
    }
    if (patch.adapter !== undefined) {
      sets.push('adapter = ?');
      values.push(patch.adapter);
    }
    if (patch.provider !== undefined) {
      sets.push('provider = ?');
      values.push(patch.provider);
    }
    if (patch.clearSessionRef === true) {
      sets.push('session_ref = NULL');
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  setProvisioned(id: string, containerId: string, volumeName: string, shimToken: string): void {
    this.bumpSessionAuth();
    this.db
      .prepare('UPDATE sessions SET container_id = ?, volume_name = ?, shim_token = ? WHERE id = ?')
      .run(containerId, volumeName, shimToken, id);
  }

  setContainer(id: string, containerId: string): void {
    this.bumpSessionAuth();
    this.db.prepare('UPDATE sessions SET container_id = ? WHERE id = ?').run(containerId, id);
  }

  setShimEndpoint(id: string, endpoint: string | null): void {
    this.db.prepare('UPDATE sessions SET shim_endpoint = ? WHERE id = ?').run(endpoint, id);
  }

  setLinkId(id: string, linkId: string | null): void {
    this.bumpSessionAuth();
    this.db.prepare('UPDATE sessions SET link_id = ? WHERE id = ?').run(linkId, id);
  }

  setSessionRef(id: string, ref: string): void {
    this.db.prepare('UPDATE sessions SET session_ref = ? WHERE id = ?').run(ref, id);
  }

  setPrUrl(id: string, url: string): void {
    this.db.prepare('UPDATE sessions SET pr_url = ? WHERE id = ?').run(url, id);
  }

  /** `null` clears the title (the client derives a name again). */
  setSessionTitle(id: string, title: string | null): void {
    this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id);
  }

  setSessionArchived(id: string, archived: boolean): void {
    this.bumpSessionAuth();
    this.db.prepare('UPDATE sessions SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
  }

  touchSession(id: string): void {
    this.db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  appendEvent(sessionId: string, type: string, payload: string): void {
    this.db
      .prepare('INSERT INTO session_events (session_id, type, payload, ts) VALUES (?, ?, ?, ?)')
      .run(sessionId, type, payload, new Date().toISOString());
    // Keep only the 5000 most recent events per session (unbounded growth = DoS).
    this.db
      .prepare(
        'DELETE FROM session_events WHERE session_id = ? AND id NOT IN (SELECT id FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT 5000)',
      )
      .run(sessionId, sessionId);
  }

  /**
   * The `limit` youngest stored events of a session, returned oldest first so
   * a client can append them to an empty timeline as they happened.
   *
   * Two kinds of noise never make it into the answer: 'ping' keepalives and
   * progress notices (a `phase` field), which describe a start that is long
   * over by the time anyone reloads. They are already dropped on write
   * (isHistoryEvent in sessions.ts) - repeating the rule here covers the rows
   * a database written before that filter still holds.
   *
   * A row whose payload is not readable JSON is skipped, never thrown on: one
   * damaged line must not cost the whole conversation.
   */
  listSessionEvents(sessionId: string, limit: number): AgentEvent[] {
    const rows = this.db
      .prepare(
        "SELECT payload FROM session_events WHERE session_id = ? AND type <> 'ping' ORDER BY id DESC LIMIT ?",
      )
      .all(sessionId, limit) as Array<{ payload: string }>;
    const events: AgentEvent[] = [];
    for (const row of rows.reverse()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const ev = parsed as { type?: unknown; phase?: unknown };
      if (typeof ev.type !== 'string') continue;
      if (ev.type === 'ping' || (ev.type === 'notice' && ev.phase !== undefined)) continue;
      events.push(parsed as AgentEvent);
    }
    return events;
  }

  deleteSession(id: string): void {
    this.bumpSessionAuth();
    this.db.prepare('DELETE FROM session_events WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
}
