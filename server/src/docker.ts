import { PassThrough, type Writable } from 'node:stream';
import Docker from 'dockerode';
import type { NetworkPolicy, NoticePhase } from '@pocketagent/protocol';
import { CodexJsonRpc } from './codex-jsonrpc.js';
import type { CodexAppServerSession, CodexAuthTransport } from './codex-auth.js';
import {
  GATEWAY_ALIAS,
  GATEWAY_AUTH_HEADER,
  GATEWAY_CONTAINER_NAME,
  GATEWAY_EGRESS_PORT,
  GATEWAY_EGRESS_SYNC_PATH,
  GATEWAY_INGRESS_PORT,
  config,
  isNetworkPolicy,
} from './config.js';
import { adapterImage, getAdapter } from './adapters.js';
import { normalizePeerIp, type EgressSessionEntry } from './egress-proxy.js';
import { buildShimImage, shimContextFiles } from './image-build.js';
import { LOG_TAIL_LINES, redactTokens, stripLogFraming } from './progress.js';
import type { SessionRow } from './db.js';

/** Optional payload of a progress notice (phases are the protocol contract). */
export interface NoticeProgress {
  phase?: NoticePhase;
  /** Shortened, token-masked log excerpt (see progress.ts). */
  detail?: string;
}

/** Progress channel handed to the app while a session is being provisioned. */
export type NoticeFn = (message: string, progress?: NoticeProgress) => void;

let client: Docker | null = null;

/** Drop the cached daemon connection (docker config changed at runtime, tests). */
export function resetDockerClient(): void {
  client = null;
  peerIps = new Map();
  peerIpsAt = 0;
}

function docker(): Docker | null {
  if (!config.dockerEnabled) return null;
  if (client === null) {
    if (config.dockerHost) {
      const url = new URL(config.dockerHost);
      if (url.protocol === 'unix:') {
        client = new Docker({ socketPath: url.pathname || '/var/run/docker.sock' });
      } else {
        client = new Docker({
          protocol: url.protocol === 'https:' ? 'https' : 'http',
          host: url.hostname,
          port: url.port ? Number(url.port) : 2375,
          ...(config.dockerTls.ca && config.dockerTls.cert && config.dockerTls.key
            ? { ca: config.dockerTls.ca, cert: config.dockerTls.cert, key: config.dockerTls.key }
            : {}),
        });
      }
    } else {
      client = new Docker({ socketPath: '/var/run/docker.sock' });
    }
  }
  return client;
}

/**
 * Peer-IP authorization for the egress proxy (see egress-proxy.ts): the source
 * addresses of all live session containers mapped onto the session they belong
 * to, as the daemon reports them. The session id is what makes the gate
 * policy-aware - an address alone cannot tell an 'isolated' container (which
 * must never egress) from an 'allowlist' one.
 *
 * The TTL keeps the proxy off the daemon on the hot path (one list call per
 * window, not per request) and still picks up a new container within seconds;
 * every start additionally primes it (startContainer), so a shim's very first
 * request is already covered. A daemon error yields an empty map - never a
 * throw and never a stale allow.
 */
const PEER_CACHE_TTL_MS = 10_000;
let peerIps = new Map<string, string>();
let peerIpsAt = 0; // 0 = never loaded
let peerRefresh: Promise<Map<string, string>> | null = null;

async function loadSessionPeers(): Promise<Map<string, string>> {
  const next = new Map<string, string>();
  try {
    const d = docker();
    const raw = d ? await d.listContainers({ filters: { label: [SESSION_LABEL] } }) : [];
    for (const c of Array.isArray(raw) ? raw : []) {
      const sessionId = (c.Labels ?? {})[SESSION_LABEL] ?? '';
      if (!sessionId) continue;
      for (const net of Object.values(c.NetworkSettings?.Networks ?? {})) {
        for (const ip of [net?.IPAddress, net?.GlobalIPv6Address]) {
          const norm = normalizePeerIp(ip);
          if (norm) next.set(norm, sessionId);
        }
      }
    }
  } catch (e) {
    console.warn(`[docker] session peer lookup failed: ${String(e)}`);
  }
  peerIps = next;
  peerIpsAt = Date.now();
  // The gateway's proxy answers from the pushed table only, so every change to
  // the addresses has to reach it right away.
  await publishEgressTable();
  return next;
}

/** Reload the peer-IP cache now (deduplicated); never rejects. */
export async function refreshSessionPeers(): Promise<Map<string, string>> {
  if (!peerRefresh) {
    peerRefresh = loadSessionPeers().finally(() => {
      peerRefresh = null;
    });
  }
  return peerRefresh;
}

/**
 * Prime the cache right after a container start. Skipped for a remote daemon
 * without a gateway: those sessions are reached through published ports and
 * have no proxy at all. With a gateway the addresses are needed - not for the
 * local proxy, but for the table the gateway gates its own proxy with.
 */
async function primeSessionPeers(): Promise<void> {
  if (isRemote() && !gatewayEnabled()) return;
  await refreshSessionPeers();
}

/**
 * Synchronous gate for the egress proxy: which session does `ip` belong to?
 * Answers from the cache and refreshes it in the background when stale - the
 * proxy must never block a request on a daemon round trip.
 */
export function sessionIdForPeerIp(ip: string): string | null {
  if (Date.now() - peerIpsAt >= PEER_CACHE_TTL_MS) void refreshSessionPeers();
  return peerIps.get(normalizePeerIp(ip)) ?? null;
}

/** Container addresses of one session (for the gateway's session table). */
function peerIpsOf(sessionId: string): string[] {
  const ips: string[] = [];
  for (const [ip, id] of peerIps) if (id === sessionId) ips.push(ip);
  return ips;
}

/** Live sessions the orchestrator publishes to the gateway (set by index.ts). */
export type EgressSessionProvider = () => { id: string; policy: NetworkPolicy; token: string | null }[];

let egressSessions: EgressSessionProvider | null = null;
let lastPublishFailed = false;

export function setEgressSessionProvider(provider: EgressSessionProvider | null): void {
  egressSessions = provider;
}

/**
 * Push the live session table to the gateway's egress proxy. Without it the
 * gateway would have to let every container through unauthenticated (it has no
 * database and no docker access of its own). No-op in every local mode, where
 * the in-process proxy reads the same data directly.
 *
 * Failures are logged once per state change and never thrown: a gateway that is
 * momentarily unreachable must not fail a session start, and the next refresh
 * (or the periodic sync) carries the table again.
 */
export async function publishEgressTable(): Promise<boolean> {
  if (!gatewayEnabled() || egressSessions === null || !config.dockerAddr) return false;
  const entries: EgressSessionEntry[] = egressSessions().map((s) => ({
    id: s.id,
    policy: s.policy,
    token: s.token,
    ips: peerIpsOf(s.id),
  }));
  const url = `http://${config.dockerAddr}:${config.gatewayPort}${GATEWAY_EGRESS_SYNC_PATH}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...gatewayHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ sessions: entries }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (lastPublishFailed) console.log('[docker] egress session table reached the gateway again');
    lastPublishFailed = false;
    return true;
  } catch (e) {
    if (!lastPublishFailed) {
      console.warn(`[docker] pushing the egress session table to the gateway failed: ${String(e)}`);
    }
    lastPublishFailed = true;
    return false;
  }
}

/**
 * Periodic gateway sync (see SessionManager.start): refreshes the container
 * addresses and republishes the table, so a gateway that restarted - it keeps
 * the table in memory only - gets it back without a session having to change.
 */
export async function syncGatewayEgress(): Promise<void> {
  if (!gatewayEnabled()) return;
  await refreshSessionPeers();
}

/**
 * true when session containers run on a *remote* daemon; shim ports are then
 * published on the docker host (or routed through the gateway container).
 * A DOCKER_HOST pointing at a docker socket proxy is still the local daemon,
 * so DOCKER_HOST_IS_LOCAL=1 keeps the full local behaviour (session networks,
 * egress proxy, no port publishes). A unix:// DOCKER_HOST is also local.
 */
export function isRemote(): boolean {
  if (!config.dockerHost) return false;
  if (config.dockerHostIsLocal) return false;
  try {
    const proto = new URL(config.dockerHost).protocol.replace(/:$/, '');
    return proto !== 'unix';
  } catch {
    return true; // unparseable, non-unix host string: assume remote daemon
  }
}

export function parseMem(spec: string): number {
  const m = /^(\d+)\s*([kmgt]?)b?$/i.exec(spec.trim());
  if (!m) return 2 * 1024 ** 3;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  const mult = unit === 'k' ? 1024 : unit === 'm' ? 1024 ** 2 : unit === 'g' ? 1024 ** 3 : unit === 't' ? 1024 ** 4 : 1;
  return n * mult;
}

function envArr(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v as string}`);
}

/** Network alias the orchestrator container gets inside every session network. */
const ORCHESTRATOR_ALIAS = 'orchestrator';

/**
 * true when session networking is routed through the gateway container on the
 * runner (remote daemon + configured shared secret). Then remote mode keeps
 * per-session internal networks and the egress allowlist instead of falling
 * back to 'open' + published shim ports.
 */
export function gatewayEnabled(): boolean {
  return isRemote() && config.gatewayToken !== null;
}

/** Auth headers the orchestrator must add when talking through the gateway. */
export function gatewayHeaders(): Record<string, string> {
  return gatewayEnabled() ? { [GATEWAY_AUTH_HEADER]: config.gatewayToken as string } : {};
}

let gatewayReady: Promise<string | null> | null = null;

/**
 * Create/start the managed gateway container on the runner (idempotent, the
 * result is cached for the process lifetime). It runs the orchestrator image
 * with `npx tsx src/gateway.ts`, publishes only its ingress port and stays on
 * the default bridge network so it - and only it - has internet.
 */
export async function ensureGatewayContainer(): Promise<string | null> {
  if (!gatewayEnabled()) return null;
  if (!gatewayReady) {
    gatewayReady = createGateway().catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[docker] gateway container failed: ${msg}`);
      // drop the failed attempt so the next session retries instead of being
      // served a permanently broken cache entry
      gatewayReady = null;
      throw new Error(`gateway container unavailable: ${msg}`);
    });
  }
  return gatewayReady;
}

async function createGateway(): Promise<string | null> {
  const d = docker();
  if (!d) return null;
  const existing = d.getContainer(GATEWAY_CONTAINER_NAME);
  let info: Awaited<ReturnType<typeof existing.inspect>> | null = null;
  try {
    info = await existing.inspect();
  } catch {
    /* not created yet */
  }
  if (info !== null) {
    // A failing start (host port taken, bad image, ...) must not be reported as
    // success: the caller would otherwise time out later in waitForShim with a
    // misleading message. "already started" is a benign race and stays success.
    if (!info.State?.Running) {
      try {
        await existing.start();
      } catch (e) {
        const msg = String(e);
        if (!msg.includes('already started')) {
          throw new Error(`could not start existing gateway container ${GATEWAY_CONTAINER_NAME}: ${msg}`);
        }
      }
    }
    return info.Id;
  }
  await pullImage(config.gatewayImage);
  const c = await d.createContainer({
    name: GATEWAY_CONTAINER_NAME,
    Image: config.gatewayImage,
    Cmd: ['npx', 'tsx', 'src/gateway.ts'],
    Env: envArr({
      GATEWAY_TOKEN: config.gatewayToken ?? undefined,
      GATEWAY_ALLOWLIST: config.networkAllowlist.join(','),
      GATEWAY_INGRESS_PORT: String(GATEWAY_INGRESS_PORT),
      GATEWAY_EGRESS_PORT: String(GATEWAY_EGRESS_PORT),
    }),
    Labels: { 'pocketagent.role': 'gateway' },
    ExposedPorts: { [`${GATEWAY_INGRESS_PORT}/tcp`]: {} },
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      PortBindings: {
        [`${GATEWAY_INGRESS_PORT}/tcp`]: [{ HostPort: String(config.gatewayPort) }],
      },
    },
  });
  await c.start();
  console.log(`[docker] gateway container up (host port ${config.gatewayPort})`);
  return c.id;
}

/** Connect the gateway container to a network; returns the error message, or undefined when attached (or already attached). */
async function connectGateway(d: Docker, networkName: string, id: string): Promise<string | undefined> {
  try {
    await d.getNetwork(networkName).connect({
      Container: id,
      EndpointConfig: { Aliases: [GATEWAY_ALIAS] },
    });
    return undefined;
  } catch (e) {
    const msg = String(e);
    return msg.includes('already') ? undefined : msg;
  }
}

/** Attach the gateway to a session network so shims can reach it as 'gateway'. */
async function attachGateway(networkName: string): Promise<void> {
  const d = docker();
  const id = await ensureGatewayContainer();
  if (!d || !id) return;
  const failure = await connectGateway(d, networkName, id);
  if (failure === undefined) return;
  if (!failure.includes('No such container') && !failure.includes('404')) {
    console.warn(`[docker] gateway attach to ${networkName} failed: ${failure}`);
    return;
  }
  // The gateway was removed behind our back. Dropping the cache alone would
  // leave *this* session without any relay, so recreate it and retry once;
  // if that fails too the error propagates and the session fails cleanly.
  gatewayReady = null;
  console.warn(`[docker] gateway container gone (${failure}) - recreating it for ${networkName}`);
  const recreated = await ensureGatewayContainer();
  if (!recreated) throw new Error(`gateway container could not be recreated for ${networkName}`);
  const retryFailure = await connectGateway(d, networkName, recreated);
  if (retryFailure !== undefined) {
    throw new Error(`gateway attach to ${networkName} failed after recreating the gateway: ${retryFailure}`);
  }
}

/** Create a network unless the daemon already knows it (idempotent). */
async function ensureNetworkExists(name: string, internal: boolean): Promise<void> {
  const d = docker();
  if (!d) return;
  try {
    await d.getNetwork(name).inspect();
  } catch {
    try {
      await d.createNetwork({ Name: name, CheckDuplicate: true, ...(internal ? { Internal: true } : {}) });
    } catch {
      /* already created concurrently */
    }
  }
}

export async function ensureNetwork(): Promise<void> {
  await ensureNetworkExists(config.networkName, false);
  await ensureSelfAttached(config.networkName);
}

/**
 * Attach the orchestrator's own container (local mode only; HOSTNAME is the
 * container id inside docker) to a network so it can reach session shims by
 * alias and shims can reach the egress proxy. Idempotent, errors are logged
 * but never thrown (e.g. running outside docker).
 *
 * Works for both local variants: raw socket mount and socket proxy, since the
 * proxy talks to the very same daemon, so HOSTNAME still resolves to a
 * container the daemon knows. Skipped only for a truly remote daemon, where
 * HOSTNAME means nothing.
 */
export async function ensureSelfAttached(networkName: string): Promise<string | null> {
  const d = docker();
  if (!d || isRemote()) return null;
  const selfId = process.env.HOSTNAME;
  // Without HOSTNAME there is no way to name our own container to the daemon.
  // Silently skipping used to leave the session reachable by nobody, surfacing
  // minutes later as a bare "shim did not become ready in time".
  if (!selfId) {
    return 'HOSTNAME ist im Orchestrator-Container nicht gesetzt – der Orchestrator kann sich nicht selbst ans Session-Netz hängen.';
  }
  try {
    await d.getNetwork(networkName).connect({
      Container: selfId,
      EndpointConfig: { Aliases: [ORCHESTRATOR_ALIAS] },
    });
    return null;
  } catch (e) {
    const msg = String(e);
    if (msg.includes('already')) return null;
    console.warn(`[docker] self-attach to ${networkName} failed: ${msg}`);
    // An unreachable daemon is not an attach problem: every later call fails
    // the same way and says so more precisely, so only a daemon that answered
    // (e.g. "no such container" for a HOSTNAME that is not ours) blocks here.
    if (/ECONNREFUSED|ENOENT|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket hang up/.test(msg)) return null;
    return `Orchestrator (HOSTNAME=${selfId}) konnte nicht ans Netz ${networkName} angebunden werden: ${msg}`;
  }
}

/**
 * Local mode reaches the shim only through the session's docker network, and an
 * 'allowlist' session reaches the egress proxy only the same way. A failed
 * attach therefore has to fail the session immediately with its real cause
 * instead of running into the shim-readiness timeout.
 */
async function requireAttached(session: SessionRow): Promise<void> {
  const failure = await attachOrchestratorTo(session);
  if (failure === null) return;
  const hint =
    sessionNetworkFor(session).relay === 'gateway'
      ? 'Prüfe den Gateway-Container auf dem Docker-Host.'
      : 'Prüfe, ob der Orchestrator selbst als Docker-Container mit gesetztem HOSTNAME läuft.';
  throw new Error(`${failure} Ohne diese Anbindung ist der Agent-Container nicht erreichbar. ${hint}`);
}

export function sessionNetworkName(sessionId: string): string {
  return `pocketagent-s-${sessionId.slice(0, 12)}`;
}

/** Delete a session's internal network together with any containers left on it. */
export async function removeSessionNetwork(sessionId: string): Promise<void> {
  const d = docker();
  if (!d) return;
  const net = d.getNetwork(sessionNetworkName(sessionId));
  try {
    const info = await net.inspect();
    const selfId = process.env.HOSTNAME;
    const members = (info.Containers ?? {}) as Record<string, { Name?: string } | undefined>;
    for (const [cid, meta] of Object.entries(members)) {
      const isSelf = selfId !== undefined && selfId.length > 0 && cid.startsWith(selfId);
      const isGateway = (meta?.Name ?? '') === GATEWAY_CONTAINER_NAME;
      if (isSelf || isGateway) {
        await net.disconnect({ Container: cid }).catch(() => {});
      } else {
        await d.getContainer(cid).remove({ force: true }).catch(() => {});
      }
    }
    await net.remove().catch(() => {});
  } catch {
    /* network gone */
  }
}

/**
 * Validate the session row's network policy (fallback: config default).
 * Remote-mode gating lives in createSession: without a gateway container
 * (GATEWAY_TOKEN) remote sessions with 'allowlist'/'isolated' are rejected
 * and 'open' requires explicit REMOTE_NETWORK_OPEN=1 consent - never silently
 * downgraded.
 */
function policyFor(session: SessionRow): NetworkPolicy {
  const raw = session.network_policy;
  return isNetworkPolicy(raw) ? raw : config.networkPolicyDefault;
}

/** Who relays orchestrator traffic into a session's network. */
export type SessionRelay =
  /** local daemon: the orchestrator container itself (alias 'orchestrator') */
  | 'orchestrator'
  /** remote daemon + GATEWAY_TOKEN: the gateway container (alias 'gateway') */
  | 'gateway'
  /** remote daemon without gateway: the shim is reached via a published port */
  | 'none';

export interface SessionNetwork {
  /** docker network the session container lives on */
  name: string;
  relay: SessionRelay;
}

/**
 * Network a session's container lives on and who has to be attached to it so
 * the orchestrator can reach the shim: 'open' shares the main network,
 * 'allowlist'/'isolated' get a dedicated internal one. Pure by contract - the
 * single source of truth for both session creation and the startup reconcile.
 */
export function sessionNetworkFor(session: SessionRow): SessionNetwork {
  const name = policyFor(session) === 'open' ? config.networkName : sessionNetworkName(session.id);
  const relay: SessionRelay = gatewayEnabled() ? 'gateway' : isRemote() ? 'none' : 'orchestrator';
  return { name, relay };
}

/**
 * (Re)establish the link between the orchestrator and a session's network,
 * creating the network when it is missing. Idempotent; returns null when the
 * link stands, otherwise its German cause. Needed on every path that has to
 * talk to a shim - including a freshly deployed orchestrator container, which
 * starts out attached to no session network at all.
 */
export async function attachOrchestratorTo(session: SessionRow): Promise<string | null> {
  const { name, relay } = sessionNetworkFor(session);
  if (relay === 'none') return null; // published shim port, no shared network
  await ensureNetworkExists(name, name !== config.networkName);
  if (relay === 'orchestrator') return ensureSelfAttached(name);
  try {
    await attachGateway(name);
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Gateway-Container konnte nicht ans Netz ${name} angebunden werden: ${msg}`;
  }
}

/**
 * Container networking for a session (see sessionNetworkFor). For 'allowlist'
 * the proxy env vars are injected into `env`.
 */
async function sessionNetworking(
  session: SessionRow,
  env: Record<string, string | undefined>,
): Promise<{ EndpointsConfig: Record<string, { Aliases: string[] }> }> {
  const policy = policyFor(session);
  const { name: netName, relay } = sessionNetworkFor(session);
  await requireAttached(session);
  const viaGateway = relay === 'gateway';
  // 'isolated' keeps both defaults - and gets no usable proxy either: the relay
  // hangs on its network too, but both proxies refuse every request of a
  // session whose policy says 'isolated' (egress-proxy.ts, denyReason 'policy').
  let egress = 'none';
  let auth = 'n/a';
  if (policy === 'allowlist') {
    // Proxy auth: egress proxies accept requests carrying a valid per-session
    // shim token (Basic "pa:<token>"); instances without a validator ignore it.
    // Every caller of this function must therefore hand in a row that already
    // has its shim_token (provision stages it, reprovisionAdapter/resumeSession/
    // push refuse an unprovisioned session) - a URL without credentials leaves
    // the session dependent on the peer-IP gate alone, hence the auth= in the
    // log line below.
    const userinfo = session.shim_token ? `pa:${session.shim_token}@` : '';
    const proxyHost = viaGateway
      ? `${GATEWAY_ALIAS}:${GATEWAY_EGRESS_PORT}`
      : `${ORCHESTRATOR_ALIAS}:${config.egressProxyPort}`;
    env.HTTP_PROXY = `http://${userinfo}${proxyHost}`;
    env.HTTPS_PROXY = `http://${userinfo}${proxyHost}`;
    env.NO_PROXY = 'localhost,127.0.0.1';
    egress = proxyHost;
    auth = userinfo ? 'yes' : 'no';
  }
  // The one line that tells a broken session's egress setup apart from a broken
  // network at a glance (no secrets: host and presence of credentials only).
  console.log(
    `[docker] session ${session.id.slice(0, 8)} policy=${policy} net=${netName} egress=${egress} auth=${auth}`,
  );
  return { EndpointsConfig: { [netName]: { Aliases: [session.id] } } };
}

/**
 * In-container mount point of the codex CODEX_HOME volume. Matches the codex
 * shim image's `ENV CODEX_HOME=/codex-home` (shims/codex/Dockerfile) so the
 * runtime finds auth.json + thread state exactly where it expects them.
 */
export const CODEX_HOME_MOUNT = '/codex-home';

/**
 * The ONE canonical CODEX_HOME docker volume per tenant (CODEX-OAUTH.md §4).
 * codex's refresh token rotates and is single-use, so auth.json must never be
 * copied into N containers (copies invalidate each other on the first refresh).
 * Instead every codex session container — and the short-lived auth container —
 * mounts this same volume read-write, updating the file in place.
 */
export function codexHomeVolumeName(tenant: string): string {
  return `pocketagent-codex-home-${tenant}`;
}

/**
 * Extra bind mounts a session container needs beyond the work volume. codex
 * gets the shared CODEX_HOME volume (see codexHomeVolumeName); every other
 * adapter gets none. The volume is created on demand so a first codex session
 * without a prior login still starts (empty CODEX_HOME = "not signed in yet").
 */
async function extraBindsFor(session: SessionRow): Promise<string[]> {
  if (session.adapter !== 'codex') return [];
  const vol = codexHomeVolumeName(session.tenant_id);
  await ensureVolume(vol);
  return [`${vol}:${CODEX_HOME_MOUNT}`];
}

export async function ensureVolume(name: string): Promise<void> {
  const d = docker();
  if (!d) return;
  try {
    await d.createVolume({ Name: name });
  } catch {
    /* exists */
  }
}

/** Pull the adapter image (registry mode, e.g. ghcr.io); no-op when unavailable locally and pull fails are surfaced by the caller's create. */
export async function pullImage(image: string): Promise<void> {
  const d = docker();
  if (!d) return;
  await new Promise<void>((resolve) => {
    d.pull(image, (err: Error | null, stream?: NodeJS.ReadableStream) => {
      if (err || !stream) return resolve();
      d.modem.followProgress(
        stream,
        (finErr: Error | null) => {
          if (finErr) console.error(`[docker] pull ${image}: ${finErr.message}`);
          resolve();
        },
        () => {},
      );
    });
  });
}

async function imageExists(d: Docker, image: string): Promise<boolean> {
  try {
    await d.getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

/**
 * Make the adapter image available on the daemon that runs the session:
 * (a) already present locally, (b) pullable from a registry, (c) built from the
 * build context bundled into the orchestrator image (see image-build.ts).
 *
 * (c) is skipped for adapters that pin an explicit "image" in their manifest -
 * those are operator-controlled artifacts and must never be shadowed by a
 * locally built one. Throws with an actionable German message otherwise.
 */
export async function ensureAdapterImage(adapter: string, onNotice?: NoticeFn): Promise<string> {
  const d = docker();
  const image = adapterImage(adapter);
  if (!d) return image;
  if (await imageExists(d, image)) return image;
  await pullImage(image);
  if (await imageExists(d, image)) return image;
  if (getAdapter(adapter)?.image) {
    throw new Error(
      `Shim-Image ${image} ist im Adapter-Manifest fest eingetragen, liegt aber weder lokal vor noch ` +
        `konnte es aus der Registry geladen werden. Image pushen/verfügbar machen oder das Feld "image" ` +
        `in shims/${adapter}/adapter.json entfernen, damit der Server es selbst baut.`,
    );
  }
  if (shimContextFiles(adapter) === null) {
    throw new Error(
      `Shim-Image ${image} fehlt und konnte nicht gebaut werden: im Orchestrator-Image liegt kein ` +
        `Build-Kontext für Adapter "${adapter}" (erwartet shims/${adapter}/Dockerfile).`,
    );
  }
  try {
    await buildShimImage(d, adapter, image, onNotice);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Shim-Image ${image} fehlt und konnte nicht gebaut werden: ${msg}`);
  }
  return image;
}

/** One ustar header (512 bytes) + data padded to a 512-byte block. uid/gid 1000 = 'node' in the shim images. */
function tarEntry(name: string, mode: number, typeflag: '0' | '5', data: Buffer): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 99), 0, 100, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  h.write('1750\0', 108, 8, 'ascii'); // uid 1000
  h.write('1750\0', 116, 8, 'ascii'); // gid 1000
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii'); // mtime 0
  h.write('        ', 148, 8, 'ascii'); // checksum placeholder (spaces)
  h.write(typeflag, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([h, data, Buffer.alloc(pad)]);
}

/**
 * Inject `creds` into a NOT-YET-STARTED container as /run/secrets/pa/creds.json
 * (uid/gid 1000, dir 0700, file 0400) via a minimal in-memory tar. Replaces
 * GITHUB_PAT container env (K2 contract): shims read PA_CREDS_FILE at runtime.
 * putArchive writes are daemon-side and work on a not-yet-started
 * readonly-rootfs container; if a daemon ever rejects it, creds injection
 * failing is logged here and sessions continue without push credentials.
 */
export async function injectCredsFile(containerId: string, creds: Record<string, string>): Promise<boolean> {
  const d = docker();
  if (!d) return false;
  try {
    const body = Buffer.from(JSON.stringify(creds), 'utf8');
    const tar = Buffer.concat([
      tarEntry('pa/', 0o700, '5', Buffer.alloc(0)),
      tarEntry('pa/creds.json', 0o400, '0', body),
      Buffer.alloc(1024), // end-of-archive marker
    ]);
    await d.getContainer(containerId).putArchive(tar, { path: '/run/secrets' });
    return true;
  } catch (e) {
    console.error(`[docker] creds injection failed for ${containerId.slice(0, 8)}: ${String(e)}`);
    return false;
  }
}

/**
 * Create the session container. Every failure throws with its real cause
 * (docker message, missing image, failed build): provision()/resumeSession()
 * forward it verbatim to the app, which would otherwise only ever see a
 * generic "failed to create session container".
 */
export async function createSessionContainer(
  session: SessionRow,
  env: Record<string, string | undefined>,
  onNotice?: NoticeFn,
): Promise<string> {
  const d = docker();
  if (!d) throw new Error('Docker ist auf diesem Server deaktiviert.');
  if (!session.volume_name) throw new Error('Session hat kein Volume – nicht provisioniert.');
  const containerEnv = { ...env };
  const networking = await sessionNetworking(session, containerEnv);
  const image = await ensureAdapterImage(session.adapter, onNotice);
  try {
    await ensureVolume(session.volume_name);
    // codex: mount the ONE shared CODEX_HOME volume rw (rotating single-use
    // refresh token => never copy auth.json into N containers, see CODEX-OAUTH.md §4).
    const extraBinds = await extraBindsFor(session);
    // With a gateway the shim is reached through it, so no host port is published
    // (an internal per-session network could not serve one anyway).
    const remote = isRemote() && !gatewayEnabled();
    const c = await d.createContainer({
      Image: image,
      Env: envArr(containerEnv),
      Labels: { [SESSION_LABEL]: session.id },
      ...(remote ? { ExposedPorts: { '8080/tcp': {} } } : {}),
      HostConfig: {
        Memory: parseMem(config.sessionMemLimit),
        Binds: [`${session.volume_name}:/work`, ...extraBinds],
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        PidsLimit: config.sessionPidsLimit,
        ReadonlyRootfs: true,
        // executable /tmp: shims run their GIT_ASKPASS helper script from /tmp
        Tmpfs: { '/tmp': 'rw,size=1g' },
        ...(config.sessionCpuQuota ? { NanoCpus: config.sessionCpuQuota } : {}),
        ...(remote ? { PortBindings: { '8080/tcp': [{ HostPort: '', HostIp: config.dockerPublishIp }] } } : {}),
      },
      NetworkingConfig: networking,
    });
    return c.id;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[docker] create failed for session ${session.id.slice(0, 8)}: ${msg}`);
    throw new Error(`Session-Container konnte nicht erstellt werden: ${msg}`);
  }
}

export async function startContainer(id: string): Promise<boolean> {
  const d = docker();
  if (!d) return false;
  // In gateway mode the proxy that will serve this container runs on the
  // runner, so it has to know the session's token *before* the container can
  // ask for anything - same ordering as setProvisioned -> start locally.
  await publishEgressTable();
  let started: boolean;
  try {
    await d.getContainer(id).start();
    started = true;
  } catch (e) {
    started = String(e).includes('already started');
  }
  // A container only has an IP once it runs: reloading here is what lets the
  // egress proxy authorize the shim's very first request by peer IP.
  if (started) await primeSessionPeers();
  return started;
}

/**
 * Base URL the orchestrator uses to reach a running session shim.
 * Local mode: docker-network alias (null => caller uses http://<sessionId>:8080).
 * Remote mode with gateway: the gateway's single published port, path-routed
 *   per session (`http://<DOCKER_ADDR>:<GATEWAY_PORT>/s/<sessionId>`).
 * Remote mode without gateway: published random host port on the docker host.
 */
export async function shimEndpoint(containerId: string, sessionId: string): Promise<string | null> {
  if (!isRemote() || !config.dockerAddr) return null;
  if (gatewayEnabled()) {
    return `http://${config.dockerAddr}:${config.gatewayPort}/s/${encodeURIComponent(sessionId)}`;
  }
  const d = docker();
  if (!d) return null;
  try {
    const info = await d.getContainer(containerId).inspect();
    const bindings = info.NetworkSettings.Ports?.['8080/tcp'];
    const hostPort = bindings?.[0]?.HostPort;
    if (!hostPort) return null;
    return `http://${config.dockerAddr}:${hostPort}`;
  } catch (e) {
    console.error(`[docker] endpoint inspect failed: ${String(e)}`);
    return null;
  }
}

/**
 * Last log lines of a container, framing stripped, never redacted (callers that
 * forward the text mask it themselves). Unavailable logs are '' on purpose:
 * this feeds both diagnostics and the live start progress, and neither may fail
 * a session because the daemon has nothing to say.
 */
export async function containerLogTail(id: string, lines = LOG_TAIL_LINES): Promise<string> {
  const d = docker();
  if (!d) return '';
  try {
    const raw = await d.getContainer(id).logs({ stdout: true, stderr: true, tail: lines });
    return stripLogFraming(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)));
  } catch {
    return ''; // container removed / daemon unreachable
  }
}

/**
 * Liveness of a session container. 'unknown' means the daemon did not answer:
 * only a daemon that *did* answer proves a container is gone, so a caller must
 * never turn a transport failure into a dead session.
 */
export type ContainerState = 'running' | 'stopped' | 'missing' | 'unknown';

export async function containerState(id: string): Promise<ContainerState> {
  const d = docker();
  if (!d) return 'unknown';
  try {
    const info = await d.getContainer(id).inspect();
    return info.State?.Running === true ? 'running' : 'stopped';
  } catch (e) {
    return /no such container|404/i.test(String(e)) ? 'missing' : 'unknown';
  }
}

/**
 * Last log lines of a container plus its exit state. When a shim never becomes
 * ready, its own stderr holds the reason (failed clone, missing key, crash) -
 * without this the app only ever sees "shim did not become ready in time".
 * Token-shaped words are masked: shim logs are not supposed to contain secrets,
 * but this text is forwarded to the app and the server log.
 */
export async function containerDiagnostics(id: string, lines = LOG_TAIL_LINES): Promise<string> {
  const d = docker();
  if (!d) return '';
  const parts: string[] = [];
  try {
    const info = await d.getContainer(id).inspect();
    const state = info.State;
    if (state) {
      const exit = state.ExitCode === undefined ? '' : ` exit=${state.ExitCode}`;
      const err = state.Error ? ` error=${state.Error}` : '';
      parts.push(`Container: ${state.Status ?? 'unknown'}${exit}${err}`);
    }
  } catch {
    parts.push('Container: nicht mehr vorhanden');
  }
  const text = await containerLogTail(id, lines);
  if (text.length > 0) parts.push(`Log:\n${redactTokens(text)}`);
  return parts.join('\n');
}

export async function stopContainer(id: string): Promise<void> {
  const d = docker();
  if (!d) return;
  try {
    await d.getContainer(id).stop({ t: 10 });
  } catch {
    /* not running */
  }
}

export async function removeContainer(id: string): Promise<void> {
  const d = docker();
  if (!d) return;
  try {
    await d.getContainer(id).remove({ force: true });
  } catch {
    /* gone */
  }
}

export async function removeVolume(name: string): Promise<void> {
  const d = docker();
  if (!d) return;
  try {
    await d.getVolume(name).remove({ force: true });
  } catch {
    /* gone */
  }
}

export async function listRunning(): Promise<number | null> {
  const d = docker();
  if (!d) return null;
  try {
    const list = await d.listContainers({ filters: { label: ['pocketagent.session'] } });
    return list.length;
  } catch {
    return null;
  }
}

/** Label des Session-Containers: der Wert ist die Session-Id (createSessionContainer/oneShotPush). */
export const SESSION_LABEL = 'pocketagent.session';

/** Ein vom Daemon gemeldeter Container mit SESSION_LABEL (laufend oder gestoppt). */
export interface LabeledSessionContainer {
  id: string;
  /** Wert des Labels: die Session, zu der der Container gehört ('' wenn leer). */
  sessionId: string;
  /** Erstellzeitpunkt in ms - der Orphan-Reaper fasst nur Container an, die älter als der Prozess sind. */
  createdMs: number;
}

/**
 * Alle Container mit SESSION_LABEL, gestoppte eingeschlossen - die Datenbasis
 * des Orphan-Reapers (sessions.ts). `null` heißt "der Daemon hat nicht
 * geantwortet": ein Transportfehler darf nie als "alles verwaist" gelten.
 */
export async function listSessionContainers(): Promise<LabeledSessionContainer[] | null> {
  const d = docker();
  if (!d) return null;
  try {
    const list = await d.listContainers({ all: true, filters: { label: [SESSION_LABEL] } });
    return (Array.isArray(list) ? list : []).map((c) => ({
      id: c.Id,
      sessionId: (c.Labels ?? {})[SESSION_LABEL] ?? '',
      createdMs: typeof c.Created === 'number' ? c.Created * 1000 : 0,
    }));
  } catch (e) {
    console.warn(`[docker] session container listing failed: ${String(e)}`);
    return null;
  }
}

export function pushScriptFor(adapter: string): string {
  return getAdapter(adapter)?.pushScript ?? `/app/shims/${adapter}/scripts/push.js`;
}

/** Tap-push in a throwaway container. Boolean result; the real cause is logged. */
export async function oneShotPush(
  session: SessionRow,
  env: Record<string, string | undefined>,
  creds?: Record<string, string>,
  onNotice?: NoticeFn,
): Promise<boolean> {
  const d = docker();
  if (!d || !session.volume_name) return false;
  // Der Wegwerf-Container gehört keiner Zeile in der DB: entfernt ihn ein
  // Fehlerpfad nicht selbst, findet ihn danach niemand mehr (weder reapIdle
  // noch gc kennen ihn) - deshalb das finally.
  let pushContainer: Docker.Container | null = null;
  try {
    const image = await ensureAdapterImage(session.adapter, onNotice);
    const containerEnv = { ...env };
    const networking = await sessionNetworking(session, containerEnv);
    const c = await d.createContainer({
      Image: image,
      Env: envArr(containerEnv),
      Cmd: ['node', pushScriptFor(session.adapter)],
      Labels: { [SESSION_LABEL]: session.id },
      HostConfig: {
        Memory: parseMem(config.sessionMemLimit),
        Binds: [`${session.volume_name}:/work`],
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        PidsLimit: config.sessionPidsLimit,
        ReadonlyRootfs: true,
        // executable /tmp: shims run their GIT_ASKPASS helper script from /tmp
        Tmpfs: { '/tmp': 'rw,size=1g' },
        ...(config.sessionCpuQuota ? { NanoCpus: config.sessionCpuQuota } : {}),
      },
      NetworkingConfig: networking,
    });
    pushContainer = c;
    if (creds && Object.keys(creds).length > 0) await injectCredsFile(c.id, creds);
    // Same ordering as startContainer: the gateway has to know the session
    // (whose push window the caller just opened) before its container asks.
    await publishEgressTable();
    await c.start();
    await primeSessionPeers(); // the push container pushes through the egress proxy too
    const res = await c.wait();
    return res.StatusCode === 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[docker] push failed for session ${session.id.slice(0, 8)}: ${msg}`);
    return false;
  } finally {
    if (pushContainer) await pushContainer.remove({ force: true }).catch(() => {});
  }
}

/** Container label marking the short-lived codex auth container. */
const CODEX_AUTH_LABEL = 'pocketagent.codex-auth';

/** Run a command in a container and collect its stdout/exit code. */
async function execCollect(
  container: Docker.Container,
  cmd: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: false });
  const out = new PassThrough();
  const err = new PassThrough();
  const d = docker();
  d?.modem.demuxStream(stream, out, err);
  let stdout = '';
  let stderr = '';
  out.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
  err.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
  await new Promise<void>((resolve) => stream.on('end', resolve));
  const info = await exec.inspect();
  return { exitCode: info.ExitCode ?? 0, stdout, stderr };
}

/**
 * Production transport for the in-app codex login (CODEX-OAUTH.md, see
 * codex-auth.ts): a short-lived container running `codex app-server`, mounting
 * the tenant's ONE canonical CODEX_HOME volume rw. JSON-RPC rides the attached
 * stdio; the loopback callback and the auth.json read run *inside* the
 * container (docker exec) where 127.0.0.1:<port> and CODEX_HOME are reachable.
 *
 * This path is not covered by the smoke test (it needs a real daemon + the
 * codex binary + a real ChatGPT account); the smoke test exercises the
 * identical flow logic through a spawned fake app-server transport instead, and
 * the end-to-end phone login is the documented manual verification step.
 */
export class DockerCodexAuthTransport implements CodexAuthTransport {
  async open(tenant: string): Promise<CodexAppServerSession> {
    const d = docker();
    if (!d) throw new Error('Docker ist auf diesem Server deaktiviert.');
    const image = await ensureAdapterImage('codex');
    const vol = codexHomeVolumeName(tenant);
    await ensureVolume(vol);
    const container = await d.createContainer({
      Image: image,
      Cmd: ['codex', 'app-server', '--ignore-user-config'],
      Labels: { [CODEX_AUTH_LABEL]: tenant },
      Env: envArr({ CODEX_HOME: CODEX_HOME_MOUNT, HOME: '/tmp', XDG_CONFIG_HOME: '/tmp/xdg' }),
      OpenStdin: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      HostConfig: {
        Memory: parseMem(config.sessionMemLimit),
        Binds: [`${vol}:${CODEX_HOME_MOUNT}`],
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        PidsLimit: config.sessionPidsLimit,
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,size=256m' },
        ...(config.sessionCpuQuota ? { NanoCpus: config.sessionCpuQuota } : {}),
      },
    });
    // Attach before start so no early app-server output is missed.
    const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    d.modem.demuxStream(stream, stdout, stderr);
    stderr.on('data', (c: Buffer) => {
      const line = c.toString('utf8').trim();
      if (line) console.error(`[codex-auth app-server] ${line}`);
    });
    await container.start();

    const rpc = new CodexJsonRpc(stream as unknown as Writable, stdout);
    // codex app-server handshake before login_chatgpt.
    await rpc.request('initialize', { clientInfo: { name: 'pocketagent-orchestrator', version: '0.1.0' } }, 30_000);
    rpc.notify('initialized', {});

    return {
      rpc,
      async forwardCallback(port: number, code: string, state: string): Promise<number> {
        // Reach the login server on the container's own loopback (docker exec
        // runs inside the netns); code/state pass as argv, never string-spliced.
        const script =
          'const[,p,c,s]=process.argv;' +
          "const u='http://127.0.0.1:'+p+'/auth/callback?'+new URLSearchParams({code:c,state:s}).toString();" +
          "fetch(u).then(r=>{console.log('STATUS:'+r.status);process.exit(0)}).catch(()=>{console.log('STATUS:0');process.exit(1)});";
        const res = await execCollect(container, ['node', '-e', script, String(port), code, state]);
        const m = /STATUS:(\d+)/.exec(res.stdout);
        return m ? Number(m[1]) : 0;
      },
      async readAuthJson(): Promise<string | null> {
        const res = await execCollect(container, ['cat', `${CODEX_HOME_MOUNT}/auth.json`]);
        return res.exitCode === 0 && res.stdout.trim().length > 0 ? res.stdout : null;
      },
      async close(): Promise<void> {
        rpc.close();
        try {
          await container.stop({ t: 5 });
        } catch {
          /* not running */
        }
        await container.remove({ force: true }).catch(() => {});
      },
    };
  }
}
