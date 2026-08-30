import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AgentEvent } from '@pocketagent/protocol';
import { config } from './config.js';
import { decryptStrict } from './vault.js';

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export interface DeviceRow {
  id: string; tenant_id: string; name: string; token_hash: string;
  fcm_token: string | null; enrolled_at: string; last_seen_at: string | null;
}
export interface SecretRow {
  id: string; tenant_id: string; kind: string; ciphertext: string; nonce: string; created_at: string;
}
export interface RepoRow {
  id: string; tenant_id: string; full_name: string; default_branch: string; created_at: string;
}
export interface SessionRow {
  id: string; tenant_id: string; repo_id: string; repo_full_name: string;
  provider: string; model: string; mode: string;
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
export interface TurnRow {
  /** Orchestrator-assigned turn id (uuid). */
  id: string;
  session_id: string;
  /** App-generated per-turn id; null for a prompt from a client that sent none. */
  message_id: string | null;
  /** queued | running | completed | failed | interrupted. */
  state: string;
  /** JSON `TurnFailureReason`, set only in the failed state. */
  reason: string | null;
  created_at: string;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, fcm_token TEXT, enrolled_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL,
  ciphertext TEXT NOT NULL, nonce TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(tenant_id, kind)
);
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, full_name TEXT NOT NULL,
  default_branch TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(tenant_id, full_name)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, repo_id TEXT NOT NULL, repo_full_name TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, mode TEXT NOT NULL,
  status TEXT NOT NULL, branch TEXT NOT NULL, session_ref TEXT, container_id TEXT,
  volume_name TEXT, shim_token TEXT, pr_url TEXT, shim_endpoint TEXT, link_id TEXT,
  network_policy TEXT, reasoning_effort TEXT, title TEXT, archived INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT,
  state TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
    // session_events(session_id) is scanned on every single event write
    // (appendEvent's trim DELETE) and on every history read
    // (listSessionEvents) - without an index both are full-table scans over
    // every session's events, synchronous in the event loop.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_session_events_sid ON session_events(session_id, id)');
    // The turns table (see SCHEMA) also runs its CREATE TABLE IF NOT EXISTS on
    // every boot, so an existing database gains the table here; these two
    // indexes back the two hot lookups - a session's turns oldest-first, and
    // the idempotency probe by (session, message_id). The partial unique index
    // enforces "one turn per app-generated messageId" at the storage layer,
    // the same guarantee the prompt path checks in code (rows with a NULL
    // message_id - older clients - are exempt and never collide).
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, id)');
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_message ON turns(session_id, message_id) WHERE message_id IS NOT NULL',
    );
    // v2 startet grundsätzlich auf einer frischen Datei (siehe GREENFIELD-PI.md
    // „Risiken"): sämtliche Spalten und die UNIQUE-Constraints (secrets(tenant_id,
    // kind), pairing_codes.attempts) stehen vollständig in SCHEMA. Die einzige
    // additive Ausnahme ist devices.last_seen_at: sie kam nach dem ersten v2-
    // Release dazu, deshalb bekommt eine bereits laufende Instanz die Spalte hier
    // per idempotentem ADD COLUMN, ohne dass gekoppelte Geräte verloren gehen.
    this.addColumnIfMissing('devices', 'last_seen_at', 'TEXT');
  }

  /** Fügt eine Spalte hinzu, falls sie noch fehlt (idempotent, ohne v1-Ballast). */
  private addColumnIfMissing(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  close(): void {
    this.db.close();
  }

  createDevice(id: string, tenant: string, name: string, tokenHash: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO devices (id, tenant_id, name, token_hash, enrolled_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, tenant, name, tokenHash, now, now);
  }

  getDevice(id: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
  }

  /** Stempelt die letzte authentifizierte Verbindung eines Geräts (bei jedem `hello`). */
  touchDevice(id: string): void {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), id);
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

  /**
   * Upsert on the UNIQUE(tenant_id, kind) index: a save for a kind that
   * already has a row replaces it (id included) instead of inserting a
   * second row. This is what makes deleteSecret's "delete the kind" and
   * getSecretValue's "newest row" semantics actually hold - before this
   * there was no uniqueness, and a rotated-then-deleted key could silently
   * come back as the new "newest" row.
   */
  saveSecret(id: string, tenant: string, kind: string, ciphertext: string, nonce: string): void {
    this.db
      .prepare(
        `INSERT INTO secrets (id, tenant_id, kind, ciphertext, nonce, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, kind) DO UPDATE SET
           id = excluded.id, ciphertext = excluded.ciphertext, nonce = excluded.nonce, created_at = excluded.created_at`,
      )
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

  /**
   * Newest plaintext secret value for tenant+kind (same ordering as getSecretByKind),
   * decrypted STRICTLY with AAD `secret:<tenant>:<kind>`. Returns null when no row
   * exists; throws when the ciphertext/AAD pair does not verify. v2 startet frisch
   * und schreibt jedes Secret AAD-gebunden (ws.ts `secret.set`, secrets-api.ts) -
   * es gibt keine AAD-losen Alt-Zeilen mehr, daher kein No-AAD-Fallback und keine
   * transparente Re-Verschlüsselung.
   */
  getSecretValue(kind: string, tenant: string): string | null {
    const row = this.getSecretByKind(kind, tenant);
    if (!row) return null;
    const aad = `secret:${tenant}:${kind}`;
    return decryptStrict({ ciphertext: row.ciphertext, nonce: row.nonce }, aad);
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
        `INSERT INTO sessions (id, tenant_id, repo_id, repo_full_name, provider, model, mode,
         status, branch, session_ref, container_id, volume_name, shim_token, pr_url, shim_endpoint, link_id,
         network_policy, reasoning_effort, title, archived, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.tenant_id, row.repo_id, row.repo_full_name, row.provider,
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
   * Teilweise Aktualisierung der umschaltbaren Session-Einstellungen
   * (`session.update`). Der Adapterwechsel aus v1 ist entfallen - es gibt nur
   * pi -, deshalb bleiben Provider und `session_ref` hier unberührt.
   */
  updateSessionSettings(
    id: string,
    patch: {
      mode?: string;
      model?: string;
      reasoningEffort?: string;
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

  /**
   * Persist one event and return its `id` (the AUTOINCREMENT rowid). That rowid
   * is the server's session-wide, strictly monotone event sequence: the
   * orchestrator stamps it onto the event that reaches devices (live broadcast
   * and history), so the app dedups on a number that never resets and never
   * collides - unlike the runner/link `seq` inside the payload, which restarts
   * at 1 on every runner process and repeats across resume generations.
   */
  appendEvent(sessionId: string, type: string, payload: string): number {
    const info = this.db
      .prepare('INSERT INTO session_events (session_id, type, payload, ts) VALUES (?, ?, ?, ?)')
      .run(sessionId, type, payload, new Date().toISOString());
    const rowid = Number(info.lastInsertRowid);
    // Keep only the 5000 most recent events per session (unbounded growth = DoS).
    // Der Trim ist ein Subquery-Scan; ihn nicht bei JEDEM Event fahren, sondern
    // nur etwa jedes 50. (über die globale rowid gedrosselt). Eine Session
    // überschreitet die Obergrenze dadurch höchstens kurz um ein paar Dutzend
    // Zeilen - unkritisch, spart aber den Scan bei 49 von 50 Schreibvorgängen.
    if (rowid % 50 === 0) {
      this.db
        .prepare(
          'DELETE FROM session_events WHERE session_id = ? AND id NOT IN (SELECT id FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT 5000)',
        )
        .run(sessionId, sessionId);
    }
    return rowid;
  }

  /**
   * The `limit` youngest stored events of a session, returned oldest first so
   * a client can append them to an empty timeline as they happened.
   *
   * Noise (pings, progress notices) is already dropped on write (isHistoryEvent
   * in sessions.ts) and pings are additionally excluded by the query, so the
   * read path only validates the payload shape - it does not re-apply the
   * history filter (v2 starts on a fresh DB; there are no pre-filter rows to heal).
   *
   * A row whose payload is not readable JSON, or is not an object with a string
   * `type`, is skipped, never thrown on: one damaged line must not cost the whole
   * conversation.
   */
  listSessionEvents(sessionId: string, limit: number): AgentEvent[] {
    const rows = this.db
      .prepare(
        "SELECT id, payload FROM session_events WHERE session_id = ? AND type <> 'ping' ORDER BY id DESC LIMIT ?",
      )
      .all(sessionId, limit) as Array<{ id: number; payload: string }>;
    const events: AgentEvent[] = [];
    for (const row of rows.reverse()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      if (typeof (parsed as { type?: unknown }).type !== 'string') continue;
      // Kanonische Sequenz: die App dedupt zwischen Live-Strom und Historie über
      // `seq`. Der Live-Broadcast trägt die server-vergebene rowid (onEvent), also
      // muss die Historie DENSELBEN Wert tragen - nicht die im Payload gespeicherte
      // Runner-seq (pro Runner-Prozess bei 1 startend, über Resume-Generationen
      // kollidierend). Der gespeicherte Runner-seq bleibt für den Transport-Cursor
      // erhalten (lastEventSeq liest ihn separat), wird hier aber überschrieben.
      events.push({ ...(parsed as AgentEvent), seq: row.id });
    }
    return events;
  }

  /**
   * Sequence number (AgentEventMeta.seq) of the newest stored event of a
   * session, or 0 when the newest event carries none (older shim, link agent,
   * or no events at all). Lets the orchestrator resume the shim's replay cursor
   * after a redeploy without re-reading the whole timeline: the newest event's
   * seq is the highest of the shim's current stream (seq is monotone per
   * stream, and pings/progress notices are never stored).
   */
  lastEventSeq(sessionId: string): number {
    const row = this.db
      .prepare('SELECT payload FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT 1')
      .get(sessionId) as { payload: string } | undefined;
    if (!row) return 0;
    try {
      const seq = (JSON.parse(row.payload) as { seq?: unknown }).seq;
      return typeof seq === 'number' && Number.isFinite(seq) ? seq : 0;
    } catch {
      return 0;
    }
  }

  deleteSession(id: string): void {
    this.bumpSessionAuth();
    this.db.prepare('DELETE FROM session_events WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM turns WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  /* ---- turns (per-turn lifecycle, KILO-CLOUD-ANALYSE.md P1) ---- */

  insertTurn(row: TurnRow): void {
    this.db
      .prepare(
        'INSERT INTO turns (id, session_id, message_id, state, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.session_id, row.message_id, row.state, row.reason, row.created_at, row.updated_at);
  }

  getTurn(id: string): TurnRow | undefined {
    return this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as TurnRow | undefined;
  }

  /**
   * The turn a given app-generated messageId already admitted, if any. This is
   * the idempotency probe: a non-undefined answer means the prompt was already
   * accepted once and must not start a second agent turn.
   */
  getTurnByMessageId(sessionId: string, messageId: string): TurnRow | undefined {
    return this.db
      .prepare('SELECT * FROM turns WHERE session_id = ? AND message_id = ?')
      .get(sessionId, messageId) as TurnRow | undefined;
  }

  /**
   * Newest not-yet-terminal turn of a session (`queued`/`running`), i.e. the
   * one a `turn.completed`/`.failed`/abort/restart applies to. There is at most
   * one at a time in this model (a session runs its turns in sequence).
   */
  latestActiveTurn(sessionId: string): TurnRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM turns WHERE session_id = ? AND state IN ('queued', 'running') ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(sessionId) as TurnRow | undefined;
  }

  /** Transition a turn; `reason` is JSON (`TurnFailureReason`) for the failed state, else null. */
  updateTurnState(id: string, state: string, reason: string | null = null): void {
    this.db
      .prepare('UPDATE turns SET state = ?, reason = ?, updated_at = ? WHERE id = ?')
      .run(state, reason, new Date().toISOString(), id);
  }

  /** The `limit` most recent turns of a session, oldest first (mirror of listSessionEvents). */
  listTurns(sessionId: string, limit: number): TurnRow[] {
    const rows = this.db
      .prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(sessionId, limit) as TurnRow[];
    return rows.reverse();
  }
}
