import Docker from 'dockerode';
import type { NetworkPolicy } from '@pocketagent/protocol';
import { config, isNetworkPolicy } from './config.js';
import { adapterImage, getAdapter } from './adapters.js';
import type { SessionRow } from './db.js';

let client: Docker | null = null;

function docker(): Docker | null {
  if (!config.dockerEnabled) return null;
  if (client === null) {
    if (config.dockerHost) {
      const url = new URL(config.dockerHost);
      client = new Docker({
        protocol: url.protocol === 'https:' ? 'https' : 'http',
        host: url.hostname,
        port: url.port ? Number(url.port) : 2375,
        ...(config.dockerTls.ca && config.dockerTls.cert && config.dockerTls.key
          ? { ca: config.dockerTls.ca, cert: config.dockerTls.cert, key: config.dockerTls.key }
          : {}),
      });
    } else {
      client = new Docker({ socketPath: '/var/run/docker.sock' });
    }
  }
  return client;
}

/**
 * true when session containers run on a *remote* daemon; shim ports are then
 * published on the docker host and policies are forced to 'open'.
 * A DOCKER_HOST pointing at a docker socket proxy is still the local daemon,
 * so DOCKER_HOST_IS_LOCAL=1 keeps the full local behaviour (session networks,
 * egress proxy, no port publishes).
 */
export function isRemote(): boolean {
  return config.dockerHost !== null && !config.dockerHostIsLocal;
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
    for (const cid of Object.keys(info.Containers ?? {})) {
      if (selfId && cid.startsWith(selfId)) {
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

/** Remote daemons publish shim ports; session networks only work in local mode (socket or socket proxy). */
function policyFor(session: SessionRow): NetworkPolicy {
  if (isRemote()) return 'open';
  const raw = session.network_policy;
  return isNetworkPolicy(raw) ? raw : config.networkPolicyDefault;
}

/**
 * Resolve the container network for a session. 'open' shares the main
 * network; 'allowlist'/'isolated' get a dedicated internal network and the
 * orchestrator attaches itself (alias 'orchestrator'). For 'allowlist' the
 * proxy env vars are injected into `env`.
 */
async function sessionNetworking(
  session: SessionRow,
  env: Record<string, string | undefined>,
): Promise<{ EndpointsConfig: Record<string, { Aliases: string[] }> }> {
  if (policyFor(session) === 'open') {
    return { EndpointsConfig: { [config.networkName]: { Aliases: [session.id] } } };
  }
  const netName = await ensureSessionNetwork(session.id);
  await ensureSelfAttached(netName);
  if (policyFor(session) === 'allowlist') {
    env.HTTP_PROXY = `http://${ORCHESTRATOR_ALIAS}:${config.egressProxyPort}`;
    env.HTTPS_PROXY = `http://${ORCHESTRATOR_ALIAS}:${config.egressProxyPort}`;
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

export async function createSessionContainer(
  session: SessionRow,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  const d = docker();
  if (!d || !session.volume_name) return null;
  try {
    await ensureVolume(session.volume_name);
    await pullImage(adapterImage(session.adapter));
    const remote = isRemote();
    const containerEnv = { ...env };
    const networking = await sessionNetworking(session, containerEnv);
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
        Tmpfs: { '/tmp': 'rw,size=1g' },
        ...(remote ? { PortBindings: { '8080/tcp': [{ HostPort: '' }] } } : {}),
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
 * Remote mode: published random host port on the docker host (DOCKER_ADDR).
 */
export async function shimEndpoint(containerId: string): Promise<string | null> {
  if (!isRemote() || !config.dockerAddr) return null;
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
        Tmpfs: { '/tmp': 'rw,size=1g' },
      },
      NetworkingConfig: networking,
    });
    await c.start();
    const res = await c.wait();
    await c.remove().catch(() => {});
    return res.StatusCode === 0;
  } catch (e) {
    console.error(`[docker] push failed for session ${session.id.slice(0, 8)}: ${String(e)}`);
    return false;
  }
}
