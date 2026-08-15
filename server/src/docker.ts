import Docker from 'dockerode';
import type { NetworkPolicy } from '@pocketagent/protocol';
import {
  GATEWAY_ALIAS,
  GATEWAY_AUTH_HEADER,
  GATEWAY_CONTAINER_NAME,
  GATEWAY_EGRESS_PORT,
  GATEWAY_INGRESS_PORT,
  config,
  isNetworkPolicy,
} from './config.js';
import { adapterImage, getAdapter } from './adapters.js';
import type { SessionRow } from './db.js';

let client: Docker | null = null;

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

export async function ensureNetwork(): Promise<void> {
  const d = docker();
  if (!d) return;
  try {
    await d.getNetwork(config.networkName).inspect();
  } catch {
    try {
      await d.createNetwork({ Name: config.networkName, CheckDuplicate: true });
    } catch {
      /* already created concurrently */
    }
  }
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
export async function ensureSelfAttached(networkName: string): Promise<void> {
  const d = docker();
  if (!d || isRemote()) return;
  const selfId = process.env.HOSTNAME;
  if (!selfId) return;
  try {
    await d.getNetwork(networkName).connect({
      Container: selfId,
      EndpointConfig: { Aliases: [ORCHESTRATOR_ALIAS] },
    });
  } catch (e) {
    const msg = String(e);
    if (!msg.includes('already')) {
      console.warn(`[docker] self-attach to ${networkName} failed: ${msg}`);
    }
  }
}

export function sessionNetworkName(sessionId: string): string {
  return `pocketagent-s-${sessionId.slice(0, 12)}`;
}

async function ensureSessionNetwork(sessionId: string): Promise<string> {
  const d = docker();
  const name = sessionNetworkName(sessionId);
  if (!d) return name;
  try {
    await d.getNetwork(name).inspect();
  } catch {
    try {
      await d.createNetwork({ Name: name, Internal: true, CheckDuplicate: true });
    } catch {
      /* already created concurrently */
    }
  }
  return name;
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

/**
 * Resolve the container network for a session. 'open' shares the main
 * network; 'allowlist'/'isolated' get a dedicated internal network with a
 * reachable relay attached: locally the orchestrator itself (alias
 * 'orchestrator'), remotely the gateway container (alias 'gateway'). For
 * 'allowlist' the proxy env vars are injected into `env`.
 */
async function sessionNetworking(
  session: SessionRow,
  env: Record<string, string | undefined>,
): Promise<{ EndpointsConfig: Record<string, { Aliases: string[] }> }> {
  const policy = policyFor(session);
  if (policy === 'open') {
    // With a gateway even 'open' sessions are reached through it (no published
    // port), so it has to sit on the shared network too.
    if (gatewayEnabled()) await attachGateway(config.networkName);
    return { EndpointsConfig: { [config.networkName]: { Aliases: [session.id] } } };
  }
  const netName = await ensureSessionNetwork(session.id);
  const viaGateway = gatewayEnabled();
  if (viaGateway) await attachGateway(netName);
  else await ensureSelfAttached(netName);
  if (policy === 'allowlist') {
    // Proxy auth: egress proxies accept requests carrying a valid per-session
    // shim token (Basic "pa:<token>"); instances without a validator ignore it.
    const auth = session.shim_token ? `pa:${session.shim_token}@` : '';
    const proxyHost = viaGateway
      ? `${GATEWAY_ALIAS}:${GATEWAY_EGRESS_PORT}`
      : `${ORCHESTRATOR_ALIAS}:${config.egressProxyPort}`;
    env.HTTP_PROXY = `http://${auth}${proxyHost}`;
    env.HTTPS_PROXY = `http://${auth}${proxyHost}`;
    env.NO_PROXY = 'localhost,127.0.0.1';
  }
  return { EndpointsConfig: { [netName]: { Aliases: [session.id] } } };
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

export async function createSessionContainer(
  session: SessionRow,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  const d = docker();
  if (!d || !session.volume_name) return null;
  // Networking is resolved before the try block on purpose: a broken gateway
  // must fail the session with its own cause instead of being flattened into
  // the generic "failed to create session container" of the null return below.
  const containerEnv = { ...env };
  const networking = await sessionNetworking(session, containerEnv);
  try {
    await ensureVolume(session.volume_name);
    await pullImage(adapterImage(session.adapter));
    // With a gateway the shim is reached through it, so no host port is published
    // (an internal per-session network could not serve one anyway).
    const remote = isRemote() && !gatewayEnabled();
    const c = await d.createContainer({
      Image: adapterImage(session.adapter),
      Env: envArr(containerEnv),
      Labels: { 'pocketagent.session': session.id },
      ...(remote ? { ExposedPorts: { '8080/tcp': {} } } : {}),
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
        ...(remote ? { PortBindings: { '8080/tcp': [{ HostPort: '', HostIp: config.dockerPublishIp }] } } : {}),
      },
      NetworkingConfig: networking,
    });
    return c.id;
  } catch (e) {
    console.error(`[docker] create failed for session ${session.id.slice(0, 8)}: ${String(e)}`);
    return null;
  }
}

export async function startContainer(id: string): Promise<boolean> {
  const d = docker();
  if (!d) return false;
  try {
    await d.getContainer(id).start();
    return true;
  } catch (e) {
    return String(e).includes('already started');
  }
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

export function pushScriptFor(adapter: string): string {
  return getAdapter(adapter)?.pushScript ?? `/app/shims/${adapter}/scripts/push.js`;
}

export async function oneShotPush(
  session: SessionRow,
  env: Record<string, string | undefined>,
  creds?: Record<string, string>,
): Promise<boolean> {
  const d = docker();
  if (!d || !session.volume_name) return false;
  try {
    await pullImage(adapterImage(session.adapter));
    const containerEnv = { ...env };
    const networking = await sessionNetworking(session, containerEnv);
    const c = await d.createContainer({
      Image: adapterImage(session.adapter),
      Env: envArr(containerEnv),
      Cmd: ['node', pushScriptFor(session.adapter)],
      Labels: { 'pocketagent.session': session.id },
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
    if (creds && Object.keys(creds).length > 0) await injectCredsFile(c.id, creds);
    await c.start();
    const res = await c.wait();
    await c.remove().catch(() => {});
    return res.StatusCode === 0;
  } catch (e) {
    console.error(`[docker] push failed for session ${session.id.slice(0, 8)}: ${String(e)}`);
    return false;
  }
}
