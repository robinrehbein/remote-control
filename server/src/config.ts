import { existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { NetworkPolicy } from '@pocketagent/protocol';

export const SERVER_VERSION = '0.2.0';

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

/**
 * Optionaler Docker-Endpunkt. In v2 ist das immer *derselbe* Daemon, nur anders
 * erreicht (Socket-Proxy `http://socket-proxy:2375`, `unix://…`): der
 * Fly-Modus mit einem echten Fremd-Daemon und der Gateway-Container sind
 * bewusst entfallen (GREENFIELD-PI.md, Nicht-Ziele). Ohne die Variable wird
 * `/var/run/docker.sock` benutzt.
 */
function dockerHost(): string | null {
  const raw = process.env.DOCKER_HOST?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function b64Env(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const buf = Buffer.from(raw, 'base64');
  return buf.length > 0 ? buf.toString() : undefined;
}

/**
 * Getrimmter Env-Wert oder undefined - Leerstring gilt als "nicht gesetzt".
 * Die gemeinsame Form all der optionalen Fly-/Registry-Variablen, damit jede
 * einzelne nur ihren Warum-Kommentar tragen muss.
 */
function optionalEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

/**
 * Hosts, die eine Session unter der Policy 'allowlist' erreichen darf. Gegenüber
 * v1 sind die Adapter-spezifischen Einträge (models.dev für kilo) raus; geblieben
 * sind GitHub (Clone/Push/PR), die pi-Provider-Endpunkte und die Paket-Registries,
 * die ein Agent beim Bauen braucht.
 */
const DEFAULT_NETWORK_ALLOWLIST = [
  'github.com',
  'api.github.com',
  '*.githubusercontent.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  // pi-Provider (PI_PROVIDER_ENV): openai, anthropic, google, zai, moonshot/kimi
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.z.ai',
  'open.bigmodel.cn',
  'api.moonshot.ai',
  'api.moonshot.cn',
  // Paket-Registries für Builds/Tests im Repo der Session
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
  return parseAllowlist(raw);
}

/** Comma separated host list -> normalized allowlist entries. */
export function parseAllowlist(raw: string): string[] {
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/** Optional per-session CPU limit in docker NanoCPUs (e.g. 1000000000 = 1 CPU); undefined when unset/invalid. */
function loadSessionCpuQuota(): number | undefined {
  const raw = process.env.SESSION_CPU_QUOTA?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/**
 * Whether the process sits behind a reverse proxy (Coolify/Traefik) that sets
 * X-Forwarded-For. Only then may that header be trusted for req.ip - directly
 * exposed, it is client-spoofable.
 */
function loadTrustProxy(): boolean {
  const raw = process.env.TRUST_PROXY;
  return raw === '1' || raw === 'true';
}

/**
 * Tag des Runner-Images. Vorgabe ist der zur Buildzeit eingebrannte Wert
 * (`RUNNER_IMAGE_TAG` als Docker-ARG/ENV im server/Dockerfile), sonst 'latest'.
 * Ein Tagwechsel erzwingt einen Neubau, weil `ensureRunnerImage` dann kein
 * Image dieses Namens findet - das ist die ganze Invalidierung, die v2 hat
 * (das Content-Hash-System aus v1 ist entfallen).
 */
function loadRunnerImageTag(): string {
  return process.env.RUNNER_IMAGE_TAG?.trim() || 'latest';
}

/**
 * Vollständig vorgegebenes Runner-Image (z. B. `ghcr.io/acme/pi-runner:2026-08`).
 * Ist es gesetzt, wird ausschließlich gepullt und nie gebaut - der Betreiber
 * besitzt das Artefakt und ein lokal gebautes darf es nicht verdecken.
 */
function loadRunnerImageOverride(): string | null {
  const raw = process.env.RUNNER_IMAGE?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/* ------------------------------------------------------------------ */
/* Fly-Sessions (Machines-API, F2)                                     */
/* ------------------------------------------------------------------ */

const flyApiToken = optionalEnv('FLY_API_TOKEN');

/**
 * Deckel für gleichzeitig laufende Fly-Machines. Ungültige Werte fallen auf 3
 * zurück - ein Deckel, der wegen eines Tippfehlers auf 0 fiele, nähme Fly-
 * Sessions komplett aus, einer auf NaN wäre gar keiner.
 */
function loadFlyMaxMachines(): number {
  const raw = process.env.FLY_MAX_MACHINES?.trim();
  if (!raw) return 3;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    console.warn(`[config] invalid FLY_MAX_MACHINES "${raw}" - falling back to 3`);
    return 3;
  }
  return Math.floor(n);
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dataDir: resolve(process.env.DATA_DIR ?? './data'),
  masterKey: loadMasterKey(),
  dockerEnabled: loadDockerEnabled(),
  /** null => /var/run/docker.sock; sonst derselbe Daemon über einen Socket-Proxy. */
  dockerHost: dockerHost(),
  dockerTls: {
    ca: b64Env('DOCKER_CLIENT_CA_B64'),
    cert: b64Env('DOCKER_CLIENT_CERT_B64'),
    key: b64Env('DOCKER_CLIENT_KEY_B64'),
  },
  networkName: process.env.NETWORK_NAME ?? 'pocketagent',
  sessionMemLimit: process.env.SESSION_MEM_LIMIT ?? '2g',
  idleStopSec: Number(process.env.IDLE_STOP_SEC ?? 900),
  gcDays: Number(process.env.GC_DAYS ?? 14),
  /** Namensraum des Runner-Images (`<prefix>/pi-runner:<tag>`). */
  runnerImagePrefix: process.env.RUNNER_IMAGE_PREFIX ?? 'pocketagent',
  runnerImageTag: loadRunnerImageTag(),
  /** Gesetzt => pull statt build (siehe loadRunnerImageOverride). */
  runnerImage: loadRunnerImageOverride(),
  networkPolicyDefault: loadNetworkPolicyDefault(),
  networkAllowlist: loadNetworkAllowlist(),
  egressProxyPort: Number(process.env.EGRESS_PROXY_PORT ?? 3128),
  sessionPidsLimit: Number(process.env.SESSION_PIDS_LIMIT ?? 512),
  /** Optional per-session CPU limit in docker NanoCPUs (undefined = unlimited). */
  sessionCpuQuota: loadSessionCpuQuota(),
  /** Trust X-Forwarded-For from a reverse proxy in front of the server (see TRUST_PROXY). */
  trustProxy: loadTrustProxy(),
  /** Fly-Sessions: aktiviert allein durch das Vorhandensein eines API-Tokens. */
  flyEnabled: flyApiToken !== undefined,
  flyApiToken,
  /** Machines-API (v6); api.machines.dev ist ein Alias der Plattform-API. */
  flyApiBase: optionalEnv('FLY_API_BASE') ?? 'https://api.machines.dev',
  /** Nur nötig, solange die App noch nicht existiert (einmalige Anlage, siehe fly.ensureApp). */
  flyOrgSlug: optionalEnv('FLY_ORG_SLUG'),
  flyAppName: optionalEnv('FLY_APP_NAME') ?? 'pocketagent-sessions',
  flyRegion: optionalEnv('FLY_REGION'),
  /** Fertiger Image-Ref der Machine; gesetzt => es wird nie gebaut oder gepusht. */
  flyImage: optionalEnv('FLY_IMAGE'),
  /** Deckel gleichzeitig laufender Fly-Machines (creating/running/idle), siehe loadFlyMaxMachines. */
  flyMaxMachines: loadFlyMaxMachines(),
  /** Ziel-Ref des Image-Pushs (z. B. ghcr.io/acme/fly-link:tag). Ohne ihn muss FLY_IMAGE gesetzt sein. */
  ghcrImage: optionalEnv('GHCR_IMAGE'),
  /** Registry-Credentials für den Push - Infra-Token des Orchestrators, nicht Vault (siehe fly.ts). */
  ghcrPushToken: optionalEnv('GHCR_PUSH_TOKEN'),
  ghcrUsername: optionalEnv('GHCR_USERNAME'),
  /** Öffentliche Basis-URL; PA_SERVER der Machine wird daraus abgeleitet (https->wss, http->ws). */
  publicUrl: optionalEnv('PUBLIC_URL'),
  /** Öffentliche URL des Egress-Proxys ohne Userinfo; Pflicht für Fly-Sessions mit Policy 'allowlist'. */
  egressPublicUrl: optionalEnv('EGRESS_PUBLIC_URL'),
} as const;

/**
 * Der eine Image-Name, unter dem Session-Container laufen. `RUNNER_IMAGE`
 * schlägt alles; sonst `<RUNNER_IMAGE_PREFIX>/pi-runner:<RUNNER_IMAGE_TAG>`.
 */
export function runnerImageName(): string {
  return config.runnerImage ?? `${config.runnerImagePrefix}/pi-runner:${config.runnerImageTag}`;
}
