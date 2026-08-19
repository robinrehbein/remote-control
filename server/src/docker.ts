import Docker from 'dockerode';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tar from 'tar-fs';
import type { NetworkPolicy, NoticePhase } from '@pocketagent/protocol';
import { config, isNetworkPolicy } from './config.js';
import { normalizePeerIp } from './egress-proxy.js';
import {
  BUILD_NOTICE_INTERVAL_MS,
  LOG_TAIL_LINES,
  buildProgressMessage,
  createThrottle,
  detailFrom,
  redactTokens,
  stripLogFraming,
} from './progress.js';
import { RUNNER_PORT, RUNNER_PUSH_SCRIPT, RUNNER_WORK_DIR, runnerContextFiles, runnerContextRoot, runnerImageName } from './runner.js';
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
  runnerImageReady = null;
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
 * every start additionally primes it (startContainer), so a runner's very first
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
 * Synchronous gate for the egress proxy: which session does `ip` belong to?
 * Answers from the cache and refreshes it in the background when stale - the
 * proxy must never block a request on a daemon round trip.
 */
export function sessionIdForPeerIp(ip: string): string | null {
  if (Date.now() - peerIpsAt >= PEER_CACHE_TTL_MS) void refreshSessionPeers();
  return peerIps.get(normalizePeerIp(ip)) ?? null;
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

/* ------------------------------------------------------------------ */
/* Runner-Image                                                        */
/* ------------------------------------------------------------------ */

let runnerImageReady: Promise<string> | null = null;

/**
 * Das Runner-Image auf dem Daemon verfügbar machen - minimal und ohne jede
 * Hash-Rechnung (das Content-Hash-System aus v1 ist entfallen).
 *
 * Reihenfolge:
 *  1. schon lokal vorhanden -> fertig,
 *  2. `RUNNER_IMAGE` gesetzt -> ausschließlich pullen. Dann besitzt der
 *     Betreiber das Artefakt; ein lokal gebautes dürfte es nicht verdecken,
 *     also ist ein fehlgeschlagener Pull hier ein Fehler,
 *  3. sonst aus dem im Server-Image mitgelieferten Kontext bauen
 *     (`runner/Dockerfile`, siehe runner.ts). Das ist der Normalfall: Coolify
 *     baut nur `server/Dockerfile`, das Runner-Image entsteht deshalb beim
 *     ersten Session-Start auf dem Host.
 *
 * Das Ergebnis wird für die Prozesslaufzeit gecacht (parallele Session-Starts
 * teilen einen Bau); ein Fehlschlag wird verworfen, damit der nächste Start es
 * erneut versucht.
 */
export async function ensureRunnerImage(onNotice?: NoticeFn): Promise<string> {
  if (!runnerImageReady) {
    runnerImageReady = provideRunnerImage(onNotice).catch((e: unknown) => {
      runnerImageReady = null;
      throw e;
    });
  }
  return runnerImageReady;
}

async function provideRunnerImage(onNotice?: NoticeFn): Promise<string> {
  const image = runnerImageName();
  const d = docker();
  if (!d) return image; // Docker aus: der Aufrufer scheitert ohnehin mit klarer Meldung
  if (await imageExists(d, image)) return image;
  await pullImage(image);
  if (await imageExists(d, image)) return image;
  if (config.runnerImage !== null) {
    throw new Error(
      `Runner-Image ${image} ist über RUNNER_IMAGE fest vorgegeben, liegt aber weder lokal vor noch konnte es ` +
        `aus der Registry geladen werden. Image bereitstellen oder RUNNER_IMAGE entfernen, damit der Server es selbst baut.`,
    );
  }
  if (runnerContextFiles() === null) {
    throw new Error(
      `Runner-Image ${image} fehlt und kann nicht gebaut werden: im Server-Image liegt kein Build-Kontext ` +
        `(erwartet runner/Dockerfile neben packages/protocol und tsconfig.base.json).`,
    );
  }
  try {
    await buildRunnerImage(d, image, onNotice);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Runner-Image ${image} fehlt und konnte nicht gebaut werden: ${msg}`);
  }
  return image;
}

/** Cause plus the last build-log lines, trimmed for an error message (never full logs). */
function withTail(cause: string, lines: string[], n = 8): string {
  const last = lines.slice(-n).join(' | ');
  return last.length > 0 ? `${cause} (${last})` : cause;
}

/**
 * Das Runner-Image über die Docker-API bauen. Der Kontext wird in ein
 * Wegwerf-Verzeichnis gestaged (dieselbe relative Struktur, die
 * `runner/Dockerfile` erwartet) und als tar an den Daemon gestreamt.
 *
 * Exportiert, damit der Smoke den Bau gegen einen gefälschten Daemon prüfen
 * kann - regulär ruft ihn nur `provideRunnerImage`.
 */
export async function buildRunnerImage(d: Docker, image: string, onNotice?: NoticeFn): Promise<void> {
  const root = runnerContextRoot();
  const files = runnerContextFiles();
  if (root === null || files === null) throw new Error('kein Build-Kontext im Server-Image');
  onNotice?.('Runner-Image wird gebaut – erster Start auf diesem Host, das dauert einige Minuten …', {
    phase: 'container-start',
  });
  console.log(`[runner-image] building ${image} from ${files.length} context files`);
  const started = Date.now();
  const ctx = mkdtempSync(join(tmpdir(), 'pa-runner-ctx-'));
  // Der Pack streamt von der Platte, während der Daemon liest. Bricht der Bau
  // früh ab (Daemon nicht erreichbar), zöge das Aufräumen dem noch lesenden
  // Stream die Dateien weg - dessen unbehandeltes 'error' nähme den Prozess mit.
  let pack: ReturnType<typeof tar.pack> | null = null;
  try {
    for (const rel of files) cpSync(join(root, rel), join(ctx, rel), { dereference: true, recursive: false });
    pack = tar.pack(ctx);
    pack.on('error', () => {});
    // Kontext-Layout == Repo-Root, `dockerfile` ist also der Pfad, den
    // runner/Dockerfile selbst dokumentiert (`docker build -f runner/Dockerfile .`).
    const stream = await d.buildImage(pack, { t: image, dockerfile: 'runner/Dockerfile' });
    // Ein gescheiterter Bau beendet den Stream normal und meldet sich nur in
    // einem `error`-Frame - der Callback von followProgress deckt allein
    // Transportfehler ab, also müssen beide geprüft werden.
    const lines: string[] = [];
    let failure: string | null = null;
    const mayNotice = createThrottle(BUILD_NOTICE_INTERVAL_MS);
    await new Promise<void>((res, rej) => {
      d.modem.followProgress(
        stream,
        (err: Error | null) => (err ? rej(new Error(withTail(err.message, lines))) : res()),
        (ev: { stream?: string; error?: string; errorDetail?: { message?: string } }) => {
          const failed = (ev.error ?? ev.errorDetail?.message ?? '').trim();
          if (failed.length > 0) failure = failed;
          const text = (ev.stream ?? '').trim();
          if (text.length === 0) return;
          lines.push(text);
          // Nur der Schwanz wird je gelesen; ein langer Bau hielte sonst jede Zeile.
          if (lines.length > 200) lines.splice(0, lines.length - 200);
          if (onNotice && mayNotice()) {
            onNotice(buildProgressMessage(lines), { phase: 'container-start', detail: detailFrom(lines) });
          }
        },
      );
    });
    if (failure !== null) throw new Error(withTail(failure, lines));
    const sec = Math.round((Date.now() - started) / 1000);
    console.log(`[runner-image] ${image} built in ${sec}s`);
    onNotice?.(`Runner-Image fertig gebaut (${sec}s) – Session startet.`, { phase: 'container-start' });
  } finally {
    pack?.destroy();
    rmSync(ctx, { recursive: true, force: true });
  }
}

/** Pull an image; failures stay silent here and surface at the caller's imageExists check. */
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

/* ------------------------------------------------------------------ */
/* Netze                                                               */
/* ------------------------------------------------------------------ */

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
 * Attach the orchestrator's own container (HOSTNAME is the container id inside
 * docker) to a network so it can reach session runners by alias and runners can
 * reach the egress proxy. Idempotent, errors are logged but never thrown (e.g.
 * running outside docker).
 *
 * Works for both variants of the local daemon - raw socket mount and socket
 * proxy - since the proxy talks to the very same daemon, so HOSTNAME still
 * resolves to a container the daemon knows.
 */
export async function ensureSelfAttached(networkName: string): Promise<string | null> {
  const d = docker();
  if (!d) return null;
  const selfId = process.env.HOSTNAME;
  // Without HOSTNAME there is no way to name our own container to the daemon.
  // Silently skipping used to leave the session reachable by nobody, surfacing
  // minutes later as a bare "runner did not become ready in time".
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
 * Der Orchestrator erreicht den Runner nur über das Docker-Netz der Session, und
 * eine 'allowlist'-Session erreicht den Egress-Proxy nur denselben Weg. Ein
 * fehlgeschlagenes Anbinden muss die Session deshalb sofort mit der echten
 * Ursache scheitern lassen, statt in den Bereitschafts-Timeout zu laufen.
 */
async function requireAttached(session: SessionRow): Promise<void> {
  const failure = await attachOrchestratorTo(session);
  if (failure === null) return;
  throw new Error(
    `${failure} Ohne diese Anbindung ist der Agent-Container nicht erreichbar. ` +
      'Prüfe, ob der Orchestrator selbst als Docker-Container mit gesetztem HOSTNAME läuft.',
  );
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
    for (const cid of Object.keys(members)) {
      const isSelf = selfId !== undefined && selfId.length > 0 && cid.startsWith(selfId);
      if (isSelf) {
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

/** Validate the session row's network policy (fallback: config default). */
function policyFor(session: SessionRow): NetworkPolicy {
  const raw = session.network_policy;
  return isNetworkPolicy(raw) ? raw : config.networkPolicyDefault;
}

/**
 * Netz, auf dem der Container einer Session lebt: 'open' teilt sich das
 * Hauptnetz, 'allowlist'/'isolated' bekommen je ein eigenes internes. Pur -
 * einzige Quelle für Session-Start und Startup-Reconcile.
 */
export function sessionNetworkFor(session: SessionRow): string {
  return policyFor(session) === 'open' ? config.networkName : sessionNetworkName(session.id);
}

/**
 * (Re)establish the link between the orchestrator and a session's network,
 * creating the network when it is missing. Idempotent; returns null when the
 * link stands, otherwise its German cause. Needed on every path that has to
 * talk to a runner - including a freshly deployed orchestrator container, which
 * starts out attached to no session network at all.
 */
export async function attachOrchestratorTo(session: SessionRow): Promise<string | null> {
  const name = sessionNetworkFor(session);
  await ensureNetworkExists(name, name !== config.networkName);
  return ensureSelfAttached(name);
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
  const netName = sessionNetworkFor(session);
  await requireAttached(session);
  // 'isolated' behält beide Vorgaben - und bekommt auch keinen brauchbaren
  // Proxy: der Orchestrator hängt zwar an seinem Netz, weist aber jede Anfrage
  // einer Session ab, deren Policy 'isolated' sagt (egress-proxy.ts, 'policy').
  let egress = 'none';
  let auth = 'n/a';
  if (policy === 'allowlist') {
    // Proxy-Auth: der Egress-Proxy akzeptiert Anfragen mit gültigem
    // Session-Token (Basic "pa:<token>"). Jeder Aufrufer muss deshalb eine
    // Zeile hereinreichen, die ihren shim_token schon trägt (provision staged
    // ihn, resumeSession/push weisen eine unprovisionierte Session ab) - eine
    // URL ohne Credentials ließe die Session allein vom Peer-IP-Gate abhängen,
    // daher das auth= in der Logzeile unten.
    const userinfo = session.shim_token ? `pa:${session.shim_token}@` : '';
    const proxyHost = `${ORCHESTRATOR_ALIAS}:${config.egressProxyPort}`;
    env.HTTP_PROXY = `http://${userinfo}${proxyHost}`;
    env.HTTPS_PROXY = `http://${userinfo}${proxyHost}`;
    env.NO_PROXY = 'localhost,127.0.0.1';
    // Node beachtet keine der drei Variablen von sich aus, deshalb nagelt der
    // Runner undicis globalen Dispatcher selbst fest (installEnvProxyDispatcher
    // aus dem Protokoll). Dieses Flag ist die zweite Hälfte des Gürtels: nur es
    // leitet auch nodes anderen Client (http/https.request) um und erreicht
    // jeden Kindprozess, den der Runner startet. Node-Builds, die die Variable
    // nicht kennen, ignorieren sie. (PR #57)
    env.NODE_USE_ENV_PROXY = '1';
    egress = proxyHost;
    auth = userinfo ? 'yes' : 'no';
  }
  // Die eine Zeile, die eine kaputte Egress-Einrichtung von einem kaputten Netz
  // unterscheidbar macht (ohne Geheimnisse: Host und Vorhandensein von Credentials).
  console.log(
    `[docker] session ${session.id.slice(0, 8)} policy=${policy} net=${netName} egress=${egress} auth=${auth}`,
  );
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

/* ------------------------------------------------------------------ */
/* Container                                                           */
/* ------------------------------------------------------------------ */

/** One ustar header (512 bytes) + data padded to a 512-byte block. uid/gid 1000 = 'node' in the runner image. */
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
 * GITHUB_PAT container env (K2 contract): the runner reads PA_CREDS_FILE at
 * runtime. putArchive writes are daemon-side and work on a not-yet-started
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
  const image = await ensureRunnerImage(onNotice);
  try {
    await ensureVolume(session.volume_name);
    const c = await d.createContainer({
      Image: image,
      Env: envArr(containerEnv),
      Labels: { [SESSION_LABEL]: session.id },
      HostConfig: {
        Memory: parseMem(config.sessionMemLimit),
        Binds: [`${session.volume_name}:${RUNNER_WORK_DIR}`],
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        PidsLimit: config.sessionPidsLimit,
        ReadonlyRootfs: true,
        // ausführbares /tmp: der Runner legt sein GIT_ASKPASS-Helferskript dort ab
        Tmpfs: { '/tmp': 'rw,size=1g' },
        ...(config.sessionCpuQuota ? { NanoCpus: config.sessionCpuQuota } : {}),
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
  let started: boolean;
  try {
    await d.getContainer(id).start();
    started = true;
  } catch (e) {
    started = String(e).includes('already started');
  }
  // A container only has an IP once it runs: reloading here is what lets the
  // egress proxy authorize the runner's very first request by peer IP.
  if (started) await refreshSessionPeers();
  return started;
}

/**
 * Base URL des Runners. Lokal ist das immer der Docker-Netz-Alias, deshalb
 * `null` - der Aufrufer setzt `http://<sessionId>:8080` ein. Die Funktion (und
 * die Spalte `shim_endpoint`) bleiben, weil Link-Sessions und Tests einen
 * expliziten Endpunkt setzen.
 */
export function runnerEndpoint(): string | null {
  return null;
}

/** Default-Basis-URL eines Session-Runners im lokalen Docker-Netz. */
export function defaultRunnerBase(sessionId: string): string {
  return `http://${sessionId}:${RUNNER_PORT}`;
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
 * Last log lines of a container plus its exit state. When a runner never becomes
 * ready, its own stderr holds the reason (failed clone, missing key, crash) -
 * without this the app only ever sees "runner did not become ready in time".
 * Token-shaped words are masked: runner logs are not supposed to contain
 * secrets, but this text is forwarded to the app and the server log.
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
    const list = await d.listContainers({ filters: { label: [SESSION_LABEL] } });
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
    const image = await ensureRunnerImage(onNotice);
    const containerEnv = { ...env };
    const networking = await sessionNetworking(session, containerEnv);
    const c = await d.createContainer({
      Image: image,
      Env: envArr(containerEnv),
      Cmd: ['node', RUNNER_PUSH_SCRIPT],
      Labels: { [SESSION_LABEL]: session.id },
      HostConfig: {
        Memory: parseMem(config.sessionMemLimit),
        Binds: [`${session.volume_name}:${RUNNER_WORK_DIR}`],
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        PidsLimit: config.sessionPidsLimit,
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,size=1g' },
        ...(config.sessionCpuQuota ? { NanoCpus: config.sessionCpuQuota } : {}),
      },
      NetworkingConfig: networking,
    });
    pushContainer = c;
    if (creds && Object.keys(creds).length > 0) await injectCredsFile(c.id, creds);
    await c.start();
    await refreshSessionPeers(); // der Push-Container pusht durch denselben Egress-Proxy
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
