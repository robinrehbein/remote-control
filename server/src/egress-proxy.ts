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

export interface EgressProxyOptions {
  port?: number;
  allowlist?: string[];
}

function forbidden(socket: net.Socket): void {
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
}

type TokenValidator = (token: string) => boolean;

let tokenValidator: TokenValidator | null = null;

/**
 * Register the per-session token validator used to gate proxy access (the
 * SessionManager passes any live session's shim_token). While unset (smoke /
 * dev) the proxy keeps accepting unauthenticated requests.
 */
export function setEgressTokenValidator(fn: ((token: string) => boolean) | null): void {
  tokenValidator = fn;
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

function proxyAuthorized(req: http.IncomingMessage): boolean {
  if (!tokenValidator) return true;
  const header = req.headers['proxy-authorization'];
  const token = parseProxyAuth(Array.isArray(header) ? header[0] : header);
  return token !== null && tokenValidator(token);
}

export function startEgressProxy(opts: EgressProxyOptions = {}): http.Server {
  const port = opts.port ?? config.egressProxyPort;
  const allowlist = opts.allowlist ?? config.networkAllowlist;

  const server = http.createServer((req, res) => {
    if (!proxyAuthorized(req)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    let target: URL;
    try {
      target = new URL(req.url ?? '/');
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    if (!hostAllowed(target.hostname, allowlist)) {
      res.writeHead(403).end('host not allowed');
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
    if (
      !proxyAuthorized(req) ||
      (portNum !== 443 && portNum !== 80) ||
      !hostAllowed(host, allowlist)
    ) {
      forbidden(socket);
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

  server.listen(port, '0.0.0.0');
  return server;
}
