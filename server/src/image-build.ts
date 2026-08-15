import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Docker from 'dockerode';
import tar from 'tar-fs';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Self-build of adapter shim images.
 *
 * Deployments without a registry (and without shell access to the docker host)
 * cannot pre-build `<prefix>/<id>-shim`. The orchestrator image therefore ships
 * the complete build contexts (see server/Dockerfile) and builds a missing
 * image on demand through the very same docker API connection that runs the
 * session containers - socket, socket proxy or remote daemon alike.
 */

/** Directories that never belong into a build context (the Dockerfiles npm ci themselves). */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.smoke-work']);

/** Per-shim context entries, relative to the context root, in the order they are hashed. */
const SHIM_ENTRIES = [
  'Dockerfile',
  'adapter.json',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'src',
  'scripts',
  'smoke',
  'smoke.ts',
];

let rootCache: string | null | undefined;

/**
 * Root of the bundled build context. `/app/build-context` inside the
 * orchestrator image, the repo root when running from source. Must carry
 * exactly the layout every shims/<id>/Dockerfile expects (it COPYs
 * tsconfig.base.json, packages/protocol and shims/<id>/... from the context).
 */
export function shimContextRoot(): string | null {
  if (rootCache !== undefined) return rootCache;
  const candidates = [
    process.env.SHIM_BUILD_CONTEXT,
    resolve(here, '../build-context'), // dist/ -> /app/build-context
    resolve(here, '../..'), // src/ -> repo root (dev)
    '/app/build-context',
  ].filter((d): d is string => typeof d === 'string' && d.length > 0);
  rootCache =
    candidates.find(
      (d) =>
        existsSync(join(d, 'tsconfig.base.json')) &&
        existsSync(join(d, 'packages', 'protocol')) &&
        existsSync(join(d, 'shims')),
    ) ?? null;
  return rootCache;
}

function walk(root: string, rel: string, out: string[]): void {
  const abs = join(root, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return; // optional entry (not every shim has scripts/ or smoke/)
  }
  if (st.isFile()) {
    out.push(rel);
    return;
  }
  if (!st.isDirectory()) return;
  for (const name of readdirSync(abs).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    walk(root, `${rel}/${name}`, out);
  }
}

/**
 * Sorted list of context files for one adapter (relative to shimContextRoot()).
 * Deterministic: it is both the hash input and the staging plan, so the tag
 * always describes exactly the bytes that were built.
 */
export function shimContextFiles(adapterId: string): string[] | null {
  const root = shimContextRoot();
  if (root === null) return null;
  if (!existsSync(join(root, 'shims', adapterId, 'Dockerfile'))) return null;
  const files: string[] = [];
  walk(root, 'tsconfig.base.json', files);
  walk(root, 'packages/protocol', files);
  for (const entry of SHIM_ENTRIES) walk(root, `shims/${adapterId}/${entry}`, files);
  return files.sort();
}

/**
 * Content hash (12 hex) over path and bytes of every context file, in the
 * given order. Deterministic across hosts and processes: same sources => same
 * tag => no rebuild; any changed byte => new tag => rebuild on next start.
 */
export function hashContext(root: string, files: string[]): string {
  const h = createHash('sha256');
  for (const rel of files) {
    h.update(rel);
    h.update('\0');
    h.update(readFileSync(join(root, rel)));
    h.update('\n');
  }
  return h.digest('hex').slice(0, 12);
}

const hashCache = new Map<string, string | null>();

/**
 * Content hash of the adapter's bundled build context; null when none is
 * bundled. Used as the image tag when ADAPTER_IMAGE_TAG is not pinned, so a
 * deploy with changed shim sources rebuilds automatically while an unchanged
 * one reuses the image already on the host. Cached: the bundle is immutable
 * for the process lifetime.
 */
export function shimContextHash(adapterId: string): string | null {
  const cached = hashCache.get(adapterId);
  if (cached !== undefined) return cached;
  const root = shimContextRoot();
  const files = shimContextFiles(adapterId);
  const digest = root !== null && files !== null ? hashContext(root, files) : null;
  hashCache.set(adapterId, digest);
  return digest;
}

/**
 * Copy the context plan into a fresh tmp dir (same relative layout).
 * dereference matches the hash, which reads through symlinks - and a symlink
 * in a tar the daemon unpacks elsewhere would dangle anyway.
 */
function stage(root: string, files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-shim-ctx-'));
  for (const rel of files) cpSync(join(root, rel), join(dir, rel), { dereference: true, recursive: false });
  return dir;
}

/** Cause plus the last build-log lines, trimmed for an error message (never full logs). */
function withTail(cause: string, lines: string[], n = 8): string {
  const last = lines.slice(-n).join(' | ');
  return last.length > 0 ? `${cause} (${last})` : cause;
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Build `<tag>` from the bundled context of `adapterId` over the docker API.
 * Concurrent callers of the same tag share one build (pattern: gatewayReady);
 * a failed build is dropped from the cache so the next session retries.
 */
export function buildShimImage(
  d: Docker,
  adapterId: string,
  tag: string,
  onNotice?: (message: string) => void,
): Promise<void> {
  let pending = inFlight.get(tag);
  if (!pending) {
    pending = runBuild(d, adapterId, tag, onNotice).finally(() => inFlight.delete(tag));
    inFlight.set(tag, pending);
  }
  return pending;
}

async function runBuild(
  d: Docker,
  adapterId: string,
  tag: string,
  onNotice?: (message: string) => void,
): Promise<void> {
  const root = shimContextRoot();
  const files = shimContextFiles(adapterId);
  if (root === null || files === null) {
    throw new Error(
      `im Orchestrator-Image liegt kein Build-Kontext für Adapter "${adapterId}" (erwartet shims/${adapterId}/Dockerfile)`,
    );
  }
  onNotice?.('Agent-Image wird gebaut – erster Start dieses Agenten, dauert einige Minuten …');
  console.log(`[image-build] building ${tag} from ${files.length} context files`);
  const started = Date.now();
  const ctx = stage(root, files);
  try {
    // context layout == repo root, so `dockerfile` is the in-context path the
    // shims/<id>/Dockerfile itself documents (`docker build -f ... .`).
    const stream = await d.buildImage(tar.pack(ctx), {
      t: tag,
      dockerfile: `shims/${adapterId}/Dockerfile`,
      // no pull:true - a stale base image is better than failing a build on a
      // registry hiccup; the base is fetched whenever the daemon has none.
    });
    // A failed build ends the stream normally and only reports itself in an
    // `error` frame - followProgress' callback error covers transport faults
    // only, so both have to be checked.
    const lines: string[] = [];
    let failure: string | null = null;
    await new Promise<void>((res, rej) => {
      d.modem.followProgress(
        stream,
        (err: Error | null) => (err ? rej(new Error(withTail(err.message, lines))) : res()),
        (ev: { stream?: string; error?: string; errorDetail?: { message?: string } }) => {
          const failed = (ev.error ?? ev.errorDetail?.message ?? '').trim();
          if (failed.length > 0) failure = failed;
          const text = (ev.stream ?? '').trim();
          if (text.length > 0) lines.push(text);
        },
      );
    });
    if (failure !== null) throw new Error(withTail(failure, lines));
    const sec = Math.round((Date.now() - started) / 1000);
    console.log(`[image-build] ${tag} built in ${sec}s`);
    onNotice?.(`Agent-Image fertig gebaut (${sec}s) – Session startet.`);
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
}
