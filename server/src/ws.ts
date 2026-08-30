import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@pocketagent/protocol';
import { SECRET_KINDS, WS_CLOSE_REPLACED, WS_CLOSE_TOO_MANY_CONNECTIONS, WS_CLOSE_UNAUTHORIZED } from '@pocketagent/protocol';
import { SERVER_VERSION } from './config.js';
import { sha256 } from './db.js';
import type { Store } from './db.js';
import type { SessionManager } from './sessions.js';
import { encrypt } from './vault.js';
import { validateSecret } from './secret-validate.js';
import { isKnownSecretKind, isValidSecretKind } from './secrets-api.js';

/** Security audit line (stdout-warn JSON; never log tokens). */
function auditWarn(kind: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ ts: new Date().toISOString(), ev: 'auth.fail', kind, ...fields }));
}

/** Per remote-address live WS connection counter (module level, one process). */
const wsConnCounts = new Map<string, number>();
const MAX_CONNS_PER_ADDRESS = 10;

/** Heartbeat round; two rounds without a pong end a connection (~50s). */
export const WS_HEARTBEAT_MS = 25_000;
const MAX_MISSED_PONGS = 2;

/**
 * A socket that never sends `hello`/`agent.hello` after connecting is kept
 * alive indefinitely by the heartbeat above (the ws library auto-answers
 * protocol pings with pongs, so an idle-but-unauthenticated socket looks
 * exactly as "alive" as a real device). Behind a proxy without TRUST_PROXY,
 * every client shares the MAX_CONNS_PER_ADDRESS slots for that one address,
 * so an attacker who never authenticates can hold them open forever. This
 * timer closes what is still unauthenticated after the grace period.
 */
export const WS_AUTH_TIMEOUT_MS = 10_000;

/**
 * Liveness check for every socket on /ws. A phone that loses its network (or a
 * NAT that drops the flow) never sends a close frame: the socket stays open
 * forever on this side, the device counts as online, and a link session stays
 * bound to a peer nobody is behind any more. So the server pings on its own and
 * terminates what does not answer twice in a row - `terminate()` then runs the
 * ordinary close handling (hub cleanup, link disconnect).
 *
 * These are protocol-level ping/pong frames: the ws client answers them itself,
 * independent of the JSON `agent.ping`/`agent.pong` keepalive link agents speak
 * on top of the connection. Both run side by side without interfering.
 */
export class Heartbeat {
  /** socket -> rounds since the last pong (or since it was tracked). */
  private readonly missed = new Map<WebSocket, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly intervalMs: number = WS_HEARTBEAT_MS) {}

  track(socket: WebSocket): void {
    this.missed.set(socket, 0);
    socket.on('pong', () => {
      if (this.missed.has(socket)) this.missed.set(socket, 0);
    });
    socket.once('close', () => this.missed.delete(socket));
    if (this.timer === null) {
      this.timer = setInterval(() => this.tick(), this.intervalMs);
      // must not keep the process alive on its own
      this.timer.unref?.();
    }
  }

  private tick(): void {
    for (const [socket, missed] of [...this.missed]) {
      if (missed >= MAX_MISSED_PONGS) {
        this.missed.delete(socket);
        try {
          socket.terminate();
        } catch {
          /* already gone */
        }
        continue;
      }
      this.missed.set(socket, missed + 1);
      try {
        socket.ping();
      } catch {
        this.missed.delete(socket);
      }
    }
  }

  /** Live socket count (diagnostics/tests). */
  size(): number {
    return this.missed.size;
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.missed.clear();
  }
}

export class Hub {
  private readonly sockets = new Set<WebSocket>();
  private readonly deviceIds = new Map<WebSocket, string>();
  private readonly linkSockets = new Map<string, WebSocket>();
  private readonly pendingLinkCalls = new Map<
    string,
    { linkId: string; resolve: (v: { status: number; body?: unknown } | null) => void; timer: NodeJS.Timeout }
  >();

  add(s: WebSocket, deviceId: string): void {
    this.sockets.add(s);
    this.deviceIds.set(s, deviceId);
  }

  remove(s: WebSocket): void {
    this.sockets.delete(s);
    this.deviceIds.delete(s);
  }

  isDeviceOnline(deviceId: string): boolean {
    for (const id of this.deviceIds.values()) {
      if (id === deviceId) return true;
    }
    return false;
  }

  /** Close all live sockets of a device (called on device revocation; safe to call again). */
  closeDevice(deviceId: string): void {
    for (const [s, id] of [...this.deviceIds]) {
      if (id !== deviceId) continue;
      this.remove(s);
      try {
        s.close(WS_CLOSE_UNAUTHORIZED, 'revoked');
      } catch {
        /* already closed */
      }
    }
  }

  /** Close a link agent's live socket (called on link revocation; safe to call again). */
  closeLink(linkId: string): void {
    const s = this.linkSockets.get(linkId);
    if (!s) return;
    this.linkSockets.delete(linkId);
    try {
      s.close(WS_CLOSE_UNAUTHORIZED, 'revoked');
    } catch {
      /* already closed */
    }
    this.rejectPendingLinkCalls(linkId);
  }

  /**
   * Reject every in-flight callLink() promise for a link whose socket just
   * went away (close/error/revocation). Without this, the caller (a
   * prompt/diff/permission request routed through a link session) sits on
   * the full 20s callLink timeout despite the disconnect being known
   * immediately - the user sees nothing for 20s, then a misleading "link
   * call timed out" instead of an immediate "link agent disconnected".
   */
  private rejectPendingLinkCalls(linkId: string): void {
    for (const [callId, pending] of [...this.pendingLinkCalls]) {
      if (pending.linkId !== linkId) continue;
      clearTimeout(pending.timer);
      this.pendingLinkCalls.delete(callId);
      pending.resolve(null);
    }
  }

  broadcast(m: ServerMessage): void {
    const raw = JSON.stringify(m);
    for (const s of this.sockets) {
      try {
        s.send(raw);
      } catch {
        /* drop */
      }
    }
  }

  registerLink(linkId: string, socket: WebSocket): void {
    this.linkSockets.get(linkId)?.close(WS_CLOSE_REPLACED, 'replaced');
    this.linkSockets.set(linkId, socket);
  }

  dropLink(linkId: string, socket: WebSocket): void {
    if (this.linkSockets.get(linkId) !== socket) return;
    this.linkSockets.delete(linkId);
    this.rejectPendingLinkCalls(linkId);
  }

  hasLink(linkId: string): boolean {
    return this.linkSockets.has(linkId);
  }

  callLink(
    linkId: string,
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ): Promise<{ status: number; body?: unknown } | null> {
    const socket = this.linkSockets.get(linkId);
    if (!socket) return Promise.resolve(null);
    const callId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingLinkCalls.delete(callId);
        resolve(null);
      }, 20_000);
      this.pendingLinkCalls.set(callId, { linkId, resolve, timer });
      try {
        socket.send(JSON.stringify({ type: 'agent.command', callId, path, method, body }));
      } catch {
        clearTimeout(timer);
        this.pendingLinkCalls.delete(callId);
        resolve(null);
      }
    });
  }

  resolveLinkCall(callId: string, status: number, body?: unknown): void {
    const pending = this.pendingLinkCalls.get(callId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingLinkCalls.delete(callId);
    pending.resolve({ status, body });
  }

  byeLink(linkId: string): void {
    const socket = this.linkSockets.get(linkId);
    if (!socket) return;
    try {
      socket.send(JSON.stringify({ type: 'agent.bye' }));
    } catch {
      /* closed */
    }
  }
}

/** Incoming frames on a link socket (link -> server uses ServerMessage variants). */
type LinkInMessage = Extract<
  ServerMessage,
  { type: 'agent.response' | 'agent.event' | 'agent.ping' | 'agent.pong' | 'agent.heartbeat' }
>;
type SocketInMessage = ClientMessage | LinkInMessage;

const REPO_FULL_NAME_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REPO_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

export function registerWs(
  app: FastifyInstance,
  store: Store,
  manager: SessionManager,
  hub: Hub,
  heartbeat?: Heartbeat,
  authTimeoutMs: number = WS_AUTH_TIMEOUT_MS,
): void {
  // maxPayload (1 MiB) is enforced at the websocket plugin registration in index.ts.
  app.get('/ws', { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    // request.ip is Fastify's resolved address: plain socket IP normally, but
    // the X-Forwarded-For client when TRUST_PROXY=1 - without that, every
    // client behind a reverse proxy (Coolify/Traefik) collapses onto the
    // proxy's one address and this cap fires on unrelated devices. Still a
    // coarse DoS guard, not an identity bound.
    const addr = request.ip || 'unknown';
    const conns = (wsConnCounts.get(addr) ?? 0) + 1;
    wsConnCounts.set(addr, conns);
    socket.once('close', () => {
      const n = (wsConnCounts.get(addr) ?? 1) - 1;
      if (n <= 0) wsConnCounts.delete(addr);
      else wsConnCounts.set(addr, n);
    });
    if (conns > MAX_CONNS_PER_ADDRESS) {
      auditWarn('ws.conn-limit', { ip: addr });
      // WS_CLOSE_TOO_MANY_CONNECTIONS, not WS_CLOSE_UNAUTHORIZED: a client
      // can tell "too many conns" (transient, keep reconnecting) apart from
      // "credentials rejected" (terminal) - see isTerminalLinkCloseCode.
      socket.close(WS_CLOSE_TOO_MANY_CONNECTIONS, 'too many connections');
      return;
    }
    // every accepted socket, device and link agent alike - a half-dead
    // connection costs the same on both roles
    heartbeat?.track(socket);

    let authed = false;
    let role: 'device' | 'link' = 'device';
    let deviceId: string | null = null;
    let linkId: string | null = null;

    // Neither hello variant arrived in time: close before the heartbeat ever
    // gets a chance to keep this socket alive on protocol pongs alone.
    const authTimer = setTimeout(() => {
      if (authed) return;
      auditWarn('ws.auth-timeout', { ip: addr });
      socket.close(WS_CLOSE_UNAUTHORIZED, 'auth timeout');
    }, authTimeoutMs);
    authTimer.unref?.();
    socket.once('close', () => clearTimeout(authTimer));

    const send = (m: ServerMessage): void => {
      try {
        socket.send(JSON.stringify(m));
      } catch {
        /* closed */
      }
    };
    const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

    socket.on('message', (data: RawData) => {
      let msg: SocketInMessage;
      try {
        msg = JSON.parse(String(data)) as SocketInMessage;
      } catch {
        return;
      }
      if (!authed) {
        if (msg.type === 'agent.hello') {
          const link = store.getLinkByTokenHash(sha256(msg.token));
          if (!link) {
            auditWarn('ws.link-unauthorized', { ip: addr });
            socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
            return;
          }
          authed = true;
          clearTimeout(authTimer);
          role = 'link';
          linkId = link.id;
          hub.registerLink(link.id, socket);
          const sessionId = manager.registerLinkSession(link, msg);
          send({ type: 'agent.ready', sessionId });
          return;
        }
        if (msg.type !== 'hello') {
          socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
          return;
        }
        const dev = store.getDevice(msg.deviceId);
        if (!dev) {
          // Row gone => device was revoked (or never enrolled).
          auditWarn('ws.revoked-device', { ip: addr, deviceId: msg.deviceId });
          socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
          return;
        }
        // Konstantzeit-Vergleich der (gleich langen Hex-)Hashes, konsistent zu
        // pairing.ts adminTokenOk - kein `!==` als Timing-Seitenkanal.
        const provided = Buffer.from(sha256(msg.token), 'utf8');
        const expected = Buffer.from(dev.token_hash, 'utf8');
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
          auditWarn('ws.unauthorized', { ip: addr, deviceId: msg.deviceId });
          socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        deviceId = dev.id;
        hub.add(socket, dev.id);
        send({ type: 'welcome', ok: true, serverVersion: SERVER_VERSION });
        return;
      }
      if (role === 'link') {
        if (msg.type === 'agent.response') {
          hub.resolveLinkCall(msg.callId, msg.status, msg.body);
          return;
        }
        if (msg.type === 'agent.event') {
          // Trust boundary: a link is bound to exactly one session
          // (registerLinkSession / store.setLinkId), but msg.sessionId comes
          // straight off the wire. Resolving the target from that binding -
          // instead of taking the frame's claim - means an authenticated (or
          // compromised) link host cannot forge events into a session it
          // does not own (fake permission.request pushes, a turn.completed
          // that flips a foreign session to idle, a status event that
          // overwrites another session's session_ref, ...).
          const bound = linkId ? store.getSessionByLink(linkId) : undefined;
          if (!bound || bound.id !== msg.sessionId) {
            auditWarn('ws.link-event-foreign-session', {
              linkId,
              claimedSessionId: msg.sessionId,
              boundSessionId: bound?.id,
            });
            return;
          }
          manager.handleLinkEvent(bound.id, msg.event);
          return;
        }
        if (msg.type === 'agent.ping') {
          send({ type: 'agent.pong', ts: msg.ts });
          return;
        }
        if (msg.type === 'agent.heartbeat') {
          // Same trust boundary as agent.event above: handleLinkHeartbeat
          // resolves the target from the link's own binding, so a session id
          // in msg.sessions that is not this link's bound session is simply
          // never matched - it cannot affect a foreign session.
          if (linkId) manager.handleLinkHeartbeat(linkId, msg.sessions);
          return;
        }
        return;
      }
      if (
        msg.type === 'agent.response' ||
        msg.type === 'agent.event' ||
        msg.type === 'agent.ping' ||
        msg.type === 'agent.pong' ||
        msg.type === 'agent.heartbeat' ||
        msg.type === 'agent.hello'
      ) {
        return;
      }
      void handle(msg).catch((e) => send({ type: 'error', message: errText(e) }));
    });

    socket.on('close', () => {
      hub.remove(socket);
      if (role === 'link' && linkId) {
        // dropLink is identity-guarded; only report the link as gone when no
        // other socket has taken over in the meantime. The displaced socket's
        // close arrives AFTER its replacement registered - without this
        // guard, that stale close would flip a freshly reconnected link
        // session back to 'stopped' ("Host offline" in the app).
        hub.dropLink(linkId, socket);
        if (!hub.hasLink(linkId)) manager.linkDisconnected(linkId);
      }
    });
    socket.on('error', () => {
      hub.remove(socket);
      if (role === 'link' && linkId) {
        hub.dropLink(linkId, socket);
        if (!hub.hasLink(linkId)) manager.linkDisconnected(linkId);
      }
    });

    async function handle(msg: ClientMessage): Promise<void> {
      switch (msg.type) {
        case 'hello':
          return;
        case 'session.create': {
          // msg.branch wird als Basis-Branch an `git clone --branch` gereicht
          // (sessions.ts provision) - dieselbe Prüfung wie in repo.add, damit
          // kein Wildwuchs/Sonderzeichen bis ans git-Kommando durchschlägt.
          if (msg.branch !== undefined && !REPO_BRANCH_RE.test(msg.branch)) {
            send({ type: 'error', requestId: msg.requestId, message: 'invalid branch name' });
            return;
          }
          try {
            const row = manager.createSession(msg);
            send({ type: 'request.ok', requestId: msg.requestId, payload: { sessionId: row.id } });
          } catch (e) {
            send({ type: 'error', requestId: msg.requestId, message: errText(e) });
          }
          return;
        }
        case 'session.prompt':
          await manager
            .prompt(msg.sessionId, msg.text, msg.mode, msg.messageId)
            .then(() => {
              // requestId is opt-in: older clients that never send one keep the
              // original fire-and-forget behaviour (no ack on success either).
              // The messageId is echoed back in the payload so the app can match
              // the ack to the exact turn it admitted (KILO-CLOUD-ANALYSE.md P1).
              if (msg.requestId)
                send({
                  type: 'request.ok',
                  requestId: msg.requestId,
                  payload: { sessionId: msg.sessionId, ...(msg.messageId ? { messageId: msg.messageId } : {}) },
                });
            })
            .catch((e) =>
              send({
                type: 'error',
                ...(msg.requestId ? { requestId: msg.requestId } : {}),
                sessionId: msg.sessionId,
                message: errText(e),
              }),
            );
          return;
        case 'session.update': {
          try {
            // updateSession hat die aktualisierte Session bereits an alle
            // Geräte gesendet; hier wird nur der Anfragende quittiert.
            const session = manager.updateSession(msg);
            send({ type: 'request.ok', requestId: msg.requestId, payload: { session } });
          } catch (e) {
            send({ type: 'error', requestId: msg.requestId, sessionId: msg.sessionId, message: errText(e) });
          }
          return;
        }
        case 'session.models.get': {
          try {
            const models = await manager.models(msg.sessionId);
            send({ type: 'session.models', requestId: msg.requestId, sessionId: msg.sessionId, models });
          } catch (e) {
            send({ type: 'error', requestId: msg.requestId, sessionId: msg.sessionId, message: errText(e) });
          }
          return;
        }
        case 'session.permission':
          await manager.permission(msg.sessionId, msg.permissionId, msg.decision).catch((e) =>
            send({ type: 'error', sessionId: msg.sessionId, message: errText(e) }),
          );
          return;
        case 'session.abort':
          await manager.abort(msg.sessionId).catch((e) =>
            send({ type: 'error', sessionId: msg.sessionId, message: errText(e) }),
          );
          return;
        case 'session.stop':
          await manager.stopSession(msg.sessionId).catch((e) =>
            send({ type: 'error', sessionId: msg.sessionId, message: errText(e) }),
          );
          return;
        case 'session.resume':
          await manager.resumeSession(msg.sessionId).catch((e) =>
            send({ type: 'error', sessionId: msg.sessionId, message: errText(e) }),
          );
          return;
        case 'session.push':
          await manager.push(msg.sessionId).catch((e) =>
            send({ type: 'error', sessionId: msg.sessionId, message: errText(e) }),
          );
          return;
        case 'session.diff.get': {
          try {
            const diff = await manager.diff(msg.sessionId);
            send({ type: 'session.diff', requestId: msg.requestId, sessionId: msg.sessionId, diff });
          } catch (e) {
            send({ type: 'error', requestId: msg.requestId, message: errText(e) });
          }
          return;
        }
        case 'session.list':
          // archived sessions ride along on purpose (see Store.listSessions)
          send({ type: 'session.list', requestId: msg.requestId, sessions: manager.listSessions() });
          return;
        case 'session.events.get': {
          try {
            const events = manager.sessionEvents(msg.sessionId, msg.limit);
            send({ type: 'session.events', requestId: msg.requestId, sessionId: msg.sessionId, events });
          } catch (e) {
            send({ type: 'error', requestId: msg.requestId, sessionId: msg.sessionId, message: errText(e) });
          }
          return;
        }
        case 'session.turns.get': {
          try {
            const turns = manager.turns(msg.sessionId, msg.limit);
            send({ type: 'session.turns', requestId: msg.requestId, sessionId: msg.sessionId, turns });
          } catch (e) {
            send({ type: 'error', requestId: msg.requestId, sessionId: msg.sessionId, message: errText(e) });
          }
          return;
        }
        case 'session.rename': {
          try {
            // renameSession already broadcast the updated session
            const session = manager.renameSession(msg.sessionId, msg.title);
            send({ type: 'request.ok', requestId: msg.requestId, payload: { session } });
          } catch (e) {
            send({ type: 'error', requestId: msg.requestId, sessionId: msg.sessionId, message: errText(e) });
          }
          return;
        }
        case 'session.archive': {
          try {
            const session = await manager.archiveSession(msg.sessionId, msg.archived);
            send({ type: 'request.ok', requestId: msg.requestId, payload: { session } });
          } catch (e) {
            send({ type: 'error', requestId: msg.requestId, sessionId: msg.sessionId, message: errText(e) });
          }
          return;
        }
        case 'session.delete': {
          try {
            await manager.deleteSession(msg.sessionId);
            send({ type: 'session.deleted', requestId: msg.requestId, sessionId: msg.sessionId });
          } catch (e) {
            send({ type: 'error', requestId: msg.requestId, message: errText(e) });
          }
          return;
        }
        case 'repo.list': {
          const repos = store.listRepos('default').map((r) => ({
            id: r.id,
            fullName: r.full_name,
            defaultBranch: r.default_branch,
          }));
          send({ type: 'repo.list', requestId: msg.requestId, repos });
          return;
        }
        case 'repo.add': {
          if (!REPO_FULL_NAME_RE.test(msg.fullName) || !REPO_BRANCH_RE.test(msg.defaultBranch)) {
            send({ type: 'error', requestId: msg.requestId, message: 'invalid fullName or defaultBranch' });
            return;
          }
          try {
            const repo = store.addRepo(randomUUID(), 'default', msg.fullName, msg.defaultBranch);
            send({
              type: 'repo.added',
              requestId: msg.requestId,
              repo: { id: repo.id, fullName: repo.full_name, defaultBranch: repo.default_branch },
            });
          } catch (e) {
            send({ type: 'error', requestId: msg.requestId, message: errText(e) });
          }
          return;
        }
        case 'secret.set': {
          // Zwei Prüfungen: die Form (wie im REST-Pfad, secrets-api.ts KIND_RE -
          // eine ungeprüfte Art landet unverändert im AAD-String unten, und ein
          // ':' darin macht dessen Namensraum mehrdeutig) und die Zugehörigkeit
          // zu `SECRET_KINDS` aus dem Protokoll. In v1 stand hier nur die Form:
          // eine vertippte Art wurde stillschweigend gespeichert und tauchte in
          // der App als Secret auf, das nie eine Session erreicht.
          if (!isValidSecretKind(msg.kind)) {
            send({
              type: 'error',
              requestId: msg.requestId,
              message: 'invalid kind (expected lowercase [a-z0-9_-]{1,64})',
            });
            return;
          }
          if (!isKnownSecretKind(msg.kind)) {
            send({
              type: 'error',
              requestId: msg.requestId,
              message: `unknown secret kind "${msg.kind}" (expected one of ${SECRET_KINDS.join(', ')})`,
            });
            return;
          }
          const id = randomUUID();
          const { ciphertext, nonce } = encrypt(msg.value, `secret:default:${msg.kind}`);
          store.saveSecret(id, 'default', msg.kind, ciphertext, nonce);
          const saved = store.getSecret(id);
          if (saved) {
            send({
              type: 'secret.saved',
              requestId: msg.requestId,
              secret: { id: saved.id, kind: saved.kind, createdAt: saved.created_at },
            });
          }
          return;
        }
        case 'secret.validate': {
          // msg.value is passed straight to the provider check and never
          // stored or logged; the answer carries kind/ok/detail only.
          const result = await validateSecret(msg.kind, msg.value);
          send({
            type: 'secret.validated',
            requestId: msg.requestId,
            kind: msg.kind,
            ok: result.ok,
            ...(result.detail ? { detail: result.detail } : {}),
            ...(result.unverified ? { unverified: true } : {}),
          });
          return;
        }
        case 'secret.list': {
          const secrets = store.listSecrets('default').map((s) => ({
            id: s.id,
            kind: s.kind,
            createdAt: s.created_at,
          }));
          send({ type: 'secret.list', requestId: msg.requestId, secrets });
          return;
        }
        case 'secret.delete':
          store.deleteSecret(msg.id, 'default');
          send({ type: 'secret.deleted', requestId: msg.requestId, id: msg.id });
          return;
        case 'device.list': {
          // Single-tenant trust model: any authenticated device may list/revoke.
          const devices = store.listDevices('default').map((d) => ({
            id: d.id,
            name: d.name,
            enrolledAt: d.enrolled_at,
            online: hub.isDeviceOnline(d.id),
          }));
          send({ type: 'device.list', requestId: msg.requestId, devices });
          return;
        }
        case 'device.revoke': {
          // Single-tenant trust model: any authenticated device may revoke another device.
          store.deleteDevice(msg.deviceId);
          hub.closeDevice(msg.deviceId);
          send({ type: 'device.revoked', requestId: msg.requestId, deviceId: msg.deviceId });
          return;
        }
        case 'link.list': {
          const links = store.listLinks('default').map((l) => ({
            id: l.id,
            name: l.name,
            createdAt: l.created_at,
          }));
          send({ type: 'link.list', requestId: msg.requestId, links });
          return;
        }
        case 'link.revoke': {
          store.deleteLink(msg.linkId);
          hub.closeLink(msg.linkId);
          send({ type: 'link.revoked', requestId: msg.requestId, linkId: msg.linkId });
          return;
        }
        case 'server.stats':
          send({ type: 'server.stats', requestId: msg.requestId, stats: await manager.stats() });
          return;
        case 'fcm.register':
          if (deviceId) store.setFcmToken(deviceId, msg.token);
          return;
      }
    }
  });
}
