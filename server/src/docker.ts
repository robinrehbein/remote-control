import Docker from 'dockerode';
import { config } from './config.js';
import { adapterImage, getAdapter } from './adapters.js';
import type { SessionRow } from './db.js';

let client: Docker | null = null;

function docker(): Docker | null {
  if (!config.dockerEnabled) return null;
  client ??= new Docker({ socketPath: '/var/run/docker.sock' });
  return client;
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

export async function createSessionContainer(
  session: SessionRow,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  const d = docker();
  if (!d || !session.volume_name) return null;
  try {
    await ensureVolume(session.volume_name);
    const c = await d.createContainer({
      Image: adapterImage(session.adapter),
      Env: envArr(env),
      Labels: { 'pocketagent.session': session.id },
      HostConfig: {
        Memory: parseMem(config.sessionMemLimit),
        Binds: [`${session.volume_name}:/work`],
      },
      NetworkingConfig: {
        EndpointsConfig: { [config.networkName]: { Aliases: [session.id] } },
      },
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
    const c = await d.createContainer({
      Image: adapterImage(session.adapter),
      Env: envArr(env),
      Cmd: ['node', pushScriptFor(session.adapter)],
      Labels: { 'pocketagent.session': session.id },
      HostConfig: { Binds: [`${session.volume_name}:/work`] },
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
