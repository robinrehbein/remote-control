/**
 * Side-effect module, imported first by index.ts: pins every outbound HTTP(S)
 * request of this process to the egress proxy whenever the container was
 * started with one (network policy 'allowlist' - see installEnvProxyDispatcher
 * in @pocketagent/protocol for why node needs the nudge). It sits in its own
 * file so the dispatcher stands before the SDK modules imported below it are
 * evaluated; a call inside index.ts would run only after all of them.
 *
 * Without proxy variables (policy 'open', direct internet) nothing is
 * installed and the process talks to the network exactly as it did before.
 *
 * Proxy auth (F3): the orchestrator injects the proxy URL with Basic
 * userinfo `pa:<shim_token>` - for Docker sessions (server/src/docker.ts,
 * peer-IP gate answers even without credentials) and for Fly machines
 * (sessions.buildFlyMachineEnv, where the token gate is the ONLY gate: an
 * unknown source address plus missing Proxy-Authorization is a 407 on every
 * provider call). git/libcurl send URL userinfo as Proxy-Authorization, but
 * whether undici's EnvHttpProxyAgent does depends on the undici version
 * (older ProxyAgents dropped URL userinfo entirely). So whenever the proxy
 * URL carries userinfo we do NOT rely on undici's env handling: the userinfo
 * is turned into an explicit `token` option (complete Proxy-Authorization
 * header value) on a ProxyAgent we construct ourselves, wrapped in a
 * dispatcher that still honors NO_PROXY (loopback, orchestrator host) by
 * going direct. Without userinfo the previous EnvHttpProxyAgent is kept
 * unchanged - the Docker peer-gate path must not move.
 */
import { Agent, Dispatcher, EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from 'undici';
import { envProxyUrl, installEnvProxyDispatcher } from '@pocketagent/protocol';

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for the smoke suite)                          */
/* ------------------------------------------------------------------ */

/** A complete Proxy-Authorization header value derived from proxy URL userinfo. */
export interface ProxyAuthHeader {
  header: string;
}

/** decodeURIComponent that never throws: malformed escapes pass through raw. */
function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Proxy-Authorization header for a proxy URL with userinfo, or null without
 * one. `user:pass` becomes `'Basic ' + base64("user:pass")` after
 * percent-decoding both parts - byte for byte the value undici's ProxyAgent
 * derives from the URI on versions that support userinfo at all, and exactly
 * what the egress proxy's parseProxyAuth expects (`Basic "pa:<token>"`, the
 * token being everything after the first colon). A username without password
 * yields `base64("user:")`, like ProxyAgent; no username at all yields null
 * even if a lone password sits in the URL.
 */
export function proxyAuthHeader(proxyUrl: string): ProxyAuthHeader | null {
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    return null;
  }
  if (url.username === '') return null;
  const user = percentDecode(url.username);
  const password = percentDecode(url.password);
  return { header: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` };
}

/** The proxy URL without its userinfo part (what may safely be logged/passed on). */
export function stripProxyUserinfo(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return proxyUrl;
  }
}

/* ------------------------------------------------------------------ */
/* NO_PROXY matching (mirrors undici's EnvHttpProxyAgent semantics)     */
/* ------------------------------------------------------------------ */

interface NoProxyEntry {
  hostname: string;
  port: number; // 0 = any port
}

interface NoProxyRules {
  wildcard: boolean;
  entries: NoProxyEntry[];
}

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };

/**
 * NO_PROXY in undici's shape: entries split on comma/whitespace, `*` alone
 * disables the proxy for everything, an entry is `host`, `host:port`,
 * `[v6]` or `[v6]:port`, and a leading `.` or `*.` is ignored. IPv6 entries
 * carry more than one colon, so host:port is only split when that is
 * unambiguous.
 */
function parseNoProxy(raw: string | undefined): NoProxyRules {
  const value = (raw ?? '').trim();
  if (value === '') return { wildcard: false, entries: [] };
  if (value === '*') return { wildcard: true, entries: [] };
  const entries: NoProxyEntry[] = [];
  for (const part of value.split(/[,\s]/)) {
    if (!part) continue;
    let hostname: string;
    let port = 0;
    const v6WithPort = /^\[(.+)\]:(\d+)$/.exec(part);
    const v6Bare = /^\[(.+)\]$/.exec(part);
    if (v6WithPort) {
      hostname = v6WithPort[1] as string;
      port = Number.parseInt(v6WithPort[2] as string, 10);
    } else if (v6Bare) {
      hostname = v6Bare[1] as string;
    } else {
      const colonCount = (part.match(/:/g) ?? []).length;
      const hostPort = colonCount === 1 ? /^(.+):(\d+)$/.exec(part) : null;
      if (hostPort) {
        hostname = hostPort[1] as string;
        port = Number.parseInt(hostPort[2] as string, 10);
      } else {
        hostname = part;
      }
    }
    entries.push({ hostname: hostname.replace(/^\*?\./, '').toLowerCase(), port });
  }
  return { wildcard: false, entries };
}

/** Whether `hostname`:`port` is exempted from the proxy by the parsed rules. */
function noProxyMatches(rules: NoProxyRules, hostname: string, port: number): boolean {
  if (rules.wildcard) return true;
  for (const entry of rules.entries) {
    if (entry.port !== 0 && entry.port !== port) continue;
    if (hostname === entry.hostname) return true;
    if (hostname.slice(-(entry.hostname.length + 1)) === `.${entry.hostname}`) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Dispatcher: ProxyAgent with explicit token, NO_PROXY goes direct     */
/* ------------------------------------------------------------------ */

/**
 * The userinfo-carrying proxy URL turned deterministic: every request not
 * exempted by NO_PROXY goes through a ProxyAgent built with an explicit
 * `token` (the complete Proxy-Authorization header), so the credentials
 * reach the proxy on every undici version that knows the token option -
 * independent of whether its ProxyAgent parses URL userinfo. Exempted
 * targets (loopback, the orchestrator host) go straight to a plain Agent,
 * exactly as EnvHttpProxyAgent routes them.
 */
class TokenProxyDispatcher extends Dispatcher {
  private readonly proxy: ProxyAgent;
  private readonly direct: Agent = new Agent();
  private readonly rules: NoProxyRules;

  constructor(proxyUrl: string, token: string, noProxy: string | undefined) {
    super();
    this.proxy = new ProxyAgent({ uri: proxyUrl, token });
    this.rules = parseNoProxy(noProxy);
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    let hostname = '';
    let port = 0;
    try {
      const url = new URL(options.origin ?? '');
      hostname = url.hostname.replace(/^\[(.+)\]$/, '$1').toLowerCase();
      port = Number.parseInt(url.port, 10) || (DEFAULT_PORTS[url.protocol] ?? 0);
    } catch {
      // Unparseable origin: route through the proxy (never silently direct).
    }
    const via = noProxyMatches(this.rules, hostname, port) ? this.direct : this.proxy;
    return via.dispatch(options, handler);
  }

  override close(): Promise<void> {
    return Promise.all([this.direct.close(), this.proxy.close()]).then(() => undefined);
  }

  override destroy(err: Error | null, callback: () => void): void;
  override destroy(callback: () => void): void;
  override destroy(err?: Error | null): Promise<void>;
  override destroy(errOrCallback?: Error | null | (() => void)): Promise<void> | void {
    const callback = typeof errOrCallback === 'function' ? errOrCallback : undefined;
    const err = typeof errOrCallback === 'function' ? null : errOrCallback ?? null;
    const done = Promise.all([this.direct.destroy(err), this.proxy.destroy(err)]).then(() => undefined);
    if (callback !== undefined) {
      void done.then(
        () => callback(),
        () => callback(),
      );
    }
    return done;
  }
}

/* ------------------------------------------------------------------ */
/* Installation                                                         */
/* ------------------------------------------------------------------ */

/**
 * The dispatcher for the proxy environment, or null without one. The choice
 * is the F3 contract:
 *  - no proxy variables -> null (nothing is installed, policy 'open' keeps
 *    its direct internet);
 *  - proxy URL without userinfo -> EnvHttpProxyAgent, unchanged from before
 *    (the Docker path, covered by the peer-IP gate);
 *  - proxy URL with userinfo -> TokenProxyDispatcher: ProxyAgent with the
 *    userinfo as an explicit token, NO_PROXY still going direct. This is
 *    the Fly path, where a dropped userinfo would mean 407 on everything.
 */
export function buildEnvProxyDispatcher(env: Record<string, string | undefined>): Dispatcher | null {
  const proxyUrl = envProxyUrl(env);
  if (proxyUrl === undefined) return null;
  const auth = proxyAuthHeader(proxyUrl);
  if (auth === null) return new EnvHttpProxyAgent();
  return new TokenProxyDispatcher(stripProxyUserinfo(proxyUrl), auth.header, env.no_proxy ?? env.NO_PROXY);
}

const proxy = installEnvProxyDispatcher(process.env, () => {
  const dispatcher = buildEnvProxyDispatcher(process.env);
  if (dispatcher !== null) setGlobalDispatcher(dispatcher);
});

// One line per container start, so a session that cannot reach its provider can
// be told apart from one that never even tried the proxy (no line = no proxy).
// The marker says which auth mode the dispatcher uses; the URL stays redacted.
if (proxy !== undefined) {
  const explicitAuth = proxyAuthHeader(envProxyUrl(process.env) ?? '') !== null;
  console.log(`[proxy] pi-runner: outbound HTTP(S) via ${proxy}${explicitAuth ? ' (explicit proxy-auth)' : ''}`);
}
