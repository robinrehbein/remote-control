import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@pocketagent/protocol';
import { SERVER_VERSION } from './config.js';
import { sha256 } from './db.js';
import type { Store } from './db.js';
import { listAdapters } from './adapters.js';
import type { SessionManager } from './sessions.js';
import { encrypt } from './vault.js';

export class Hub {
  private readonly sockets = new Set<WebSocket>();
  private readonly linkSockets = new Map<string, WebSocket>();
  private readonly pendingLinkCalls = new Map<
    string,
    { resolve: (v: { status: number; body?: unknown } | null) => void; timer: NodeJS.Timeout }
  >();

  add(s: WebSocket): void {
    this.sockets.add(s);
  }

  remove(s: WebSocket): void {
    this.sockets.delete(s);
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
    this.linkSockets.get(linkId)?.close(4000, 'replaced');
    this.linkSockets.set(linkId, socket);
  }

  dropLink(linkId: string, socket: WebSocket): void {
    if (this.linkSockets.get(linkId) === socket) this.linkSockets.delete(linkId);
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
      this.pendingLinkCalls.set(callId, { resolve, timer });
      try {
        socket.send(JSON.stringify({ type: 'agent.command', sessionId: linkId, callId, path, method, body }));
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
      socket.send(JSON.stringify({ type: 'agent.bye', sessionId: linkId }));
    } catch {
      /* closed */
    }
  }
}

type FcmRegisterMessage = { type: 'fcm.register'; token: string };
type AppClientMessage = ClientMessage | FcmRegisterMessage;
/** Incoming frames on a link socket (link -> server uses ServerMessage variants). */
type LinkInMessage = Extract<
  ServerMessage,
  { type: 'agent.response' | 'agent.event' | 'agent.ping' | 'agent.pong' }
>;
type SocketInMessage = AppClientMessage | LinkInMessage;

export function registerWs(
  app: FastifyInstance,
  store: Store,
  manager: SessionManager,
  hub: Hub,
): void {
  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    let authed = false;
    let role: 'device' | 'link' = 'device';
    let deviceId: string | null = null;
    let linkId: string | null = null;

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
            socket.close(4001, 'unauthorized');
            return;
          }
          authed = true;
          role = 'link';
          linkId = link.id;
          hub.registerLink(link.id, socket);
          const sessionId = manager.registerLinkSession(link, msg);
          send({ type: 'agent.ready', sessionId });
          return;
        }
        if (msg.type !== 'hello') {
          socket.close(4001, 'unauthorized');
          return;
        }
        const dev = store.getDevice(msg.deviceId);
        if (!dev || dev.token_hash !== sha256(msg.token)) {
          socket.close(4001, 'unauthorized');
          return;
        }
        authed = true;
        deviceId = dev.id;
        hub.add(socket);
        send({ type: 'welcome', ok: true, serverVersion: SERVER_VERSION });
        return;
      }
      if (role === 'link') {
        if (msg.type === 'agent.response') {
          hub.resolveLinkCall(msg.callId, msg.status, msg.body);
          return;
        }
        if (msg.type === 'agent.event') {
          manager.handleLinkEvent(msg.sessionId, msg.event);
          return;
        }
        if (msg.type === 'agent.ping') {
          send({ type: 'agent.pong', ts: msg.ts });
          return;
        }
        return;
      }
      if (
        msg.type === 'agent.response' ||
        msg.type === 'agent.event' ||
        msg.type === 'agent.ping' ||
        msg.type === 'agent.pong' ||
        msg.type === 'agent.hello'
      ) {
        return;
      }
      void handle(msg).catch((e) => send({ type: 'error', message: errText(e) }));
    });

    socket.on('close', () => {
      hub.remove(socket);
      if (role === 'link' && linkId) {
        hub.dropLink(linkId, socket);
        manager.linkDisconnected(linkId);
      }
    });
    socket.on('error', () => {
      hub.remove(socket);
      if (role === 'link' && linkId) {
        hub.dropLink(linkId, socket);
        manager.linkDisconnected(linkId);
      }
    });

    async function handle(msg: AppClientMessage): Promise<void> {
      switch (msg.type) {
        case 'hello':
          return;
        case 'session.create': {
          try {
            const row = manager.createSession(msg);
            send({ type: 'request.ok', requestId: msg.requestId, payload: { sessionId: row.id } });
          } catch (e) {
            send({ type: 'error', requestId: msg.requestId, message: errText(e) });
          }
          return;
        }
        case 'session.prompt':
          await manager.prompt(msg.sessionId, msg.text, msg.mode).catch((e) =>
            send({ type: 'error', sessionId: msg.sessionId, message: errText(e) }),
          );
          return;
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
          send({ type: 'session.list', requestId: msg.requestId, sessions: manager.listSessions() });
          return;
        case 'session.delete': {
          try {
            await manager.deleteSession(msg.sessionId);
            send({ type: 'session.deleted', requestId: msg.requestId, sessionId: msg.sessionId });
          } catch (e) {
            send({ type: 'error', requestId: msg.requestId, message: errText(e) });
          }
          return;
        }
        case 'adapter.list':
          send({ type: 'adapter.list', requestId: msg.requestId, adapters: listAdapters() });
          return;
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
          const id = randomUUID();
          const { ciphertext, nonce } = encrypt(msg.value);
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
