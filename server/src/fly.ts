/**
 * Fly-Sessions (F2): schlanker Client für die Fly-Machines-API (v6,
 * https://machines.dev) plus die beiden Provisionierungs-Vorleistungen App und
 * Machine-Image.
 *
 * Bewusst ohne flyctl und ohne neue Dependency: die Machines-API ist gewöhnliches
 * HTTP mit `Authorization: Bearer <FLY_API_TOKEN>`, globales fetch reicht. Die
 * Basis-URL kommt aus config (flyApiBase), ist also zur Laufzeit überschreibbar
 * - der Smoke-Test treibt diesen Client gegen einen gefälschten HTTP-Server.
 *
 * Infra-Tokens (FLY_API_TOKEN, GHCR_PUSH_TOKEN) sind Env des Orchestrators wie
 * PAIRING_ADMIN_TOKEN auch, NICHT Vault-Secrets: sie authentisieren den
 * Betreiber gegen Fly bzw. die Registry, während der Vault die Schlüssel der
 * *Sessions* hält (Provider-Key, GitHub-PAT), die auf die Machine wandern.
 * SECURITY gilt auch hier: Kein Request-Body wird je geloggt (er trägt
 * PA_TOKEN/Provider-Key der Session), Fehler tragen nur Status + gekürzten
 * Antwort-Schnappschuss.
 */
import type Docker from 'dockerode';
import { config } from './config.js';
import { buildRunnerImage, dockerDaemon, imageExists, withTail } from './docker.js';
import type { NoticeFn } from './docker.js';

/** Timeout je Machines-API-Request; Boot/Destroy der Alpha-API sind langsam, 30 s sind großzügig. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Poll-Intervall von waitUntilMachine: die Destroy-Alpha reagiert verzögert, also kurze Intervalle. */
const POLL_INTERVAL_MS = 1_500;
/** Länge des Body-Schnappschrots in Fehlermeldungen - genug zum Erkennen, zu kurz zum Auspacken. */
const BODY_SNAPSHOT_LEN = 400;

/** Fehler der Machines-API mit Status und gekürztem Antwortkörper (nie der Request). */
export class FlyApiError extends Error {
  readonly status: number;
  constructor(op: string, status: number, body: string) {
    const snapshot = body.replace(/\s+/g, ' ').trim().slice(0, BODY_SNAPSHOT_LEN);
    super(`Fly-API ${op} scheiterte (HTTP ${status}${snapshot ? `: ${snapshot}` : ''})`);
    this.name = 'FlyApiError';
    this.status = status;
  }
}

export interface FlyMachine {
  id: string;
  name?: string;
  /** 'created'|'starting'|'started'|'stopping'|'stopped'|'destroyed'|… (Alpha-Alphabet). */
  state?: string;
  [key: string]: unknown;
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  query?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Statuscodes, die der Aufrufer selbst behandelt (z. B. 404 als "existiert
   * nicht") statt sie zu FlyApiError zu machen. Nur für Codes mit definierter
   * Bedeutung, niemals als universelles Fehler-Schlucken.
   */
  accept?: readonly number[];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Ein Request gegen die Plattform-API. Baut die URL an flyApiBase (dasselbe
 * Origin bedient v6-Machines und v3-Apps - api.machines.dev ist ein Alias von
 * api.fly.io), setzt den Bearer, timeoutet über AbortController und verwandelt
 * jede Nicht-2xx-Antwort in FlyApiError mit Body-Schnappschuss.
 */
async function api(path: string, opts: RequestOptions): Promise<{ status: number; json: unknown }> {
  if (!config.flyApiToken) {
    throw new Error('FLY_API_TOKEN fehlt - Fly-Sessions sind auf diesem Server nicht konfiguriert.');
  }
  const url = new URL(path, config.flyApiBase);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method,
      headers: {
        authorization: `Bearer ${config.flyApiToken}`,
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ac.signal,
    });
  } catch (e) {
    throw new Error(
      `Fly-API ${opts.method} ${path} nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok && !(opts.accept ?? []).includes(res.status)) {
    throw new FlyApiError(`${opts.method} ${path}`, res.status, text);
  }
  return { status: res.status, json: parseJson(text) };
}

function machinesPath(suffix = ''): string {
  return `/v6/apps/${encodeURIComponent(config.flyAppName)}/machines${suffix}`;
}

/** Alle Machines der App (GET /v6/apps/{app}/machines). */
export async function listMachines(): Promise<FlyMachine[]> {
  const res = await api(machinesPath(), { method: 'GET' });
  return Array.isArray(res.json) ? (res.json as FlyMachine[]) : [];
}

/** Konfiguration einer neuen Machine (createMachine); Env siehe sessions.buildFlyMachineEnv. */
export interface CreateMachineInput {
  image: string;
  env: Record<string, string>;
  region?: string;
}

/**
 * Machine anlegen und sofort starten (skip_launch ist nicht gesetzt). Die
 * Restart-Policy 'always' ist der Lifecycle der Fly-Session: Die Machine soll
 * nach Crash, Host-Wartung und Stop durch die API wieder aufstehen und neu
 * dialen - ein Orchestrator-Stop (Abrechnung pausieren) ist der einzige Weg,
 * sie unten zu halten, weil agent.bye sie sonst sofort neu starten würde.
 */
export async function createMachine(input: CreateMachineInput): Promise<FlyMachine> {
  const res = await api(machinesPath(), {
    method: 'POST',
    body: {
      ...(input.region ? { region: input.region } : {}),
      config: {
        image: input.image,
        env: input.env,
        restart: { policy: 'always' },
        // Disk-less by design: kein Volume, kein Mount - der Repo-State lebt im
        // Git (agent/<session-id>), fly-bootstrap klont beim Start frisch.
      },
    },
  });
  const m = res.json as FlyMachine | undefined;
  if (!m || typeof m.id !== 'string' || m.id.length === 0) {
    throw new Error(`Fly-API: createMachine lieferte keine Machine-Id (HTTP ${res.status})`);
  }
  return m;
}

/** Eine Machine abfragen; null, wenn die API sie nicht mehr kennt. */
export async function getMachine(id: string): Promise<FlyMachine | null> {
  const res = await api(machinesPath(`/${encodeURIComponent(id)}`), { method: 'GET', accept: [404] });
  if (res.status === 404) return null;
  const m = res.json as FlyMachine | undefined;
  return m && typeof m.id === 'string' ? m : null;
}

/**
 * Machine stoppen (Abrechnung pausiert, Resume startet sie wieder). 400 ist
 * überwiegend "already stopped" (gleicher Zielzustand), 404 "weg" - beides
 * kein Fehler; alles andere wirft mit Status+Body.
 */
export async function stopMachine(id: string): Promise<void> {
  await api(machinesPath(`/${encodeURIComponent(id)}/stop`), { method: 'POST', accept: [400, 404] });
}

/** Machine starten (Resume-Weg); 400 = "already started", 404 = "weg". */
export async function startMachine(id: string): Promise<void> {
  await api(machinesPath(`/${encodeURIComponent(id)}/start`), { method: 'POST', accept: [400, 404] });
}

/** Machine endgültig entfernen (force = laufende Prozesse mitnehmen). 404 = schon weg. */
export async function destroyMachine(id: string): Promise<void> {
  await api(machinesPath(`/${encodeURIComponent(id)}`), { method: 'DELETE', query: { force: 'true' }, accept: [404] });
}

/**
 * Pollen, bis die Machine den Zustand `state` meldet (Destroy-Alpha: kurze
 * Intervalle, denn Anlegen/Stoppen wirkt erst Sekunden später sichtbar nach).
 * Destroyed unterwegs ist terminal - weiter warten wäre ein Timeout mit Extra-
 * Schritten.
 */
export async function waitUntilMachine(id: string, state: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const m = await getMachine(id);
    if (m === null) throw new Error(`Fly-Machine ${id.slice(0, 8)} existiert nicht mehr (erwartet: '${state}')`);
    if (m.state === state) return;
    if (m.state === 'destroyed') {
      throw new Error(`Fly-Machine ${id.slice(0, 8)} wurde zerstört, bevor sie '${state}' erreichte`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Fly-Machine ${id.slice(0, 8)} erreichte den Zustand '${state}' nicht innerhalb von ` +
          `${Math.round(timeoutMs / 1000)}s (zuletzt: '${m.state ?? 'unbekannt'}')`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

/**
 * Die App einmalig anlegen, wenn die Machines-API sie noch nicht kennt. Das
 * Anlegen selbst ist keine Machines- sondern eine Plattform-Route (/v3/apps);
 * ohne flyOrgSlug bricht es hier mit Handlungsaufforderung ab - eine App kann
 * niemandem zugeordnet werden, ohne dass jemand sagt, wem.
 */
export async function ensureApp(): Promise<void> {
  const probe = await api(machinesPath(), { method: 'GET', accept: [404] });
  if (probe.status !== 404) return;
  if (!config.flyOrgSlug) {
    throw new Error(
      `Die Fly-App "${config.flyAppName}" existiert noch nicht. ` +
        'FLY_ORG_SLUG setzen, damit die Fly-App einmalig angelegt werden kann.',
    );
  }
  await api('/v3/apps', {
    method: 'POST',
    body: { app_name: config.flyAppName, org_slug: config.flyOrgSlug },
    accept: [409], // Concurrent-Anlage (zweiter paralleler Session-Start): App existiert dann bereits.
  });
  console.log(`[fly] app "${config.flyAppName}" created in org "${config.flyOrgSlug}"`);
}

/* ------------------------------------------------------------------ */
/* Machine-Image                                                       */
/* ------------------------------------------------------------------ */

/** Ref des lokal gebauten Fly-Link-Images (runner/Dockerfile.fly, wie docker-compose.yml). */
export function flyLinkImageName(): string {
  return `${config.runnerImagePrefix}/fly-link:${config.runnerImageTag}`;
}

let pushedImage: Promise<string> | null = null;

/** Memo für den Smoke (Prozess-Grenzen gibt es dort nicht). */
export function resetFlyImageMemo(): void {
  pushedImage = null;
}

/**
 * Der Image-Ref, von dem Fly-Machines starten - einmal pro Prozess ermittelt
 * (parallele Session-Starts teilen Build und Push; ein Fehlschlag verwirft das
 * Memo, damit der nächste Start es erneut versucht, wie ensureRunnerImage in
 * docker.ts):
 *  - FLY_IMAGE gesetzt => genau dieser Ref. Nicht builden, nicht pushen - der
 *    Betreiber besitzt das Artefakt (Default-Fall: das öffentliche ghcr-Image,
 *    das Fly anonym ziehen kann, ganz ohne Registry-Auth).
 *  - sonst GHCR_IMAGE => das lokal gebaute Fly-Link-Image (runner/Dockerfile.fly,
 *    Baumechanik aus docker.ts wiederverwendet) dorthin taggen + pushen.
 *  - beides fehlend => Fehler mit den beiden Wegen aus der Meldung.
 */
export async function ensureRunnerImage(onNotice?: NoticeFn): Promise<string> {
  if (!pushedImage) {
    pushedImage = provideRunnerImage(onNotice).catch((e: unknown) => {
      pushedImage = null;
      throw e;
    });
  }
  return pushedImage;
}

async function provideRunnerImage(onNotice?: NoticeFn): Promise<string> {
  if (config.flyImage) return config.flyImage;
  if (!config.ghcrImage) {
    throw new Error(
      'Für Fly-Sessions fehlt das Machine-Image: FLY_IMAGE mit einem fertigen Ref setzen ' +
        '(z. B. das öffentliche ghcr-Image) oder GHCR_IMAGE (Ziel-Ref), damit der Server das Image dorthin pusht.',
    );
  }
  if (!config.ghcrPushToken || !config.ghcrUsername) {
    throw new Error('GHCR_IMAGE ist gesetzt, aber GHCR_PUSH_TOKEN/GHCR_USERNAME fehlen - ohne Registry-Auth kann das Image nicht gepusht werden.');
  }
  const d = dockerDaemon();
  if (!d) {
    throw new Error('Docker ist auf diesem Server deaktiviert - für den Image-Push FLY_IMAGE mit einem fertigen Ref setzen oder Docker aktivieren.');
  }
  const local = await ensureLocalFlyImage(d, onNotice);
  await pushImage(d, local, config.ghcrImage);
  return config.ghcrImage;
}

/** Lokales Fly-Link-Image sicherstellen: vorhanden nehmen, sonst aus dem Kontext bauen. */
async function ensureLocalFlyImage(d: Docker, onNotice?: NoticeFn): Promise<string> {
  const image = flyLinkImageName();
  if (await imageExists(d, image)) return image;
  await buildRunnerImage(d, image, onNotice, 'runner/Dockerfile.fly');
  return image;
}

/** Ref in repo + tag zerlegen (Doppelpunkt nach dem letzten Schrägstrich ist der Tag- Separator). */
function splitImageRef(ref: string): { repo: string; tag: string } {
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  return colon > slash ? { repo: ref.slice(0, colon), tag: ref.slice(colon + 1) } : { repo: ref, tag: 'latest' };
}

/** serveraddress der Registry-Anteils eines Refs (für die Auth-Challenge der Push-Route). */
function registryServerAddress(repo: string): string {
  const first = repo.split('/')[0] ?? '';
  return first.includes('.') ? `https://${first}` : 'https://index.docker.io';
}

/**
 * Lokales Image als Ziel-Ref taggen und pushen. Die Credentials ({username,
 * password}) wandern als X-Registry-Auth-Header (base64-JSON, setzt dockerode
 * aus dem authconfig-Argument) - sie erscheinen weder im Request-Log noch in
 * Fehlermeldungen. Der Push-Stream wird wie ein Build verfolgt: Fehler-Frames
 * werden zur Ursache, der Fortschrittsschwanz hängt an der Meldung.
 */
async function pushImage(d: Docker, local: string, remote: string): Promise<void> {
  const { repo, tag } = splitImageRef(remote);
  await d.getImage(local).tag({ repo, tag });
  const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    void d.getImage(`${repo}:${tag}`).push(
      {},
      (err: Error | null, s?: NodeJS.ReadableStream) => {
        if (err || !s) reject(err ?? new Error('push fehlgeschlagen'));
        else resolve(s);
      },
      {
        username: config.ghcrUsername as string,
        password: config.ghcrPushToken as string,
        serveraddress: registryServerAddress(repo),
      },
    );
  });
  const lines: string[] = [];
  let failure: string | null = null;
  await new Promise<void>((resolve, reject) => {
    d.modem.followProgress(
      stream,
      (err: Error | null) => {
        if (err) reject(new Error(withTail(`Image-Push nach ${remote} scheiterte: ${err.message}`, lines)));
        else if (failure !== null) reject(new Error(withTail(`Image-Push nach ${remote} scheiterte: ${failure}`, lines)));
        else resolve();
      },
      (ev: { stream?: string; error?: string; errorDetail?: { message?: string } }) => {
        const failed = (ev.error ?? ev.errorDetail?.message ?? '').trim();
        if (failed.length > 0) failure = failed;
        const text = (ev.stream ?? '').trim();
        if (text.length > 0) {
          lines.push(text);
          if (lines.length > 200) lines.splice(0, lines.length - 200);
        }
      },
    );
  });
  console.log(`[fly] image pushed: ${local} -> ${remote}`);
}

/* ------------------------------------------------------------------ */
/* Env-Ableitungen (pur, auch im Smoke direkt prüfbar)                 */
/* ------------------------------------------------------------------ */

/** PUBLIC_URL in die WS-Form für PA_SERVER (https->wss, http->ws); die Pfad-Ergänzung /ws macht der Link-Agent selbst. */
export function machineServerWsUrl(publicUrl: string): string {
  const u = new URL(publicUrl);
  if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol === 'http:') u.protocol = 'ws:';
  return u.toString().replace(/\/+$/, '');
}

/** Host-Anteil einer URL (für NO_PROXY: genau der Orchestrator darf am Proxy vorbei). */
export function urlHost(url: string): string {
  return new URL(url).host;
}

/**
 * Egress-Proxy-URL mit Basic-Userinfo `pa:<token>@`, wie sie der Egress-Proxy
 * der Session erwartet (Basic "pa:<shim_token>" - dasselbe Muster wie beim
 * Docker-Container, dort ORCHESTRATOR_ALIAS statt der öffentlichen URL).
 */
export function proxyUrlWithAuth(egressPublicUrl: string, token: string): string {
  const u = new URL(egressPublicUrl);
  return `http://pa:${encodeURIComponent(token)}@${u.host}${u.pathname.replace(/\/+$/, '')}`;
}
