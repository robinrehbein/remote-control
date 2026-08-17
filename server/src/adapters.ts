import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterDescriptor, ProviderDescriptor } from '@pocketagent/protocol';
import { config } from './config.js';
import { shimContextHash } from './image-build.js';

const here = dirname(fileURLToPath(import.meta.url));

function manifestDirs(): string[] {
  const candidates = [
    process.env.ADAPTERS_DIR,
    resolve(here, '../../shims'),
    '/app/adapters',
  ].filter((d): d is string => typeof d === 'string' && d.length > 0);
  return [...new Set(candidates)].filter((d) => existsSync(d));
}

/** Display metadata is cosmetic: drop malformed entries, never fail the manifest. */
function providerList(raw: unknown): ProviderDescriptor[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ProviderDescriptor[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const p = entry as Record<string, unknown>;
    if (typeof p.id !== 'string' || p.id.length === 0) continue;
    if (typeof p.name !== 'string' || p.name.length === 0) continue;
    out.push({
      id: p.id,
      name: p.name,
      ...(typeof p.keyUrl === 'string' && p.keyUrl.length > 0 ? { keyUrl: p.keyUrl } : {}),
      ...(typeof p.hint === 'string' && p.hint.length > 0 ? { hint: p.hint } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

// Shell-safe env var names only: sessions.ts buildEnv() writes credentials/
// providerEnv values straight into the container's environment (docker.ts
// Env array, "NAME=value"). Loose here means an operator/upstream typo turns
// into a container env var no one asked for.
const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * `credentials` maps a secret kind to the container env vars it fills
 * (sessions.ts buildEnv iterates `for (const v of vars) setKey(kind, v)`).
 * A manifest that gives a STRING instead of an array (a plausible typo:
 * `"credentials": {"github": "GITHUB_TOKEN"}`) would silently iterate that
 * string character by character - GITHUB_TOKEN never gets set, and the
 * secret instead lands in one-letter env vars named G, I, T, H, U, B, ... .
 * Rejecting the whole manifest here is strictly better than shipping that.
 */
function validateCredentials(raw: unknown, source: string): Record<string, string[]> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${source}: credentials must be an object`);
  }
  const out: Record<string, string[]> = {};
  for (const [kind, vars] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(vars) || vars.length === 0) {
      throw new Error(`${source}: credentials.${kind} must be a non-empty array of env var names`);
    }
    const names: string[] = [];
    for (const v of vars) {
      if (typeof v !== 'string' || !ENV_VAR_RE.test(v)) {
        throw new Error(`${source}: credentials.${kind} has an invalid env var name "${String(v)}"`);
      }
      names.push(v);
    }
    out[kind] = names;
  }
  return out;
}

/** `providerEnv` maps a provider id to the single env var its key goes into. */
function validateProviderEnv(raw: unknown, source: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${source}: providerEnv must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [provider, envVar] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof envVar !== 'string' || !ENV_VAR_RE.test(envVar)) {
      throw new Error(`${source}: providerEnv.${provider} must be a valid env var name, got "${String(envVar)}"`);
    }
    out[provider] = envVar;
  }
  return out;
}

/**
 * `defaults` is a required field of AdapterDescriptor, not an optional one -
 * a manifest with `defaults: {}` used to cast straight through and hand
 * `provider: undefined` to callers typed as `provider: string`
 * (sessions.ts:103 `desc.defaults.provider || fallback` happened to survive
 * that by luck, not by contract).
 */
function validateDefaults(raw: unknown, source: string): { provider: string; model?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${source}: defaults must be an object`);
  }
  const d = raw as Record<string, unknown>;
  if (typeof d.provider !== 'string') throw new Error(`${source}: defaults.provider must be a string`);
  if (d.model !== undefined && typeof d.model !== 'string') {
    throw new Error(`${source}: defaults.model must be a string`);
  }
  return { provider: d.provider, ...(typeof d.model === 'string' ? { model: d.model } : {}) };
}

function validate(id: string, raw: unknown, source: string): AdapterDescriptor {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${source}: not an object`);
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || m.id.length === 0) throw new Error(`${source}: missing id`);
  if (typeof m.name !== 'string' || m.name.length === 0) throw new Error(`${source}: missing name`);
  if (m.id !== id) throw new Error(`${source}: manifest id "${m.id}" does not match directory "${id}"`);
  const caps = (m.capabilities ?? {}) as Record<string, unknown>;
  const credentials = validateCredentials(m.credentials, source);
  const providerEnv = validateProviderEnv(m.providerEnv, source);
  const defaults = validateDefaults(m.defaults, source);
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
    ...(credentials ? { credentials } : {}),
    ...(providerEnv ? { providerEnv } : {}),
    ...((): { providers?: ProviderDescriptor[] } => {
      const providers = providerList(m.providers);
      return providers ? { providers } : {};
    })(),
    defaults,
  };
  return desc;
}

/**
 * Precedence: ADAPTERS_DIR (operator override) > the repo's own shims/ >
 * the image's bundled /app/adapters. manifestDirs() lists them in exactly
 * that order, and the FIRST directory to claim an id wins here - the
 * Dockerfile always populates /app/adapters (every shim's adapter.json is
 * copied there at build time), so without this an operator-supplied
 * ADAPTERS_DIR manifest for a built-in id (e.g. a pinned `image` digest for
 * "opencode") was silently discarded in favour of the bundled default.
 */
function loadAll(): AdapterDescriptor[] {
  const dirs = manifestDirs();
  if (dirs.length > 0) console.log(`[adapters] manifest directories in precedence order: ${dirs.join(' > ')}`);
  const out = new Map<string, AdapterDescriptor>();
  const sourceOf = new Map<string, string>();
  for (const dir of dirs) {
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
        if (out.has(id)) {
          console.log(`[adapters] ${manifestPath} ignored: "${id}" already provided by ${sourceOf.get(id)}`);
          continue;
        }
        const desc = validate(id, JSON.parse(readFileSync(manifestPath, 'utf8')), manifestPath);
        out.set(desc.id, desc);
        sourceOf.set(desc.id, manifestPath);
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

/** Test-only: force the next listAdapters() to re-read manifestDirs() from disk. */
export function resetAdapterRegistry(): void {
  registry = null;
}

export function getAdapter(id: string): AdapterDescriptor | undefined {
  return listAdapters().find((a) => a.id === id);
}

/**
 * Image a session container of this adapter runs.
 *
 * An explicit manifest "image" always wins (operator-controlled artifact, never
 * self-built). Otherwise the tag is either the pinned ADAPTER_IMAGE_TAG or -
 * the default - `c<content hash>` over the bundled shim build context, so the
 * self build in docker.ts rebuilds exactly when the shim sources changed.
 */
export function adapterImage(id: string): string {
  const desc = getAdapter(id);
  if (desc?.image) return desc.image;
  const hash = config.adapterImageTagPinned ? null : shimContextHash(id);
  const tag = hash === null ? config.adapterImageTag : `c${hash}`;
  return `${config.adapterImagePrefix}/${id}-shim:${tag}`;
}
