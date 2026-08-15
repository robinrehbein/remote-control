import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { config } from './config.js';

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
  shim_endpoint: string | null;
  created_at: string; last_active_at: string;
}
export interface PairingCodeRow { code: string; tenant_id: string; expires_at: string; used: number }

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
`;

export class Store {
  readonly db: Database.Database;

  constructor(dir: string = config.dataDir) {
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, 'orchestrator.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    const cols = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'shim_endpoint')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN shim_endpoint TEXT');
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

  createPairingCode(code: string, tenant: string, expiresAt: string): void {
    this.db
      .prepare('INSERT INTO pairing_codes (code, tenant_id, expires_at, used) VALUES (?, ?, ?, 0)')
      .run(code, tenant, expiresAt);
  }

  consumePairingCode(code: string): boolean {
    const row = this.db.prepare('SELECT * FROM pairing_codes WHERE code = ?').get(code) as
      | PairingCodeRow
      | undefined;
    if (!row || row.used !== 0 || Date.parse(row.expires_at) < Date.now()) return false;
    this.db.prepare('UPDATE pairing_codes SET used = 1 WHERE code = ?').run(code);
    return true;
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

  insertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, tenant_id, repo_id, repo_full_name, adapter, provider, model, mode,
         status, branch, session_ref, container_id, volume_name, shim_token, pr_url, shim_endpoint, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.tenant_id, row.repo_id, row.repo_full_name, row.adapter, row.provider,
        row.model, row.mode, row.status, row.branch, row.session_ref, row.container_id,
        row.volume_name, row.shim_token, row.pr_url, row.shim_endpoint, row.created_at, row.last_active_at,
      );
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  listSessions(tenant: string): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions WHERE tenant_id = ? ORDER BY created_at DESC')
      .all(tenant) as SessionRow[];
  }

  updateSessionStatus(id: string, status: string): void {
    this.db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, id);
  }

  setProvisioned(id: string, containerId: string, volumeName: string, shimToken: string): void {
    this.db
      .prepare('UPDATE sessions SET container_id = ?, volume_name = ?, shim_token = ? WHERE id = ?')
      .run(containerId, volumeName, shimToken, id);
  }

  setContainer(id: string, containerId: string): void {
    this.db.prepare('UPDATE sessions SET container_id = ? WHERE id = ?').run(containerId, id);
  }

  setShimEndpoint(id: string, endpoint: string | null): void {
    this.db.prepare('UPDATE sessions SET shim_endpoint = ? WHERE id = ?').run(endpoint, id);
  }

  setSessionRef(id: string, ref: string): void {
    this.db.prepare('UPDATE sessions SET session_ref = ? WHERE id = ?').run(ref, id);
  }

  setPrUrl(id: string, url: string): void {
    this.db.prepare('UPDATE sessions SET pr_url = ? WHERE id = ?').run(url, id);
  }

  touchSession(id: string): void {
    this.db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  appendEvent(sessionId: string, type: string, payload: string): void {
    this.db
      .prepare('INSERT INTO session_events (session_id, type, payload, ts) VALUES (?, ?, ?, ?)')
      .run(sessionId, type, payload, new Date().toISOString());
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM session_events WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
}
