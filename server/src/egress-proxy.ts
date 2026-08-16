/**
 * Minimal egress proxy for session network policy "allowlist".
 *
 * Session containers live in internal docker networks (no direct internet)
 * and reach the outside world only through this proxy, which the
 * orchestrator runs in-process. Only HTTP(S) to allowlisted hosts passes:
 *  - CONNECT host:443|80  -> raw TCP tunnel (proxy resolves DNS)
 *  - plain proxy GET etc. -> forwarded via node http/https
 * Anything else gets a 403.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { config } from './config.js';

/**
 * Host match against an allowlist. Entries are lowercased; an entry without
 * '*' must match exactly, an entry '*.example.com' matches any subdomain
 * (foo.example.com) but not the apex (example.com).
 */
export function hostAllowed(host: string, allowlist: string[]): boolean {
  const h = host.trim().toLowerCase();
  if (!h) return false;
  for (const raw of allowlist) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1);
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    } else if (h === entry) {
      return true;
    }
  }
  return false;
}

export type TokenValidator = (token: string) => boolean;

/**
 * Source-address gate: true when an IP belongs to a live session container.
 * The token gate alone makes egress depend on every HTTP client forwarding the
 * userinfo of HTTP(S)_PROXY as Proxy-Authorization - git does, node/undici does
 * not - so a session whose agent uses fetch() would see every request denied
 * with "no proxy credentials". The peer IP is known to the orchestrator through
 * the docker daemon and needs no client cooperation at all.
 */
export type PeerValidator = (ip: string) => boolean;

export interface EgressProxyOptions {
  port?: number;
  allowlist?: string[];
  /** Per-session token gate (Proxy-Authorization); unset = accept unauthenticated. */
  tokenValidator?: TokenValidator;
  /** Peer-IP gate; unset (remote gateway: no docker access) = token only. */
  peerValidator?: PeerValidator;
}

/**
 * Source address in the form docker reports container IPs in: node hands out an
 * IPv4 peer of a dual-stack listener as '::ffff:10.0.0.5', and a link-local
 * address carries a zone id the daemon never mentions.
 */
export function normalizePeerIp(ip: string | undefined | null): string {
  const raw = (ip ?? '').trim().toLowerCase();
  if (!raw) return '';
  const bare = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  const zone = bare.indexOf('%');
  const noZone = zone === -1 ? bare : bare.slice(0, zone);
  return noZone.startsWith('::ffff:') && noZone.includes('.') ? noZone.slice('::ffff:'.length) : noZone;
}

function forbidden(socket: net.Socket): void {
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
}

/** 407 (not 403) so a client can tell "authenticate" from "not allowed". */
function proxyAuthRequired(socket: net.Socket): void {
  socket.end(
    'HTTP/1.1 407 Proxy Authentication Required\r\n' +
      'Proxy-Authenticate: Basic realm="pocketagent"\r\n' +
      'Connection: close\r\n\r\n',
  );
}

export type DenyReason = 'auth' | 'port' | 'host';

/**
 * Why a request was refused, or null when it passes. A denial is otherwise
 * invisible: the caller only sees "CONNECT tunnel failed, response 403", which
 * says nothing about which gate closed.
 *
 * `port` is only gated for CONNECT (an opaque tunnel to an arbitrary port is
 * the actual risk); pass null for forwarded plain-HTTP requests, which the
 * proxy parses and may address any port.
 */
export function denyReason(
  authorized: boolean,
  host: string,
  port: number | null,
  allowlist: string[],
): DenyReason | null {
  if (!authorized) return 'auth';
  if (port !== null && port !== 443 && port !== 80) return 'port';
  if (!hostAllowed(host, allowlist)) return 'host';
  return null;
}

/**
 * Outcome of both gates for one request. Kept together because a denial is only
 * diagnosable with all of it: whether credentials were sent at all, and whether
 * the caller's address could be tied to a live session container.
 */
interface AuthResult {
  authorized: boolean;
  hadToken: boolean;
  /** normalized source address ('' when the socket reports none) */
  peer: string;
  /** whether the peer belongs to a live session; null = no peer gate configured */
  peerKnown: boolean | null;
}

function logDenial(method: string, host: string, port: number, reason: DenyReason, auth: AuthResult): void {
  const detail = reason === 'auth' ? (auth.hadToken ? 'token not accepted' : 'no proxy credentials') : reason;
  const peer = `peer=${auth.peer === '' ? 'unknown' : auth.peer}`;
  const session = auth.peerKnown === null ? '' : ` session=${auth.peerKnown ? 'yes' : 'no'}`;
  console.warn(`[egress] denied ${method} ${host}:${port} (${detail}, ${peer}${session})`);
}

/**
 * Extract the proxy-auth token from a Proxy-Authorization header value:
 * 'Bearer <t>' or 'Basic <base64 of "pa:<t>">'. Malformed values -> null.
 */
export function parseProxyAuth(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^(\w+)\s+(\S+)\s*$/.exec(header.trim());
  if (!m) return null;
  const [, scheme, value] = m as unknown as [string, string, string];
  if (scheme.toLowerCase() === 'bearer') return value;
  if (scheme.toLowerCase() === 'basic') {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i === -1) return null;
    return decoded.slice(i + 1);
  }
  return null;
}

/**
 * A caller passes with EITHER a live session's token OR a source address that
 * belongs to a live session container - the two gates are independent on
 * purpose (defense in depth, and neither alone survives every client).
 */
function proxyAuthorized(
  req: http.IncomingMessage,
  peerIp: string | undefined,
  tokenValidator: TokenValidator | undefined,
  peerValidator: PeerValidator | undefined,
): AuthResult {
  const header = req.headers['proxy-authorization'];
  const peer = normalizePeerIp(peerIp);
  const peerKnown = peerValidator === undefined ? null : peer !== '' && peerValidator(peer);
  const base = { hadToken: header !== undefined, peer, peerKnown };
  if (!tokenValidator) return { authorized: true, ...base };
  if (peerKnown === true) return { authorized: true, ...base };
  const token = parseProxyAuth(Array.isArray(header) ? header[0] : header);
  return { authorized: token !== null && tokenValidator(token), ...base };
}

/**
 * Build the proxy server without binding it. Used in-process by the
 * orchestrator (local mode, with a per-session token validator and the peer-IP
 * gate the daemon feeds) and standalone by the remote gateway container
 * (server/src/gateway.ts: no docker access, so no peerValidator; ingress auth
 * via GATEWAY_TOKEN instead) — identical filtering logic in both.
 */
export function createEgressProxyServer(
  allowlist: string[],
  tokenValidator?: TokenValidator,
  peerValidator?: PeerValidator,
): http.Server {
  const server = http.createServer((req, res) => {
    const auth = proxyAuthorized(req, req.socket.remoteAddress, tokenValidator, peerValidator);
    let target: URL;
    try {
      target = new URL(req.url ?? '/');
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    const port = target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80;
    const reason = denyReason(auth.authorized, target.hostname, null, allowlist);
    if (reason !== null) {
      logDenial(req.method ?? 'GET', target.hostname, port, reason, auth);
      if (reason === 'auth') {
        res.writeHead(407, { 'proxy-authenticate': 'Basic realm="pocketagent"' }).end('proxy auth required');
      } else {
        res.writeHead(403).end(`${reason} not allowed`);
      }
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    const upstream = (target.protocol === 'https:' ? https : http).request(
      target,
      { method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('upstream error');
    });
    req.pipe(upstream);
  });

  server.on('connect', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const url = String(req.url ?? '');
    const idx = url.lastIndexOf(':');
    const host = idx === -1 ? url : url.slice(0, idx);
    const portNum = idx === -1 ? 443 : Number(url.slice(idx + 1));
    const auth = proxyAuthorized(req, socket.remoteAddress, tokenValidator, peerValidator);
    const reason = denyReason(auth.authorized, host, portNum, allowlist);
    if (reason !== null) {
      logDenial('CONNECT', host, portNum, reason, auth);
      if (reason === 'auth') proxyAuthRequired(socket);
      else forbidden(socket);
      return;
    }
    const upstream = net.connect({ host, port: portNum }, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => {
      if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    socket.on('error', () => upstream.destroy());
  });

  return server;
}

export function startEgressProxy(opts: EgressProxyOptions = {}): http.Server {
  const port = opts.port ?? config.egressProxyPort;
  const allowlist = opts.allowlist ?? config.networkAllowlist;
  const server = createEgressProxyServer(allowlist, opts.tokenValidator, opts.peerValidator);
  server.listen(port, '0.0.0.0');
  return server;
}
