/**
 * Minimal egress proxy for the session network policies.
 *
 * Session containers live in internal docker networks (no direct internet)
 * and reach the outside world only through this proxy, which the
 * orchestrator runs in-process. Only HTTP(S) to allowlisted hosts passes:
 *  - CONNECT host:443|80  -> raw TCP tunnel (proxy resolves DNS)
 *  - plain proxy GET etc. -> forwarded via node http/https
 * Anything else gets a 403.
 *
 * Every request runs through three gates, in this order:
 *  1. identity - which session is calling (source address, else proxy token)
 *  2. policy   - an 'isolated' session never egresses, whatever it presents
 *  3. target   - allowlisted host, allowed port, and an address outside every
 *                private/loopback/link-local range (SSRF, DNS rebinding)
 */
import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { NetworkPolicy } from '@pocketagent/protocol';
import { config, isNetworkPolicy } from './config.js';

/** Ports a session may address through the proxy (both paths). */
export const DEFAULT_EGRESS_PORTS: readonly number[] = [80, 443];

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

/**
 * The session behind a request, as far as the proxy can tell. Its policy is
 * what decides whether the request may leave at all - the network alone cannot
 * decide it, because the orchestrator hangs on the internal networks of *every*
 * session, isolated ones included.
 */
export interface EgressSession {
  id: string;
  policy: NetworkPolicy;
}

/** 'isolated' means exactly that: no egress, not even to allowlisted hosts. */
export function policyAllowsEgress(policy: NetworkPolicy): boolean {
  return policy !== 'isolated';
}

/** Token gate: the live session a proxy token belongs to, or null. */
export type TokenValidator = (token: string) => EgressSession | null;

/**
 * Source-address gate: the live session container an IP belongs to, or null.
 * The token gate alone makes egress depend on every HTTP client forwarding the
 * userinfo of HTTP(S)_PROXY as Proxy-Authorization - git does, node/undici does
 * not - so a session whose agent uses fetch() would see every request denied
 * with "no proxy credentials". The peer IP is known to the orchestrator through
 * the docker daemon and needs no client cooperation at all.
 */
export type PeerValidator = (ip: string) => EgressSession | null;

export interface EgressProxyOptions {
  port?: number;
  allowlist?: string[];
  ports?: readonly number[];
  /** Per-session token gate (Proxy-Authorization); unset = accept unauthenticated. */
  tokenValidator?: TokenValidator;
  /** Peer-IP gate; unset (no docker access) = token only. */
  peerValidator?: PeerValidator;
}

/** Everything the filtering logic needs; see createEgressProxyServer. */
export interface EgressGateOptions {
  allowlist: string[];
  /** Destination ports a session may address (default 80/443). */
  ports?: readonly number[];
  tokenValidator?: TokenValidator;
  peerValidator?: PeerValidator;
  /**
   * The target check, defaulting to resolveTarget. Only the tests replace it -
   * connecting through a real DNS answer whose first address is dead is not
   * reproducible otherwise. Whatever it returns is what the proxy connects to,
   * so a replacement carries the same responsibility as resolveTarget itself.
   */
  resolve?: TargetResolver;
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

/** SHA-256 of a proxy token - what the gates compare, never the token itself. */
export function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** One entry of a token table: the digest of a token and what it unlocks. */
export interface TokenEntry<T> {
  digest: Buffer;
  value: T;
}

/**
 * Constant-time lookup in a table of token digests. Every entry is compared and
 * no loop exits early, so neither the position of a hit nor the shape of a
 * near-miss shows up in the runtime; hashing first keeps the comparison itself
 * free of the secret.
 */
export function matchTokenDigest<T>(token: string, entries: readonly TokenEntry<T>[]): T | null {
  const probe = tokenDigest(token);
  let hit: T | null = null;
  for (const entry of entries) {
    if (entry.digest.length === probe.length && timingSafeEqual(entry.digest, probe)) hit = entry.value;
  }
  return hit;
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

export type DenyReason = 'auth' | 'policy' | 'port' | 'host' | 'address';

/**
 * Why a request was refused, or null when it passes. A denial is otherwise
 * invisible: the caller only sees "CONNECT tunnel failed, response 403", which
 * says nothing about which gate closed.
 *
 * 'address' is not decided here - it needs the DNS answer (see resolveTarget).
 */
export function denyReason(
  auth: { authorized: boolean; session: EgressSession | null },
  host: string,
  port: number,
  allowlist: string[],
  ports: readonly number[] = DEFAULT_EGRESS_PORTS,
): DenyReason | null {
  if (!auth.authorized) return 'auth';
  if (auth.session !== null && !policyAllowsEgress(auth.session.policy)) return 'policy';
  if (!ports.includes(port)) return 'port';
  if (!hostAllowed(host, allowlist)) return 'host';
  return null;
}

/**
 * Outcome of the identity gates for one request. Kept together because a denial
 * is only diagnosable with all of it: whether credentials were sent at all, and
 * which side (address or token) could name the session behind the request.
 */
interface AuthResult {
  authorized: boolean;
  hadToken: boolean;
  /** normalized source address ('' when the socket reports none) */
  peer: string;
  /** the session the caller was identified as; null = none could be named */
  session: EgressSession | null;
  /** how it was identified - 'ungated' = this proxy runs without any validator */
  via: 'peer' | 'token' | 'none' | 'ungated';
}

function logDenial(method: string, host: string, port: number, reason: DenyReason, auth: AuthResult): void {
  const detail = reason === 'auth' ? (auth.hadToken ? 'token not accepted' : 'no proxy credentials') : reason;
  const peer = `peer=${auth.peer === '' ? 'unknown' : auth.peer}`;
  const session =
    auth.session === null ? ' session=none' : ` session=${auth.session.id.slice(0, 8)}/${auth.session.policy} (${auth.via})`;
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
 * Name the session behind a request. The source address decides whenever it
 * resolves: it is the one claim a container cannot forge, so a token borrowed
 * from another session can never lift the caller's own network policy. Only a
 * peer the daemon does not know falls back to the token gate (node/undici drop
 * the userinfo of HTTP(S)_PROXY, so a token is not always available either).
 */
function proxyAuthorized(
  req: http.IncomingMessage,
  peerIp: string | undefined,
  tokenValidator: TokenValidator | undefined,
  peerValidator: PeerValidator | undefined,
): AuthResult {
  const header = req.headers['proxy-authorization'];
  const peer = normalizePeerIp(peerIp);
  const base = { hadToken: header !== undefined, peer };
  const byPeer = peerValidator !== undefined && peer !== '' ? peerValidator(peer) : null;
  if (byPeer !== null) return { authorized: true, ...base, session: byPeer, via: 'peer' };
  if (tokenValidator === undefined) {
    // No gate configured at all (a proxy that trusts its network); a configured
    // peer gate that did not answer stays a denial.
    if (peerValidator === undefined) return { authorized: true, ...base, session: null, via: 'ungated' };
    return { authorized: false, ...base, session: null, via: 'none' };
  }
  const token = parseProxyAuth(Array.isArray(header) ? header[0] : header);
  const byToken = token === null ? null : tokenValidator(token);
  if (byToken !== null) return { authorized: true, ...base, session: byToken, via: 'token' };
  return { authorized: false, ...base, session: null, via: 'none' };
}

/**
 * Hop-by-hop headers (RFC 7230 §6.1, RFC 7235) never travel to the next hop.
 * The one that matters here is proxy-authorization: it carries the session's
 * shim token - the same secret the shim API is authenticated with - so
 * forwarding it hands every plain-HTTP allowlist host (or anyone able to MITM
 * one) a working session credential.
 */
const HOP_BY_HOP = [
  'connection',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'keep-alive',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
];

/** Request headers minus everything that belongs to this hop only. */
export function forwardableHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers };
  const listed = String(headers.connection ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  for (const name of [...HOP_BY_HOP, ...listed]) delete out[name];
  return out;
}

/**
 * Addresses no session may reach through the proxy, whatever a name resolves
 * to: loopback, the unspecified address, link-local (169.254/16 carries the
 * cloud metadata service, fe80::/10), the private and CGNAT ranges, ULA and
 * everything multicast/reserved. Anything unparseable counts as internal.
 */
export function isInternalAddress(raw: string): boolean {
  const ip = normalizePeerIp(raw);
  if (ip === '') return true;
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map((p) => Number(p));
    const [a = 0, b = 0, c = 0] = o;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 169 && b === 254) return true; // link-local + metadata service
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast, reserved, broadcast
    return false;
  }
  if (!net.isIPv6(ip)) return true;
  // '::', '::1' and everything else in ::/16 (nothing routable lives there;
  // IPv4-mapped forms were already folded into their IPv4 shape above).
  if (ip.startsWith('::')) return true;
  const head = Number.parseInt(ip.split(':')[0] ?? '', 16);
  if (!Number.isFinite(head)) return true;
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** One address a request may be pinned to after the target check. */
export interface PinnedTarget {
  address: string;
  family: 4 | 6;
}

export type ResolveOutcome = { ok: true; targets: PinnedTarget[] } | { ok: false; reason: 'address' | 'dns' };

/** The target check as the proxy calls it; see resolveTarget. */
export type TargetResolver = (host: string, allowlist: string[]) => Promise<ResolveOutcome>;

/**
 * The DNS answer resolveTarget decides on. Injectable so the ordering and the
 * filtering can be tested without a name that really resolves both ways.
 */
export type AddressLookup = (host: string) => Promise<readonly { address: string; family: number }[]>;

const systemLookup: AddressLookup = (host) => dns.promises.lookup(host, { all: true });

/** An IP literal counts as an internal target only the operator may name. */
function listedVerbatim(host: string, allowlist: string[]): boolean {
  const h = host.trim().toLowerCase();
  return allowlist.some((entry) => entry.trim().toLowerCase() === h);
}

/**
 * Resolve a target host once and decide which of its addresses may be reached.
 * The returned addresses are what the connection is pinned to: resolving again
 * at connect time would leave the classic rebinding window between the checked
 * and the connected address open.
 *
 * *Every* checked address is returned, not just the first one, because pinning
 * to a single one turns a partly reachable host into an unreachable one: a name
 * with an AAAA record hands back an IPv6 address that a container without a
 * global IPv6 route can never reach, and the A record next to it never gets
 * tried. Connecting by name left that to the kernel's happy eyeballs; the list
 * gives the connect paths the same second chance without a second resolve.
 * IPv4 comes first for the same pragmatic reason - session containers usually
 * have IPv4 only, so the address most likely to work is tried first.
 *
 * A host that is already an IP literal is only reachable when the operator put
 * exactly that literal into the allowlist - that, and only that, is how an
 * internal target gets through (an on-prem mirror, the loopback upstreams in
 * the tests). A *name* can never resolve into internal space.
 */
export async function resolveTarget(
  host: string,
  allowlist: string[],
  lookup: AddressLookup = systemLookup,
): Promise<ResolveOutcome> {
  const literal = net.isIP(host);
  if (literal !== 0) {
    if (listedVerbatim(host, allowlist) || !isInternalAddress(host)) {
      return { ok: true, targets: [{ address: host, family: literal === 6 ? 6 : 4 }] };
    }
    return { ok: false, reason: 'address' };
  }
  const addrs = await lookup(host).catch(() => null);
  if (addrs === null || addrs.length === 0) return { ok: false, reason: 'dns' };
  const usable: PinnedTarget[] = addrs
    .filter((a) => !isInternalAddress(a.address))
    .map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
  if (usable.length === 0) return { ok: false, reason: 'address' };
  return { ok: true, targets: [...usable.filter((t) => t.family === 4), ...usable.filter((t) => t.family === 6)] };
}

/**
 * How long one connect attempt may take before the next checked address is
 * tried. A dead address does not usually refuse - it is dropped, and the kernel
 * would keep retransmitting the SYN for over a minute - so without a bound the
 * fallback would arrive long after the caller gave up.
 */
export const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;

/** A connected socket to one address, or a rejection with the reason it failed. */
function connectOnce(address: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    const onError = (err: Error): void => {
      socket.destroy();
      reject(err);
    };
    const onTimeout = (): void => onError(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }));
    socket.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
    socket.once('connect', () => {
      // The idle timeout was only meant to bound the handshake; a tunnel that
      // stays quiet for a while (an idle SSE upstream) must not be torn down.
      socket.setTimeout(0);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
      resolve(socket);
    });
  });
}

/**
 * Connect to the first reachable of the *already checked* addresses. Nothing
 * here resolves anything: the list comes from resolveTarget, so every attempt
 * goes to an address that passed isInternalAddress/listedVerbatim, and a name
 * still cannot end up pointing inside. Attempts are sequential - a session
 * container is not the place to open speculative parallel connections, and the
 * per-attempt timeout keeps the total bounded.
 */
async function connectChecked(targets: readonly PinnedTarget[], port: number): Promise<net.Socket> {
  let last: unknown = new Error('no address');
  for (const target of targets) {
    try {
      return await connectOnce(target.address, port);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/**
 * An upstream that could not be reached at all. Without this line a failed
 * connect is invisible in operation: the caller sees "Connection error." from
 * its own HTTP client and the orchestrator log says nothing, which is exactly
 * how a proxy pinned to an unreachable AAAA address stayed undiagnosed. Kept in
 * the shape of logDenial and just as free of secrets - method, target and the
 * errno, never a header or a token.
 */
function logUpstreamFailure(method: string, host: string, port: number, err: unknown, tried?: number): void {
  const e = err as { code?: unknown; message?: unknown } | null;
  const detail = typeof e?.code === 'string' ? e.code : typeof e?.message === 'string' ? e.message : 'unknown error';
  const addresses = tried === undefined ? '' : `, tried ${tried} address${tried === 1 ? '' : 'es'}`;
  console.warn(`[egress] upstream failed ${method} ${host}:${port} (${detail}${addresses})`);
}

/**
 * Build the proxy server without binding it. The orchestrator runs it in
 * process, with a per-session token validator and the peer-IP gate the docker
 * daemon feeds (index.ts). Kept separate from `startEgressProxy` so the whole
 * filtering logic can be exercised on an ephemeral port in the smoke suite.
 */
export function createEgressProxyServer(opts: EgressGateOptions): http.Server {
  const { allowlist, tokenValidator, peerValidator } = opts;
  const ports = opts.ports ?? DEFAULT_EGRESS_PORTS;
  const checkTarget = opts.resolve ?? resolveTarget;

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
    const deny = (reason: DenyReason): void => {
      logDenial(req.method ?? 'GET', target.hostname, port, reason, auth);
      if (reason === 'auth') {
        res.writeHead(407, { 'proxy-authenticate': 'Basic realm="pocketagent"' }).end('proxy auth required');
      } else {
        res.writeHead(403).end(`${reason} not allowed`);
      }
    };
    const reason = denyReason(auth, target.hostname, port, allowlist, ports);
    if (reason !== null) {
      deny(reason);
      return;
    }
    void checkTarget(target.hostname, allowlist).then(async (resolved) => {
      if (res.writableEnded || req.destroyed) return;
      if (!resolved.ok) {
        if (resolved.reason === 'address') return deny('address');
        res.writeHead(502).end('upstream error');
        return;
      }
      const method = req.method ?? 'GET';
      const secure = target.protocol === 'https:';
      const headers = forwardableHeaders(req.headers);
      // A forwarded request keeps addressing its origin by name (Host header,
      // TLS servername) but connects to the addresses that were checked. The
      // authority of the absolute request-target wins over whatever Host the
      // client sent (RFC 7230 §5.4) - which, for a proxy request, is often the
      // proxy's own address.
      headers.host = target.host;
      /*
       * The connection is opened here rather than by node, so this path gets the
       * same fallback over all checked addresses as the tunnel: an http.request
       * pinned to one address cannot retry once its body is piped. Handing the
       * open socket over as createConnection (and setting no agent, which is
       * what makes node use it) keeps the request itself ordinary - by name in
       * the Host header, by name in the TLS servername, on an address the target
       * check approved. It costs the agent's connection pooling, which the
       * forward path barely used: browsers and git send https through CONNECT.
       */
      const socket = await connectChecked(resolved.targets, port).catch((err: unknown) => {
        logUpstreamFailure(method, target.hostname, port, err, resolved.targets.length);
        return null;
      });
      if (socket === null) {
        if (res.writableEnded) return;
        if (!res.headersSent) res.writeHead(502);
        res.end('upstream error');
        return;
      }
      if (res.writableEnded || req.destroyed) {
        socket.destroy();
        return;
      }
      const upstream = (secure ? https : http).request(
        {
          method: req.method,
          host: target.hostname,
          port,
          path: `${target.pathname}${target.search}`,
          headers,
          createConnection: secure
            ? (): net.Socket => tls.connect({ socket, servername: target.hostname, host: target.hostname })
            : (): net.Socket => socket,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      // Everything that goes wrong after the socket stood - a failed TLS
      // handshake, a reset mid-response - has no address left to fall back to,
      // but is just as invisible to the caller without a line here.
      upstream.on('error', (err) => {
        logUpstreamFailure(method, target.hostname, port, err);
        if (!res.headersSent) res.writeHead(502);
        res.end('upstream error');
      });
      /*
       * pipe() does not forward errors, so a caller that disappears mid-body
       * leaves req's 'error' unlistened - fatal for the process, same as on the
       * CONNECT path. Tearing the upstream request down is also the only way the
       * half-finished connection gets released.
       */
      req.on('error', () => upstream.destroy());
      res.on('error', () => upstream.destroy());
      req.pipe(upstream);
    }).catch(() => {
      // Nothing in the chain is expected to throw, and an unhandled rejection
      // would take the orchestrator down over a single request.
      if (res.writableEnded) return;
      if (!res.headersSent) res.writeHead(502);
      res.end('upstream error');
    });
  });

  server.on('connect', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    /*
     * Node hands the socket over on 'connect' and removes its own listeners
     * first, so from here on nothing but this handler guards it. Without a
     * listener an 'error' event is fatal for the whole process, and the
     * likeliest moment for one is right after a denial: the client gets its
     * 403 and resets the connection while the proxy is still writing, which
     * surfaces as ECONNRESET. A single refused CONNECT out of one session
     * container must not take the orchestrator down with it - hence the guard
     * before any gate, not after.
     */
    socket.on('error', () => socket.destroy());
    const url = String(req.url ?? '');
    const idx = url.lastIndexOf(':');
    const host = idx === -1 ? url : url.slice(0, idx);
    const portNum = idx === -1 ? 443 : Number(url.slice(idx + 1));
    const auth = proxyAuthorized(req, socket.remoteAddress, tokenValidator, peerValidator);
    const reason = denyReason(auth, host, portNum, allowlist, ports);
    if (reason !== null) {
      logDenial('CONNECT', host, portNum, reason, auth);
      if (reason === 'auth') proxyAuthRequired(socket);
      else forbidden(socket);
      return;
    }
    void checkTarget(host, allowlist).then(async (resolved) => {
      if (socket.destroyed) return;
      if (!resolved.ok) {
        if (resolved.reason === 'address') {
          logDenial('CONNECT', host, portNum, 'address', auth);
          forbidden(socket);
        } else {
          socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        }
        return;
      }
      // The checked addresses, in order, and nothing else: no second resolve
      // happens here, so every attempt goes to an address the target check
      // already approved.
      const upstream = await connectChecked(resolved.targets, portNum).catch((err: unknown) => {
        logUpstreamFailure('CONNECT', host, portNum, err, resolved.targets.length);
        return null;
      });
      if (upstream === null) {
        if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        return;
      }
      if (socket.destroyed) {
        upstream.destroy();
        return;
      }
      /*
       * From here the tunnel is established and the client has its 200: a later
       * error is the connection ending badly, not a target that could not be
       * reached, so it tears the pair down instead of writing a 502 into a live
       * tunnel (and stays out of the log - a reset at the end of a TLS session
       * is ordinary traffic, not a fault worth a line per request).
       */
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    }).catch(() => socket.destroy());
  });

  return server;
}

export function startEgressProxy(opts: EgressProxyOptions = {}): http.Server {
  const port = opts.port ?? config.egressProxyPort;
  const server = createEgressProxyServer({
    allowlist: opts.allowlist ?? config.networkAllowlist,
    ...(opts.ports ? { ports: opts.ports } : {}),
    ...(opts.tokenValidator ? { tokenValidator: opts.tokenValidator } : {}),
    ...(opts.peerValidator ? { peerValidator: opts.peerValidator } : {}),
  });
  server.listen(port, '0.0.0.0');
  return server;
}
