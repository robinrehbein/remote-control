import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { Server as HttpServer } from 'node:http';
import type { PairingConfirmBody } from '@pocketagent/protocol';
import { SERVER_VERSION, config } from './config.js';
import { Store } from './db.js';
import { SessionManager } from './sessions.js';
import { Hub, registerWs } from './ws.js';
import { confirmPairing, generatePairingCode, adminTokenOk } from './pairing.js';
import { startEgressProxy } from './egress-proxy.js';

export interface App {
  app: ReturnType<typeof Fastify>;
  store: Store;
  manager: SessionManager;
  hub: Hub;
}

export async function buildApp(): Promise<App> {
  const app = Fastify({ logger: false });
  const store = new Store();
  const hub = new Hub();
  const manager = new SessionManager(store, (m) => hub.broadcast(m));
  manager.setLinkTransport({
    call: (linkId, path, method, body) => hub.callLink(linkId, path, method, body),
    isConnected: (linkId) => hub.hasLink(linkId),
    bye: (linkId) => hub.byeLink(linkId),
  });

  app.get('/api/health', async () => ({
    ok: true,
    version: SERVER_VERSION,
    docker: config.dockerEnabled,
  }));

  app.post('/api/pairing/confirm', async (req, reply) => {
    const body = req.body as PairingConfirmBody | undefined;
    const res = body ? confirmPairing(store, body) : null;
    if (!res) return reply.code(400).send({ ok: false, error: 'invalid or expired code' });
    return res;
  });

  app.post('/api/pairing/create', async (req, reply) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!adminTokenOk(token)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const ttlMs = 10 * 60_000;
    const code = generatePairingCode(store);
    return { ok: true, code, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
  });

  await app.register(websocket);
  registerWs(app, store, manager, hub);

  return { app, store, manager, hub };
}

export async function main(): Promise<void> {
  const { app, manager } = await buildApp();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[orchestrator] listening on :${config.port} (docker=${config.dockerEnabled})`);
  let egress: HttpServer | null = null;
  if (config.dockerEnabled) {
    try {
      egress = startEgressProxy();
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
