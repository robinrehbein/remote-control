import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterDescriptor } from '@pocketagent/protocol';
import { config } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));

function manifestDirs(): string[] {
  const candidates = [
    process.env.ADAPTERS_DIR,
    resolve(here, '../../shims'),
    '/app/adapters',
  ].filter((d): d is string => typeof d === 'string' && d.length > 0);
  return [...new Set(candidates)].filter((d) => existsSync(d));
}

function validate(id: string, raw: unknown, source: string): AdapterDescriptor {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${source}: not an object`);
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || m.id.length === 0) throw new Error(`${source}: missing id`);
  if (typeof m.name !== 'string' || m.name.length === 0) throw new Error(`${source}: missing name`);
  if (m.id !== id) throw new Error(`${source}: manifest id "${m.id}" does not match directory "${id}"`);
  const caps = (m.capabilities ?? {}) as Record<string, unknown>;
  const desc: AdapterDescriptor = {
    id: m.id,
    name: m.name,
    ...(typeof m.description === 'string' ? { description: m.description } : {}),
    ...(typeof m.image === 'string' && m.image.length > 0 ? { image: m.image } : {}),
    ...(typeof m.pushScript === 'string' && m.pushScript.length > 0 ? { pushScript: m.pushScript } : {}),
    capabilities: {
      approvals: caps.approvals === true,
      resume: caps.resume === true,
      streaming: caps.streaming === true,
      autoPush: caps.autoPush === true,
      reasoning: caps.reasoning === true,
      modelSwitch: caps.modelSwitch === true,
    },
    ...(typeof m.credentials === 'object' && m.credentials !== null ? { credentials: m.credentials as Record<string, string[]> } : {}),
    ...(typeof m.providerEnv === 'object' && m.providerEnv !== null ? { providerEnv: m.providerEnv as Record<string, string> } : {}),
    defaults:
      typeof m.defaults === 'object' && m.defaults !== null
        ? (m.defaults as { provider: string; model?: string })
        : { provider: '' },
  };
  return desc;
}

function loadAll(): AdapterDescriptor[] {
  const out = new Map<string, AdapterDescriptor>();
  for (const dir of manifestDirs()) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const manifestPath = entry.isDirectory()
        ? join(dir, entry.name, 'adapter.json')
        : entry.isFile() && entry.name.endsWith('.json')
          ? join(dir, entry.name)
          : null;
      if (!manifestPath) continue;
      try {
        const id = entry.isDirectory()
          ? entry.name
          : entry.name.replace(/\.json$/, '');
        const desc = validate(id, JSON.parse(readFileSync(manifestPath, 'utf8')), manifestPath);
        out.set(desc.id, desc);
      } catch (e) {
        console.warn(`[adapters] skipping invalid manifest ${manifestPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

let registry: AdapterDescriptor[] | null = null;

export function listAdapters(): AdapterDescriptor[] {
  registry ??= loadAll();
  return registry;
}

export function getAdapter(id: string): AdapterDescriptor | undefined {
  return listAdapters().find((a) => a.id === id);
}

export function adapterImage(id: string): string {
  const desc = getAdapter(id);
  return desc?.image ?? `${config.adapterImagePrefix}/${id}-shim:latest`;
}
