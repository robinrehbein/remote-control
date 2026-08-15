import { existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { NetworkPolicy } from '@pocketagent/protocol';

export const SERVER_VERSION = '0.1.0';

export const NETWORK_POLICIES = ['allowlist', 'isolated', 'open'] as const;

export function isNetworkPolicy(v: unknown): v is NetworkPolicy {
  return typeof v === 'string' && (NETWORK_POLICIES as readonly string[]).includes(v);
}

function loadMasterKey(): Buffer {
  const raw = process.env.MASTER_KEY?.trim();
  if (raw) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === 32) return b64;
    return createHash('sha256').update(raw).digest();
  }
  console.warn('[config] MASTER_KEY not set - using ephemeral key, secrets will not survive restarts');
  return randomBytes(32);
}

function loadDockerEnabled(): boolean {
  const raw = process.env.DOCKER_ENABLED;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return existsSync('/var/run/docker.sock') || dockerHost() !== null;
}

/** Remote docker daemon, e.g. tcp://docker.example.com:2376 (Fly deployment mode). */
function dockerHost(): string | null {
  const raw = process.env.DOCKER_HOST?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/** Marks a set DOCKER_HOST as the *local* daemon reached through a socket proxy. */
function dockerHostIsLocal(): boolean {
  const raw = process.env.DOCKER_HOST_IS_LOCAL?.trim();
  return raw === '1' || raw === 'true';
}

function dockerAddr(fallbackHost: string | null): string | null {
  const raw = process.env.DOCKER_ADDR?.trim();
  if (raw && raw.length > 0) return raw;
  if (!fallbackHost) return null;
  try {
    const url = new URL(fallbackHost);
    return url.hostname;
  } catch {
    return fallbackHost;
  }
}

function b64Env(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const buf = Buffer.from(raw, 'base64');
  return buf.length > 0 ? buf.toString() : undefined;
}

const DEFAULT_NETWORK_ALLOWLIST = [
  'github.com',
  'api.github.com',
  '*.githubusercontent.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'api.anthropic.com',
  'api.openai.com',
  'api.moonshot.cn',
  'open.bigmodel.cn',
  'api.z.ai',
  'registry.npmjs.org',
  'proxy.golang.org',
  'pypi.org',
  'files.pythonhosted.org',
];

function loadNetworkPolicyDefault(): NetworkPolicy {
  const raw = process.env.NETWORK_POLICY?.trim();
  if (isNetworkPolicy(raw)) return raw;
  if (raw) console.warn(`[config] invalid NETWORK_POLICY "${raw}" - falling back to allowlist`);
  return 'allowlist';
}

function loadNetworkAllowlist(): string[] {
  const raw = process.env.NETWORK_ALLOWLIST?.trim();
  if (!raw) return DEFAULT_NETWORK_ALLOWLIST;
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dataDir: resolve(process.env.DATA_DIR ?? './data'),
  masterKey: loadMasterKey(),
  dockerEnabled: loadDockerEnabled(),
  /** null => local /var/run/docker.sock; tcp://host:port => remote daemon (session containers run elsewhere, e.g. orchestrator on Fly.io + Docker host at home) */
  dockerHost: dockerHost(),
  /**
   * Marks a set DOCKER_HOST as the same local daemon, only reached through a
   * docker socket proxy (hardening stage 2, e.g. http://socket-proxy:2375).
   * Session networks and the egress proxy stay active and no shim ports are
   * published - i.e. everything behaves exactly like plain socket mode.
   */
  dockerHostIsLocal: dockerHostIsLocal(),
  /** Hostname/IP the orchestrator uses to reach published shim ports on the docker host (defaults to DOCKER_HOST's hostname) */
  dockerAddr: dockerAddr(dockerHost()),
  dockerTls: {
    ca: b64Env('DOCKER_CLIENT_CA_B64'),
    cert: b64Env('DOCKER_CLIENT_CERT_B64'),
    key: b64Env('DOCKER_CLIENT_KEY_B64'),
  },
  networkName: process.env.NETWORK_NAME ?? 'pocketagent',
  sessionMemLimit: process.env.SESSION_MEM_LIMIT ?? '2g',
  idleStopSec: Number(process.env.IDLE_STOP_SEC ?? 900),
  gcDays: Number(process.env.GC_DAYS ?? 14),
  adapterImagePrefix: process.env.ADAPTER_IMAGE_PREFIX ?? 'pocketagent',
  networkPolicyDefault: loadNetworkPolicyDefault(),
  networkAllowlist: loadNetworkAllowlist(),
  egressProxyPort: Number(process.env.EGRESS_PROXY_PORT ?? 3128),
  sessionPidsLimit: Number(process.env.SESSION_PIDS_LIMIT ?? 512),
} as const;
