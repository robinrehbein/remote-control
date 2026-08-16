import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Server as HttpServer } from 'node:http';
import type { PairingConfirmBody } from '@pocketagent/protocol';
import { SERVER_VERSION, config } from './config.js';
import { Store } from './db.js';
import { SessionManager } from './sessions.js';
import { Heartbeat, Hub, registerWs } from './ws.js';
import { confirmPairing, generatePairingCode, adminTokenOk, SlidingWindowRateLimiter } from './pairing.js';
import { registerSecretsApi } from './secrets-api.js';
import { startEgressProxy } from './egress-proxy.js';

export interface App {
  app: ReturnType<typeof Fastify>;
  store: Store;
  manager: SessionManager;
  hub: Hub;
  heartbeat: Heartbeat;
}

/** Security audit line (stdout-warn JSON; never log full pairing codes or tokens). */
export function auditWarn(kind: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ ts: new Date().toISOString(), ev: 'auth.fail', kind, ...fields }));
}

export async function buildApp(): Promise<App> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const store = new Store();
  const hub = new Hub();
  const heartbeat = new Heartbeat();
  const manager = new SessionManager(store, (m) => hub.broadcast(m));
  manager.setLinkTransport({
    call: (linkId, path, method, body) => hub.callLink(linkId, path, method, body),
    isConnected: (linkId) => hub.hasLink(linkId),
    bye: (linkId) => hub.byeLink(linkId),
  });

  // Pairing endpoints are brute-force targets: 10 req/min per client IP and
  // 60 req/min globally, both as sliding windows.
  const ipLimiter = new SlidingWindowRateLimiter(60_000, 10);
  const globalLimiter = new SlidingWindowRateLimiter(60_000, 60);
  const pairingRateLimit = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!ipLimiter.allow(req.ip) || !globalLimiter.allow('global')) {
      await reply.code(429).send({ ok: false, error: 'rate limited' });
    }
  };

  app.get('/api/health', async () => ({
    ok: true,
    version: SERVER_VERSION,
    docker: config.dockerEnabled,
  }));

  app.post('/api/pairing/confirm', { preHandler: pairingRateLimit }, async (req, reply) => {
    const body = req.body as PairingConfirmBody | undefined;
    const res = body ? confirmPairing(store, body) : null;
    if (!res) {
      // Log only the first 4 chars of the submitted code, never the full code.
      auditWarn('pairing.confirm', { ip: req.ip, codePrefix: String(body?.code ?? '').slice(0, 4) });
      return reply.code(400).send({ ok: false, error: 'invalid or expired code' });
    }
    return res;
  });

  app.post('/api/pairing/create', { preHandler: pairingRateLimit }, async (req, reply) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!adminTokenOk(token)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const ttlMs = 10 * 60_000;
    const code = generatePairingCode(store);
    return { ok: true, code, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
  });

  registerSecretsApi(app, store);

  // maxPayload: reject WS frames larger than 1 MiB at the protocol level.
  await app.register(websocket, { options: { maxPayload: 1048576 } });
  registerWs(app, store, manager, hub, heartbeat);

  // A redeploy starts a fresh orchestrator container next to the still running
  // session containers: reconnect it to their networks and event streams.
  // Deliberately not awaited - the server must come up either way.
  void manager.reconcile().catch((e: unknown) => {
    console.error(`[orchestrator] session reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
  });

  return { app, store, manager, hub, heartbeat };
}

export async function main(): Promise<void> {
  const { app, manager, heartbeat } = await buildApp();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[orchestrator] listening on :${config.port} (docker=${config.dockerEnabled})`);
  let egress: HttpServer | null = null;
  if (config.dockerEnabled) {
    try {
      // Two gates: a live session's shim token, or the source IP of a live
      // session container (clients that drop the proxy URL's userinfo).
      egress = startEgressProxy({
        tokenValidator: (t) => manager.egressTokenAllowed(t),
        peerValidator: (ip) => manager.egressPeerAllowed(ip),
      });
      egress.on('error', (e) => console.error(`[orchestrator] egress proxy error: ${String(e)}`));
      console.log(`[orchestrator] egress proxy listening on :${config.egressProxyPort}`);
    } catch (e) {
      console.error(`[orchestrator] egress proxy failed to start: ${String(e)}`);
    }
  }
  manager.start();
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    manager.shutdown();
    heartbeat.stop();
    egress?.close();
    void app.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const argv1 = process.argv[1] ?? '';
if (argv1.endsWith('index.ts') || argv1.endsWith('index.js')) {
  void main();
}
