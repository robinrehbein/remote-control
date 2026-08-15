/**
 * PocketAgent remote-runner gateway.
 *
 * Runs as a single container ON THE RUNNER (the machine whose docker daemon
 * the orchestrator drives via DOCKER_HOST). It is the only container in the
 * setup that touches both worlds:
 *
 *   - it hangs on the default bridge network  -> has internet, and its ingress
 *     port is the single published host port of the whole runner
 *   - the orchestrator connects it to every per-session `Internal: true`
 *     network under the alias 'gateway'
 *
 * Session containers therefore never get a published port and never get direct
 * internet; the gateway is their only way in and out:
 *
 *   ingress  :8443  orchestrator -> http://<runner>:8443/s/<sessionId>/<path>
 *                   -> http://<sessionId>:8080/<path>   (docker DNS alias)
 *                   authenticated with the shared secret header
 *   egress   :3128  session container -> HTTP(S)_PROXY=http://gateway:3128
 *                   -> allowlist-filtered forward proxy (same code as the
 *                      orchestrator's in-process proxy)
 *
 * The process runs from the orchestrator image (`npx tsx src/gateway.ts`), so
 * no extra image has to be built or shipped.
 */
import * as http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  GATEWAY_AUTH_HEADER,
  GATEWAY_EGRESS_PORT,
  GATEWAY_INGRESS_PORT,
  parseAllowlist,
} from './config.js';
import { createEgressProxyServer } from './egress-proxy.js';

/** Port the session shims listen on inside their containers. */
export const SHIM_PORT = 8080;

/**
 * Session ids are used verbatim as docker network aliases, so only accept the
 * shape docker itself accepts (and that can never escape into another path
 * segment or host): alphanumeric start, then alphanumerics/._-.
 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface IngressRoute {
  sessionId: string;
  /** Absolute upstream URL inside the session network. */
  target: string;
}

/**
 * Map an ingress request URL onto the session shim behind it.
 * `/s/<sessionId>/<rest>?<query>` -> `http://<sessionId>:8080/<rest>?<query>`
 * Anything else (including a traversal attempt in <sessionId>) -> null.
 */
export function routeIngress(rawUrl: string, shimPort: number = SHIM_PORT): IngressRoute | null {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/')) return null;
  const qIdx = rawUrl.indexOf('?');
  const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
  const query = qIdx === -1 ? '' : rawUrl.slice(qIdx);
  const parts = pathname.split('/');
  // ['', 's', '<id>', ...rest]
  if (parts.length < 3 || parts[1] !== 's') return null;
  const sessionId = parts[2] ?? '';
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const rest = parts.slice(3).join('/');
  if (rest.split('/').some((seg) => seg === '.' || seg === '..')) return null;
  return { sessionId, target: `http://${sessionId}:${shimPort}/${rest}${query}` };
}

/** Constant-time comparison of the gateway shared secret. */
export function authorize(headers: http.IncomingHttpHeaders, token: string): boolean {
  if (!token) return false;
  const raw = headers[GATEWAY_AUTH_HEADER];
  const got = Array.isArray(raw) ? raw[0] : raw;
  if (typeof got !== 'string' || got.length === 0) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface IngressOptions {
  token: string;
  shimPort?: number;
}

/**
 * Reverse proxy towards the session shims. Streams both directions with plain
 * http.request piping so SSE (`/events`) passes through unbuffered: headers are
 * flushed immediately, Nagle is off, and no socket/request timeout can cut an
 * idle stream.
 */
export function createIngressServer(opts: IngressOptions): http.Server {
  const shimPort = opts.shimPort ?? SHIM_PORT;
  const server = http.createServer((req, res) => {
    if (!authorize(req.headers, opts.token)) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
      return;
    }
    const route = routeIngress(req.url ?? '', shimPort);
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('no route');
      return;
    }
    const headers = { ...req.headers };
    delete headers[GATEWAY_AUTH_HEADER];
    delete headers.host;
    delete headers.connection;

    const upstream = http.request(
      route.target,
      { method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        res.flushHeaders();
        res.socket?.setNoDelay(true);
        up.pipe(res);
      },
    );
    upstream.setTimeout(0);
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('upstream error');
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  // never time out streaming responses (SSE stays open for the session's life)
  server.timeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  server.on('connection', (s) => s.setNoDelay(true));
  return server;
}

function main(): void {
  const token = process.env.GATEWAY_TOKEN?.trim() ?? '';
  if (!token) {
    console.error('[gateway] GATEWAY_TOKEN is required');
    process.exit(1);
  }
  const allowlist = parseAllowlist(process.env.GATEWAY_ALLOWLIST ?? '');
  const ingressPort = Number(process.env.GATEWAY_INGRESS_PORT ?? GATEWAY_INGRESS_PORT);
  const egressPort = Number(process.env.GATEWAY_EGRESS_PORT ?? GATEWAY_EGRESS_PORT);

  const ingress = createIngressServer({ token });
  ingress.on('error', (e) => console.error(`[gateway] ingress error: ${String(e)}`));
  ingress.listen(ingressPort, '0.0.0.0', () =>
    console.log(`[gateway] ingress listening on :${ingressPort}`),
  );

  const egress = createEgressProxyServer(allowlist);
  egress.on('error', (e) => console.error(`[gateway] egress error: ${String(e)}`));
  egress.listen(egressPort, '0.0.0.0', () =>
    console.log(`[gateway] egress proxy listening on :${egressPort} (${allowlist.length} hosts allowed)`),
  );

  const shutdown = (): void => {
    ingress.close();
    egress.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const argv1 = process.argv[1] ?? '';
if (argv1.endsWith('gateway.ts') || argv1.endsWith('gateway.js')) main();
