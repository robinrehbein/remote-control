/**
 * Smoke-Suite des pi-only Orchestrators.
 *
 * Geschnitten aus der v1-Suite auf die Wege, die der Server nach dem Greenfield
 * noch hat (GREENFIELD-PI.md, Paket G1.2): Pairing inkl. Lockout und
 * Rate-Limit, WS-Auth, der Session-Lebenszyklus gegen eine gefälschte
 * Docker-API, der Egress-Proxy, Link-Token samt Heartbeat, der Vault und
 * `fcm.register`. Alles ohne echten Daemon, ohne Netz und ohne Provider-Key -
 * der echte Durchstich ist Teil der 7-Punkte-Checkliste (G2.2).
 *
 * Lauf: `npm run smoke -w server`. Am Ende steht eine Zusammenfassung.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { ServerMessage } from '@pocketagent/protocol';
import {
  PI_PROVIDER_ENV,
  SECRET_KINDS,
  WS_CLOSE_REPLACED,
  WS_CLOSE_UNAUTHORIZED,
  autoPushForMode,
} from '@pocketagent/protocol';

process.env.DOCKER_ENABLED = '0';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'pa-smoke-'));
process.env.PORT = '0';

const { buildApp } = await import('./index.js');
const { generatePairingCode, SlidingWindowRateLimiter } = await import('./pairing.js');
const { validateSecret } = await import('./secret-validate.js');
const { buildPromptBody, isNoticePhase } = await import('./sessions.js');
const { buildRunnerEnv, proxyTokenFor, runnerImageName } = await import('./runner.js');
type SessionManager = import('./sessions.js').SessionManager;
type Store = import('./db.js').Store;
type SessionRow = import('./db.js').SessionRow;
type FetchLike = import('./secret-validate.js').FetchLike;
const vault = await import('./vault.js');
const admin = await import('./admin.js');
const { sha256 } = await import('./db.js');
const { config } = await import('./config.js');

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

/** Bestandene Prüfungen je Abschnitt - Grundlage der Zusammenfassung am Ende. */
const sections: { name: string; checks: number }[] = [];
let currentSection = 'start';
let checks = 0;

function section(name: string): void {
  if (checks > 0) sections.push({ name: currentSection, checks });
  currentSection = name;
  checks = 0;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`ASSERT FAILED [${currentSection}]: ${msg}`);
    process.exit(1);
  }
  checks++;
}

interface Waiter {
  pred: (m: ServerMessage) => boolean;
  resolve: (m: ServerMessage) => void;
  timer: NodeJS.Timeout;
}

class Client {
  private readonly ws: WebSocket;
  private readonly queue: ServerMessage[] = [];
  private readonly waiters: Waiter[] = [];
  readonly opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    this.ws.on('message', (d) => {
      this.onMessage(JSON.parse(String(d)) as ServerMessage);
    });
  }

  private onMessage(m: ServerMessage): void {
    const i = this.waiters.findIndex((w) => w.pred(m));
    if (i >= 0) {
      const w = this.waiters[i]!;
      clearTimeout(w.timer);
      this.waiters.splice(i, 1);
      w.resolve(m);
      return;
    }
    this.queue.push(m);
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }

  wait(pred: (m: ServerMessage) => boolean, timeoutMs = 15_000): Promise<ServerMessage> {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const j = this.waiters.findIndex((w) => w.resolve === resolve);
        if (j >= 0) this.waiters.splice(j, 1);
        reject(new Error('timeout waiting for message'));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, timer });
    });
  }

  closed(): Promise<boolean> {
    return new Promise((res) => this.ws.once('close', () => res(true)));
  }

  close(): void {
    this.ws.close();
  }

  closeCode(): Promise<number> {
    return new Promise((res) => this.ws.once('close', (code: number) => res(code)));
  }
}

async function request(c: Client, msg: Record<string, unknown> & { requestId: string }): Promise<ServerMessage> {
  c.send(msg);
  return c.wait((m) => 'requestId' in m && m.requestId === msg.requestId);
}

function listen(server: import('node:http').Server): Promise<number> {
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => res((server.address() as AddressInfo).port));
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Poll until `pred` holds; fails the run instead of hanging forever. */
async function waitUntil(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert(false, `timeout waiting for ${what}`);
}

/**
 * Eine provisionierte Session-Zeile: alles, was ein Test nicht interessiert,
 * ist gefüllt, alles Interessante (Status, Policy, Token, Endpunkt) überschreibbar.
 */
function sessionRow(id: string, repoId: string, patch: Partial<SessionRow> = {}): SessionRow {
  const now = new Date().toISOString();
  return {
    id,
    tenant_id: 'default',
    repo_id: repoId,
    repo_full_name: 'acme/demo',
    provider: 'openai',
    model: '',
    mode: 'ask',
    status: 'idle',
    branch: `agent/${id}`,
    session_ref: null,
    container_id: `cid-${id.slice(0, 8)}`,
    volume_name: `pocketagent-sess-${id}`,
    shim_token: null,
    pr_url: null,
    shim_endpoint: null,
    link_id: null,
    network_policy: 'allowlist',
    reasoning_effort: null,
    title: null,
    archived: 0,
    created_at: now,
    last_active_at: now,
    ...patch,
  };
}

/** Raw request against a forward proxy: request-target is the absolute URI. */
function proxyGet(
  http: typeof import('node:http'),
  proxyPort: number,
  absoluteUrl: string,
  token?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: absoluteUrl,
        // same shape git/curl send from the proxy URL's userinfo
        headers: token
          ? { 'proxy-authorization': `Basic ${Buffer.from(`pa:${token}`).toString('base64')}` }
          : {},
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += String(c)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Raw CONNECT against the proxy (the path an https request takes), resolved
 * with the status code of the response line. 407 = refused by a gate, anything
 * else means both gates passed and the tunnel was attempted.
 */
function proxyConnect(
  net: typeof import('node:net'),
  proxyPort: number,
  hostPort: string,
  token?: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      const auth = token ? `Proxy-Authorization: Basic ${Buffer.from(`pa:${token}`).toString('base64')}\r\n` : '';
      sock.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n${auth}\r\n`);
    });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('proxy did not answer the CONNECT'));
    }, 10_000);
    let buf = '';
    sock.on('data', (c) => {
      buf += String(c);
      const status = /^HTTP\/1\.\d (\d{3})/.exec(buf.split('\r\n')[0] ?? '');
      if (!status) return;
      clearTimeout(timer);
      sock.destroy();
      resolve(Number(status[1]));
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/* ------------------------------------------------------------------ */
/* 1. Runner-Konfiguration: Image-Name, Env-Zusammenbau                */
/* ------------------------------------------------------------------ */

/**
 * Die pure Hälfte des Runner-Pakets: der eine Image-Name samt seiner
 * Env-Schalter und die Container-Umgebung nach `ShimEnv`. Beides ist der
 * Vertrag, auf den sich G1.3 (Runner) verlässt.
 */
async function runnerConfigSmoke(): Promise<void> {
  section('runner config');
  const cfg = config as unknown as { runnerImage: string | null; runnerImageTag: string; runnerImagePrefix: string };

  assert(runnerImageName() === 'pocketagent/pi-runner:latest', 'ohne Env-Vorgaben heisst das Image pocketagent/pi-runner:latest');
  cfg.runnerImageTag = '2026-08-19';
  assert(runnerImageName() === 'pocketagent/pi-runner:2026-08-19', 'RUNNER_IMAGE_TAG waehlt den Tag');
  cfg.runnerImage = 'ghcr.io/acme/pi-runner:pinned';
  assert(runnerImageName() === 'ghcr.io/acme/pi-runner:pinned', 'RUNNER_IMAGE gibt das Image vollstaendig vor');
  cfg.runnerImage = null;
  cfg.runnerImageTag = 'latest';

  /* ---- Env: genau EIN Provider-Key, AUTO_PUSH je Modus ---- */

  const vault: Record<string, string> = {
    openai: 'sk-openai-value',
    anthropic: 'sk-ant-value',
    github: 'ghp_value',
  };
  const lookup = (kind: string): string | null => vault[kind] ?? null;

  const env = buildRunnerEnv(
    {
      sessionId: 'sess-1',
      shimToken: 'tok-1',
      mode: 'ask',
      provider: 'openai',
      model: 'gpt-5',
      repoFullName: 'acme/demo',
      baseBranch: 'main',
    },
    lookup,
  );
  assert(env.SHIM_TOKEN === 'tok-1' && env.SESSION_ID === 'sess-1', 'Token und Session-Id landen in der Umgebung');
  assert(env.WORK_DIR === '/work' && env.AGENT_MODE === 'ask', 'WORK_DIR und AGENT_MODE stehen nach ShimEnv');
  assert(env.REPO_URL === 'https://github.com/acme/demo.git', 'REPO_URL wird aus dem vollen Namen gebaut');
  assert(env.REPO_FULL_NAME === 'acme/demo' && env.REPO_BRANCH === 'main', 'Repo-Name und Basis-Branch reisen mit');
  assert(env.PI_PROVIDER === 'openai' && env.PI_MODEL === 'gpt-5', 'Provider und Modell sind Startwerte fuer den Runner');
  assert(env.OPENAI_API_KEY === 'sk-openai-value', 'der Key des gewaehlten Providers wird unter seinem Env-Namen injiziert');
  assert(env.ANTHROPIC_API_KEY === undefined, 'kein zweiter Provider-Key erreicht den Container');
  assert(
    Object.keys(env).filter((k) => (Object.values(PI_PROVIDER_ENV) as string[]).includes(k)).length === 1,
    'genau eine Provider-Env-Variable ist gesetzt',
  );
  assert(env.GITHUB_PAT === undefined, 'der GitHub-PAT reist NICHT ueber die Umgebung (Creds-Datei)');
  assert(env.PA_CREDS_FILE === '/run/secrets/pa/creds.json', 'stattdessen wird der Pfad der Creds-Datei benannt');
  assert(env.AUTO_PUSH === '0', "AUTO_PUSH ist im Modus 'ask' aus");

  const yolo = buildRunnerEnv(
    { sessionId: 's', shimToken: 't', mode: 'yolo', provider: 'zai', model: '', repoFullName: 'a/b', baseBranch: 'main' },
    lookup,
  );
  assert(yolo.AUTO_PUSH === '1', "AUTO_PUSH ist im Modus 'yolo' an");
  assert(yolo.PI_MODEL === undefined, 'ein leeres Modell setzt PI_MODEL gar nicht (pi-Vorgabe)');
  assert(yolo.ZAI_API_KEY === undefined, 'ein Provider ohne hinterlegten Key bekommt keine leere Variable');

  const moon = buildRunnerEnv(
    { sessionId: 's', shimToken: 't', mode: 'auto', provider: 'moonshot', model: 'k2', repoFullName: 'a/b', baseBranch: 'main' },
    () => 'moon-key',
  );
  assert(moon.KIMI_API_KEY === 'moon-key', 'moonshot und kimi teilen sich KIMI_API_KEY (Protokolltabelle)');
  assert(moon.AUTO_PUSH === '0', "AUTO_PUSH ist im Modus 'auto' aus");

  /* ---- moonshot <-> kimi: zwei Secret-Arten, ein Konto ---- */

  // Der Vault kennt nur 'moonshot'; eine Session mit Provider 'kimi' darf davon
  // NICHT ohne Schluessel starten - beides ist derselbe Account bei
  // platform.moonshot.ai und teilt sich ohnehin KIMI_API_KEY.
  const onlyMoonshot = (kind: string): string | null => (kind === 'moonshot' ? 'moon-only' : null);
  const kimiViaMoonshot = buildRunnerEnv(
    { sessionId: 's', shimToken: 't', mode: 'ask', provider: 'kimi', model: '', repoFullName: 'a/b', baseBranch: 'main' },
    onlyMoonshot,
  );
  assert(kimiViaMoonshot.KIMI_API_KEY === 'moon-only', "Provider 'kimi' faellt auf das moonshot-Secret zurueck");

  const onlyKimi = (kind: string): string | null => (kind === 'kimi' ? 'kimi-only' : null);
  const moonshotViaKimi = buildRunnerEnv(
    { sessionId: 's', shimToken: 't', mode: 'ask', provider: 'moonshot', model: '', repoFullName: 'a/b', baseBranch: 'main' },
    onlyKimi,
  );
  assert(moonshotViaKimi.KIMI_API_KEY === 'kimi-only', "Provider 'moonshot' faellt auf das kimi-Secret zurueck");

  // Die eigene Art schlaegt den Alias, und der Fallback bleibt auf dieses eine
  // Paar beschraenkt - kein anderer Provider erbt fremde Schluessel.
  const both = (kind: string): string | null => (kind === 'kimi' ? 'kimi-eigen' : kind === 'moonshot' ? 'moon-eigen' : null);
  assert(
    buildRunnerEnv(
      { sessionId: 's', shimToken: 't', mode: 'ask', provider: 'kimi', model: '', repoFullName: 'a/b', baseBranch: 'main' },
      both,
    ).KIMI_API_KEY === 'kimi-eigen',
    'liegt das eigene Secret vor, wird der Alias nicht gezogen',
  );
  assert(
    buildRunnerEnv(
      { sessionId: 's', shimToken: 't', mode: 'ask', provider: 'openai', model: '', repoFullName: 'a/b', baseBranch: 'main' },
      onlyMoonshot,
    ).OPENAI_API_KEY === undefined,
    'der Fallback gilt nur fuer moonshot/kimi, nicht fuer beliebige Provider',
  );

  const unknown = buildRunnerEnv(
    { sessionId: 's', shimToken: 't', mode: 'ask', provider: 'does-not-exist', model: '', repoFullName: 'a/b', baseBranch: 'main' },
    () => 'irrelevant',
  );
  assert(
    !Object.keys(unknown).some((k) => (Object.values(PI_PROVIDER_ENV) as string[]).includes(k)),
    'ein unbekannter Provider setzt gar keinen Key statt eines falsch benannten',
  );

  // Dieselbe Regel, die der Runner pro Turn anwendet - hier nur als Beleg, dass
  // Server und Runner dieselbe Quelle lesen.
  assert(autoPushForMode('yolo', false) && !autoPushForMode('ask', true), 'autoPushForMode entscheidet ueber den Turn-Modus');
  assert(autoPushForMode(undefined, true), 'ohne Turn-Modus gilt die Env-Vorgabe');

  /* ---- Build-Kontext: Layout und Ausbleiben ---- */

  const { runnerContextFiles, runnerContextRoot } = await import('./runner.js');
  const ctxFiles = runnerContextFiles();
  if (ctxFiles === null) {
    // Solange runner/ noch nicht existiert (Paket G1.3), ist genau das der
    // erwartete Zustand - und der Fehler muss ihn benennen, statt einen
    // Daemon-Fehler vorzuschieben.
    assert(runnerContextRoot() === null, 'ohne runner/Dockerfile gibt es keinen Build-Kontext');
  } else {
    assert(ctxFiles.includes('runner/Dockerfile'), 'der Kontext traegt das Dockerfile des Runners');
    assert(
      ctxFiles.includes('tsconfig.base.json') && ctxFiles.some((f) => f.startsWith('packages/protocol/')),
      'der Kontext hat das Repo-Root-Layout, aus dem runner/Dockerfile kopiert',
    );
    assert(!ctxFiles.some((f) => f.includes('node_modules')), 'der Kontext traegt nie node_modules');
    assert(!ctxFiles.some((f) => f.startsWith('runner/dist/')), 'der Kontext traegt kein Build-Ergebnis (runner/Dockerfile baut selbst)');

    /* ---- Jede COPY-Quelle des Runner-Dockerfiles liegt im Kontext ---- */

    // Docker ist in CI und in dieser Umgebung nicht verfuegbar, der Bau also
    // nicht ausfuehrbar. Was sich trotzdem pruefen laesst - und was in v1
    // regelmaessig auseinanderlief - ist die Kopplung Kontext <-> Dockerfile:
    // eine COPY-Quelle, die im gebuendelten Kontext fehlt, laesst
    // ensureRunnerImage erst beim ersten echten Session-Start scheitern.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = runnerContextRoot() as string;
    const dockerfile = readFileSync(join(root, 'runner', 'Dockerfile'), 'utf8');
    const ctxSet = new Set(ctxFiles);
    const dirs = new Set(ctxFiles.map((f) => f.slice(0, f.lastIndexOf('/'))).filter((d) => d.length > 0));
    const copySources: string[] = [];
    for (const line of dockerfile.split(/\r?\n/)) {
      const m = /^\s*COPY\s+(.*)$/i.exec(line);
      if (!m) continue;
      const parts = (m[1] ?? '').trim().split(/\s+/);
      // `COPY --from=builder …` kopiert aus einer vorherigen Stage, nicht aus
      // dem Kontext; alles andere ist Kontext-relativ (letztes Feld = Ziel).
      if (parts.some((p) => p.startsWith('--from='))) continue;
      copySources.push(...parts.filter((p) => !p.startsWith('--')).slice(0, -1));
    }
    assert(copySources.length > 0, 'das Runner-Dockerfile kopiert ueberhaupt aus dem Kontext');
    for (const src of copySources) {
      assert(ctxSet.has(src) || dirs.has(src), `COPY-Quelle "${src}" liegt im gebuendelten Build-Kontext`);
    }
    assert(
      copySources.includes('tsconfig.base.json'),
      'tsconfig.base.json wird mitkopiert (runner/tsconfig.json extendet darauf)',
    );

    /* ---- Tap-Push: Server-Pfad und Image-Layout sind dieselbe Wahrheit ---- */

    const { RUNNER_PUSH_SCRIPT, RUNNER_PUSH_SCRIPT_REL, RUNNER_IMAGE_DIR } = await import('./runner.js');
    // Das Push-Skript ist jetzt TypeScript (src/push.ts) und wird nach dist/push.js
    // gebaut. Im Kontext liegt also die QUELLE, nicht ein vorgefertigtes JS; das
    // gebaute dist/ kommt im Image aus der Builder-Stage (COPY --from=builder).
    assert(
      ctxSet.has('runner/src/push.ts'),
      'die Push-Skript-Quelle liegt als runner/src/push.ts im Kontext (tsc baut sie nach dist/push.js)',
    );
    assert(
      RUNNER_PUSH_SCRIPT === `${RUNNER_IMAGE_DIR}/${RUNNER_PUSH_SCRIPT_REL}`,
      'der absolute Pfad im Container leitet sich aus WORKDIR + relativem Pfad ab',
    );
    assert(
      RUNNER_PUSH_SCRIPT_REL.startsWith('dist/'),
      'der Push-Pfad zeigt nach dist/ (aus src/push.ts kompiliert, wie dist/index.js)',
    );
    assert(
      copySources.includes('runner/src'),
      'runner/Dockerfile kopiert runner/src (enthaelt push.ts) in die Builder-Stage',
    );
  }

  /* ---- Bau ueber die Docker-API: Fehler-Frame und Fortschritt ---- */

  // Ein gescheiterter Bau beendet den Stream normal und meldet sich nur in
  // einem `error`-Frame; der Callback von followProgress deckt nur
  // Transportfehler ab. Beides muss gepruft werden, sonst gilt ein kaputter
  // Bau als Erfolg und der Session-Start laeuft in den Bereitschafts-Timeout.
  const dockerMod = await import('./docker.js');
  let buildCalls = 0;
  let dockerfileArg = '';
  const fakeDocker = {
    buildImage: (_ctx: unknown, opts: { dockerfile?: string }) => {
      buildCalls++;
      dockerfileArg = opts.dockerfile ?? '';
      return Promise.resolve({} as NodeJS.ReadableStream);
    },
    modem: {
      followProgress: (
        _s: unknown,
        onFinished: (e: Error | null, o: unknown[]) => void,
        onProgress: (ev: Record<string, unknown>) => void,
      ) => {
        setTimeout(() => {
          onProgress({ stream: 'Step 1/12 : FROM node:22-bookworm-slim' });
          onProgress({ stream: 'npm ci: ENOSPC no space left on device' });
          onProgress({ error: 'The command /bin/sh -c npm ci returned a non-zero code: 1' });
          onFinished(null, []);
        }, 10);
      },
    },
  };
  const notices: { message: string; phase?: string; detail?: string }[] = [];
  let buildErr = '';
  await dockerMod
    .buildRunnerImage(fakeDocker as never, 'pa-smoke/pi-runner:test', (message, p) => {
      notices.push({ message, ...p });
    })
    .catch((e: unknown) => {
      buildErr = e instanceof Error ? e.message : String(e);
    });
  if (ctxFiles === null) {
    assert(buildErr.includes('kein Build-Kontext'), 'ohne Kontext scheitert der Bau mit genau dieser Begruendung');
    assert(buildCalls === 0, 'ohne Kontext wird der Daemon gar nicht erst bemueht');
  } else {
    assert(buildCalls === 1, 'der Bau spricht die Docker-API genau einmal an');
    assert(dockerfileArg === 'runner/Dockerfile', 'gebaut wird runner/Dockerfile aus dem Repo-Root-Kontext');
    assert(buildErr.includes('non-zero code: 1'), 'der Fehler-Frame wird zur Ausnahme-Ursache');
    assert(buildErr.includes('ENOSPC'), 'die Ausnahme traegt die letzten Log-Zeilen');
    assert(
      notices[0]?.phase === 'container-start' && notices[0].message.includes('Runner-Image wird gebaut'),
      "der Bau meldet sich als Fortschritt der Phase 'container-start' (die Phase 'image-build' gibt es nicht mehr)",
    );
    assert(
      notices.some((n) => n.message === 'Image wird gebaut (Schritt 1/12)'),
      'der Docker-Schritt wird zur Fortschrittsmeldung',
    );
    assert(
      notices.some((n) => n.detail?.includes('FROM node:22-bookworm-slim') === true),
      'die Meldung traegt den Log-Schwanz als Detail',
    );
  }
}

/* ------------------------------------------------------------------ */
/* 2. Session-Lebenszyklus gegen eine gefaelschte Docker-API           */
/* ------------------------------------------------------------------ */

/**
 * Der Lebenszyklus einer Docker-Session: was passiert, wenn ein Start überholt
 * wird (Delete/Stop während der Provisionierung - der Generation-Zähler), was
 * die GC löschen darf, welche Container der Startup-Reaper entfernt, und die
 * beiden Wächter um Prompt und Resume. Alles gegen einen gefälschten Daemon.
 */
async function lifecycleSmoke(store: Store, manager: SessionManager, c2: Client, repoId: string): Promise<void> {
  section('session lifecycle (fake docker)');
  const http = await import('node:http');
  const dockerMod = await import('./docker.js');
  const { isCollectableSession } = await import('./sessions.js');
  const cfg = config as unknown as { dockerEnabled: boolean; dockerHost: string | null };

  const DAY = 86_400_000;
  const iso = (ms: number): string => new Date(ms).toISOString();
  const rowFor = (id: string, patch: Partial<SessionRow> = {}): SessionRow =>
    sessionRow(id, repoId, { container_id: null, shim_token: `token-${id.slice(0, 8)}`, ...patch });

  /* ---- GC-Kriterium: die Aktivitaet entscheidet, nicht das Erstelldatum ---- */

  const cutoff = Date.now() - 14 * DAY;
  const born = iso(Date.now() - 60 * DAY);
  const longAgo = iso(Date.now() - 40 * DAY);
  const probe = rowFor(randomUUID(), { created_at: born });
  assert(
    !isCollectableSession({ ...probe, status: 'idle', last_active_at: iso(Date.now()) }, cutoff),
    'eine heute benutzte Session ueberlebt ihren 14. Tag',
  );
  assert(
    !isCollectableSession({ ...probe, status: 'stopped', last_active_at: iso(Date.now() - DAY) }, cutoff),
    'eine gestern gestoppte Session ist nicht alt genug',
  );
  assert(
    isCollectableSession({ ...probe, status: 'stopped', last_active_at: longAgo }, cutoff),
    'eine vor 40 Tagen gestoppte Session wird eingesammelt',
  );
  assert(
    isCollectableSession({ ...probe, status: 'error', last_active_at: longAgo }, cutoff),
    'eine nie wieder angefasste Fehler-Session wird eingesammelt',
  );
  assert(
    !isCollectableSession({ ...probe, status: 'idle', last_active_at: longAgo }, cutoff),
    'eine idle Session wird nie eingesammelt',
  );
  assert(
    !isCollectableSession({ ...probe, status: 'stopped', last_active_at: longAgo, link_id: 'link-1' }, cutoff),
    'Link-Sessions werden nie eingesammelt (Delete faehrt den Agenten beim Nutzer herunter)',
  );
  assert(
    !isCollectableSession({ ...probe, status: 'stopped', last_active_at: 'kaputt', created_at: iso(Date.now()) }, cutoff),
    'ein unlesbares last_active_at faellt auf created_at zurueck',
  );

  /* ---- GC ueber den echten Store ---- */

  const activeOld = randomUUID();
  const staleStopped = randomUUID();
  const linkOld = randomUUID();
  store.insertSession(rowFor(activeOld, { status: 'idle', created_at: born, last_active_at: iso(Date.now()) }));
  store.insertSession(rowFor(staleStopped, { status: 'stopped', created_at: born, last_active_at: longAgo }));
  store.insertSession(rowFor(linkOld, { status: 'stopped', created_at: born, last_active_at: longAgo }));
  store.setLinkId(linkOld, 'smoke-link-gc');

  await manager.gc();
  assert(store.getSession(activeOld) !== undefined, 'die GC behaelt eine heute aktive Session, wie alt sie auch ist');
  assert(store.getSession(staleStopped) === undefined, 'die GC entfernt eine seit 40 Tagen gestoppte Session');
  assert(store.getSession(linkOld) !== undefined, 'die GC behaelt eine langlebige Link-Session');
  store.deleteSession(activeOld);
  store.deleteSession(linkOld);

  /* ---- Status-Gate fuer Prompts ---- */

  const booting = randomUUID();
  store.insertSession(rowFor(booting, { status: 'creating' }));
  let promptErr = '';
  await manager.prompt(booting, 'schon mal loslegen').catch((e: unknown) => {
    promptErr = e instanceof Error ? e.message : String(e);
  });
  assert(promptErr.includes('startet noch'), `ein Prompt waehrend 'creating' wird begruendet abgewiesen: ${promptErr}`);
  const stored = store.db
    .prepare('SELECT COUNT(*) AS c FROM session_events WHERE session_id = ?')
    .get(booting) as { c: number };
  assert(stored.c === 0, 'ein abgewiesener Prompt erreicht die Timeline nie');
  assert(store.getSession(booting)?.status === 'creating', 'ein abgewiesener Prompt laesst den Status in Ruhe');
  store.updateSessionStatus(booting, 'stopped');
  promptErr = '';
  await manager.prompt(booting, 'weiter').catch((e: unknown) => {
    promptErr = e instanceof Error ? e.message : String(e);
  });
  assert(promptErr.includes('gestoppt'), `ein Prompt auf einer gestoppten Session wird begruendet abgewiesen: ${promptErr}`);
  store.deleteSession(booting);

  /* ---- gefaelschter Daemon: protokolliert jeden Aufruf, kann ein Create anhalten ---- */

  const calls: string[] = [];
  let nextContainerId = 'cid-unused';
  let createCalls = 0;
  let createSeen: { promise: Promise<void>; resolve: () => void } | null = null;
  let createGate: { promise: Promise<void>; resolve: () => void } | null = null;
  let startFails = false;
  let listBroken = false;
  let listBody: unknown[] = [];

  const daemon = http.createServer((req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';
    const path = url.split('?')[0] ?? '';
    calls.push(`${method} ${path}`);
    const send = (code: number, body: string): void => {
      res.writeHead(code, { 'content-type': 'application/json' }).end(body);
    };
    req.resume();
    if (method === 'POST' && path === '/containers/create') {
      createCalls++;
      const id = nextContainerId;
      createSeen?.resolve();
      const answer = (): void => send(201, JSON.stringify({ Id: id, Warnings: [] }));
      if (createGate) void createGate.promise.then(answer);
      else answer();
      return;
    }
    if (method === 'POST' && /^\/containers\/[^/]+\/start$/.test(path)) {
      if (startFails) return send(500, '{"message":"start refused by the smoke daemon"}');
      return void res.writeHead(204).end();
    }
    if (method === 'GET' && path === '/containers/json') {
      if (listBroken) return send(500, '{"message":"daemon down"}');
      return send(200, JSON.stringify(listBody));
    }
    if (method === 'POST' && path.startsWith('/volumes/create')) return send(201, '{"Name":"v"}');
    // Image-Inspect: das Runner-Image gilt als vorhanden, sonst liefe jeder
    // Start in einen Bau ohne Kontext.
    send(200, '{}');
  });
  const daemonPort = await listen(daemon);

  const hostnameBefore = process.env.HOSTNAME;
  process.env.HOSTNAME = 'smoke-orchestrator';
  cfg.dockerHost = `http://127.0.0.1:${daemonPort}`;
  cfg.dockerEnabled = true;
  dockerMod.resetDockerClient();

  const startSession = async (requestId: string): Promise<string> => {
    const created = await request(c2, {
      type: 'session.create',
      requestId,
      repoId,
      provider: 'openai',
      model: '',
      mode: 'ask',
    });
    assert(created.type === 'request.ok', `${requestId}: Session erstellt`);
    return (created.payload as { sessionId: string }).sessionId;
  };

  try {
    /* ---- das Runner-Image gilt als vorhanden, es wird nichts gebaut ---- */
    assert(
      (await dockerMod.ensureRunnerImage()) === runnerImageName(),
      'ensureRunnerImage liefert den Image-Namen, wenn der Daemon das Image kennt',
    );
    assert(!calls.some((c) => c.startsWith('POST /build')), 'ein vorhandenes Image loest keinen Bau aus');

    /* ---- Delete waehrend der Container erstellt wird (Generation-Abbruch) ---- */

    nextContainerId = 'cid-abort-delete';
    createSeen = deferred();
    createGate = deferred();
    const deleted = await startSession('lc-del');
    await createSeen.promise; // der Daemon haelt das Create, die Provisionierung steht mitten im await
    await manager.deleteSession(deleted);
    createGate.resolve(); // ...und erst jetzt kommt die Container-Id zurueck
    await waitUntil(() => calls.includes('DELETE /containers/cid-abort-delete'), 'die Entfernung des verwaisten Containers');
    assert(
      !calls.includes('POST /containers/cid-abort-delete/start'),
      'ein Start, dessen Session geloescht wurde, startet seinen Container nie',
    );
    assert(store.getSession(deleted) === undefined, 'die geloeschte Session bleibt geloescht');

    /* ---- Stop waehrend die Session noch 'creating' ist ---- */

    nextContainerId = 'cid-abort-stop';
    createSeen = deferred();
    createGate = deferred();
    const stopped = await startSession('lc-stop');
    await createSeen.promise;
    await manager.stopSession(stopped);
    createGate.resolve();
    await waitUntil(
      () => calls.includes('POST /containers/cid-abort-stop/stop'),
      'das Stoppen des Containers der gestoppten Session',
    );
    await new Promise((r) => setTimeout(r, 100)); // einer (faelschlich) weiterlaufenden Provisionierung Zeit lassen
    assert(
      store.getSession(stopped)?.status === 'stopped',
      `ein Stop waehrend 'creating' wird nicht mit idle ueberschrieben (war ${String(store.getSession(stopped)?.status)})`,
    );
    assert(!calls.includes('POST /containers/cid-abort-stop/start'), 'die gestoppte Session startet ihren Container nicht');
    await manager.deleteSession(stopped);

    /* ---- Resume-Re-Entrancy: zwei Taps teilen sich einen Lauf ---- */

    createGate = null;
    createSeen = null;
    startFails = true;
    nextContainerId = 'cid-resume-new';
    const resumed = randomUUID();
    store.insertSession(rowFor(resumed, { status: 'stopped', container_id: 'cid-resume-old' }));
    createCalls = 0;
    const results = await Promise.allSettled([manager.resumeSession(resumed), manager.resumeSession(resumed)]);
    assert(createCalls === 1, `zwei parallele Resumes erzeugen genau einen Container (waren ${createCalls})`);
    assert(
      results.every((r) => r.status === 'rejected'),
      'beide Aufrufer eines scheiternden Resume erfahren, dass er scheiterte',
    );
    await manager.deleteSession(resumed);
    startFails = false;

    /* ---- Label-basierter Orphan-Reaper ---- */

    const kept = randomUUID();
    store.insertSession(rowFor(kept, { status: 'idle', container_id: 'cid-keep' }));
    const old = Math.floor((manager.startedAt - 3_600_000) / 1000);
    const young = Math.floor((Date.now() + 60_000) / 1000);
    listBody = [
      { Id: 'cid-keep', Created: old, Labels: { 'pocketagent.session': kept } },
      { Id: 'cid-orphan', Created: old, Labels: { 'pocketagent.session': randomUUID() } },
      { Id: 'cid-push-leftover', Created: old, Labels: { 'pocketagent.session': kept } },
      { Id: 'cid-nolabel', Created: old, Labels: { 'pocketagent.session': '' } },
      { Id: 'cid-young', Created: young, Labels: { 'pocketagent.session': randomUUID() } },
    ];

    const removed = await manager.reapOrphanContainers();
    assert(removed === 3, `der Reaper entfernt genau die Waisen (waren ${removed})`);
    assert(!calls.includes('DELETE /containers/cid-keep'), 'der Container einer lebenden Session bleibt');
    assert(calls.includes('DELETE /containers/cid-orphan'), 'ein Container ohne Session-Zeile wird entfernt');
    assert(
      calls.includes('DELETE /containers/cid-push-leftover'),
      'ein liegengebliebener Container einer lebenden Session (Push/Resume-Rennen) wird entfernt',
    );
    assert(calls.includes('DELETE /containers/cid-nolabel'), 'ein Container mit leerem Session-Label wird entfernt');
    assert(!calls.includes('DELETE /containers/cid-young'), 'ein Container juenger als der Serverstart gehoert einem laufenden Start');

    listBroken = true;
    const beforeBroken = calls.length;
    assert((await manager.reapOrphanContainers()) === 0, 'ein nicht antwortender Daemon laesst den Reaper nichts tun');
    assert(
      !calls.slice(beforeBroken).some((c) => c.startsWith('DELETE /containers/')),
      'eine fehlgeschlagene Auflistung macht lebende Container nie zu Waisen',
    );
    listBroken = false;
    await manager.deleteSession(kept);
  } finally {
    cfg.dockerEnabled = false;
    cfg.dockerHost = null;
    dockerMod.resetDockerClient();
    if (hostnameBefore === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = hostnameBefore;
    daemon.close();
  }
}

/* ------------------------------------------------------------------ */
/* 3. Turn-Weg: create -> prompt -> events -> stop                     */
/* ------------------------------------------------------------------ */

/**
 * Der Weg, den ein Turn nimmt, gegen einen gefälschten Runner: Prompt raus,
 * Event rein, Historie, Turn-Zustände, Stop. Ein reichbarer Runner-Endpunkt ist
 * alles, was der Prompt-Pfad braucht - kein Daemon nötig.
 */
async function turnSmoke(store: Store, manager: SessionManager, c2: Client, repoId: string): Promise<void> {
  section('turn round-trip (fake runner)');
  const http = await import('node:http');
  const { clampTurnLimit, clampEventLimit, TURNS_DEFAULT_LIMIT, TURNS_MAX_LIMIT, EVENTS_MAX_LIMIT } =
    await import('./sessions.js');

  assert(clampTurnLimit(undefined) === TURNS_DEFAULT_LIMIT, 'ein fehlendes Turn-Limit faellt auf die Vorgabe zurueck');
  assert(clampTurnLimit(9_999) === TURNS_MAX_LIMIT, 'ein zu grosses Turn-Limit wird gedeckelt');
  assert(clampTurnLimit(0) === 1 && clampTurnLimit(-3) === 1, 'ein Turn-Limit unter 1 wird 1');
  assert(clampEventLimit(99_999) === EVENTS_MAX_LIMIT, 'ein zu grosses Event-Limit wird gedeckelt');

  let promptCalls = 0;
  let promptMode: 'ok' | 'fail' = 'ok';
  let lastPromptBody: Record<string, unknown> = {};
  const runner = http.createServer((req, res) => {
    const url = req.url ?? '';
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      if (url.startsWith('/prompt')) {
        promptCalls++;
        try {
          lastPromptBody = JSON.parse(raw || '{}') as Record<string, unknown>;
        } catch {
          lastPromptBody = {};
        }
        if (promptMode === 'fail') {
          return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":false,"error":"boom"}');
        }
        return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  const runnerPort = await listen(runner);
  const runnerBase = `http://127.0.0.1:${runnerPort}`;

  const insertIdle = (patch: Partial<SessionRow> = {}): string => {
    const id = randomUUID();
    store.insertSession(
      sessionRow(id, repoId, {
        status: 'idle',
        network_policy: 'open',
        shim_token: `token-${id.slice(0, 8)}`,
        shim_endpoint: runnerBase,
        ...patch,
      }),
    );
    return id;
  };

  try {
    /* ---- (a) Idempotenz: dieselbe messageId zweimal ist EIN Agenten-Turn ---- */
    const idA = insertIdle({ model: 'gpt-5', provider: 'openai', mode: 'ask' });
    promptMode = 'ok';
    promptCalls = 0;
    await manager.prompt(idA, 'bau den login um', undefined, 'msg_dup');
    await manager.prompt(idA, 'bau den login um', undefined, 'msg_dup'); // Resend nach unklarer Quittung
    const dupCalls = promptCalls;
    assert(dupCalls === 1, `ein mit derselben messageId erneut gesendeter Prompt erreicht den Runner einmal (waren ${dupCalls})`);
    const turnsA = manager.turns(idA);
    assert(turnsA.length === 1, `der doppelte Prompt erzeugte genau einen Turn (waren ${turnsA.length})`);
    assert(turnsA[0]!.messageId === 'msg_dup', 'der Turn traegt die von der App erzeugte messageId');
    assert(turnsA[0]!.state === 'running', 'der zugelassene Turn laeuft, nachdem der Runner ihn angenommen hat');
    assert(
      lastPromptBody.model === 'gpt-5' && lastPromptBody.provider === 'openai' && lastPromptBody.mode === 'ask',
      'der Prompt-Rumpf traegt Modell, Provider und Modus der Session',
    );

    await manager.prompt(idA, 'und jetzt die tests', undefined, 'msg_two');
    assert(promptCalls === 2, 'eine andere messageId wird als eigener Turn zugelassen');
    assert(manager.turns(idA).length === 2, 'die zweite messageId fuegt einen zweiten Turn hinzu');

    /* ---- (b) queued -> running -> completed, nach einem Reconnect abfragbar ---- */
    const idB = insertIdle();
    await manager.prompt(idB, 'lauf los', undefined, 'msg_b');
    const runningPush = await c2.wait(
      (m) => m.type === 'turn.status' && m.sessionId === idB && m.turn.state === 'running',
      5_000,
    );
    assert(runningPush.type === 'turn.status' && runningPush.turn.messageId === 'msg_b', 'der laufende Turn wird live gepusht');
    assert(store.getSession(idB)?.status === 'running', 'ein zugelassener Turn setzt die Session auf running');

    // Der Runner meldet Fortschritt und Abschluss, wie ueber seinen SSE-Strom.
    manager.handleLinkEvent(idB, { type: 'message.completed', role: 'assistant', text: 'fertig', seq: 1 });
    const liveEvent = await c2.wait(
      (m) => m.type === 'session.event' && m.sessionId === idB && m.event.type === 'message.completed',
      5_000,
    );
    assert(liveEvent.type === 'session.event', 'ein Runner-Event geht live an alle Geraete');
    manager.handleLinkEvent(idB, { type: 'turn.completed', seq: 2 });
    assert(store.getSession(idB)?.status === 'idle', 'ein abgeschlossener Turn bringt die Session auf idle zurueck');

    // Dedup ueber seq: dasselbe Event erneut (Replay nach Reconnect) landet nicht zweimal.
    manager.handleLinkEvent(idB, { type: 'message.completed', role: 'assistant', text: 'fertig', seq: 1 });
    const history = manager.sessionEvents(idB);
    const assistantLines = history.filter((e) => e.type === 'message.completed' && e.role === 'assistant');
    assert(assistantLines.length === 1, `ein wiedergespieltes Event landet nur einmal in der Historie (waren ${assistantLines.length})`);
    // Kanonische seq: der Live-Broadcast und die Historie tragen DENSELBEN
    // server-vergebenen Wert (die rowid), nicht die Runner-seq (1) - so kann die
    // App zwischen Live-Strom und nachgeladener Historie sessionweit dedupen.
    assert(
      liveEvent.type === 'session.event' && typeof liveEvent.event.seq === 'number' && liveEvent.event.seq !== 1,
      'ein live gepushtes Event traegt die server-kanonische seq, nicht die Runner-seq',
    );
    assert(
      liveEvent.type === 'session.event' && assistantLines[0]!.seq === liveEvent.event.seq,
      'die Historie traegt fuer dasselbe Event dieselbe kanonische seq wie der Live-Broadcast',
    );
    assert(
      history.some((e) => e.type === 'message.completed' && e.role === 'user' && e.text === 'lauf los'),
      'der eigene Prompt steht in der Historie, damit ein neu geladener Verlauf nicht bei der Antwort beginnt',
    );

    const answered = await request(c2, { type: 'session.turns.get', requestId: 'turns-b', sessionId: idB });
    assert(
      answered.type === 'session.turns' &&
        answered.turns.length === 1 &&
        answered.turns[0]!.state === 'completed' &&
        answered.turns[0]!.messageId === 'msg_b',
      'session.turns.get liefert den abgeschlossenen Turn',
    );
    const events = await request(c2, { type: 'session.events.get', requestId: 'evt-b', sessionId: idB });
    assert(
      events.type === 'session.events' && events.events.length >= 2,
      'session.events.get liefert die gespeicherte Timeline',
    );
    assert(
      events.type === 'session.events' && !events.events.some((e) => e.type === 'ping'),
      'ping-Keepalives erreichen die Historie nie',
    );

    /* ---- (c) ein gescheiterter Turn traegt failed + strukturierten Grund ---- */
    const idC = insertIdle();
    promptMode = 'fail';
    await manager.prompt(idC, 'das geht schief', undefined, 'msg_c');
    const turnsC = manager.turns(idC);
    assert(turnsC.length === 1 && turnsC[0]!.state === 'failed', 'ein vom Runner abgelehnter Prompt endet als failed');
    assert(turnsC[0]!.reason?.message === 'boom', 'der gescheiterte Turn traegt den Runner-Fehler als Grund');
    assert(turnsC[0]!.reason?.stage === 'transport', 'der Grund benennt die Stufe, an der es brach');
    assert(store.getSession(idC)?.status === 'error', 'ein gescheiterter Prompt laesst die Session im Fehler');

    /* ---- (d) session.update und Stop ueber die WS-Oberflaeche ---- */
    promptMode = 'ok';
    const updated = await request(c2, {
      type: 'session.update',
      requestId: 'upd-1',
      sessionId: idB,
      mode: 'yolo',
      model: 'gpt-5-mini',
      reasoningEffort: 'high',
    });
    assert(updated.type === 'request.ok', 'session.update wird quittiert');
    const rowUpdated = store.getSession(idB);
    assert(
      rowUpdated?.mode === 'yolo' && rowUpdated.model === 'gpt-5-mini' && rowUpdated.reasoning_effort === 'high',
      'session.update persistiert Modus, Modell und Reasoning-Stufe',
    );
    assert(buildPromptBody(rowUpdated!, 'hi').model === 'gpt-5-mini', 'der naechste Prompt traegt das neue Modell');
    const badEffort = await request(c2, {
      type: 'session.update',
      requestId: 'upd-2',
      sessionId: idB,
      reasoningEffort: 'extrem',
    });
    assert(badEffort.type === 'error', 'session.update weist eine unbekannte Reasoning-Stufe ab');
    const resetModel = await request(c2, { type: 'session.update', requestId: 'upd-3', sessionId: idB, model: '' });
    assert(resetModel.type === 'request.ok', 'session.update akzeptiert ein leeres Modell');
    const resetBody = buildPromptBody(store.getSession(idB)!, 'hi');
    assert('model' in resetBody && resetBody.model === '', "der Prompt-Rumpf sendet model:'' statt den Reset zu verschlucken");

    c2.send({ type: 'session.stop', sessionId: idB });
    await waitUntil(() => store.getSession(idB)?.status === 'stopped', 'die gestoppte Session');
    let stoppedPrompt = '';
    await manager.prompt(idB, 'trotzdem').catch((e: unknown) => {
      stoppedPrompt = e instanceof Error ? e.message : String(e);
    });
    assert(stoppedPrompt.includes('gestoppt'), 'nach dem Stop wird ein Prompt begruendet abgewiesen');

    store.deleteSession(idA);
    assert(
      store.getTurnByMessageId(idA, 'msg_dup') === undefined,
      'ein geloeschte Session nimmt ihre Turns mit (keine verwaisten Turn-Zeilen)',
    );
    for (const id of [idB, idC]) store.deleteSession(id);
  } finally {
    runner.close();
  }
}

/* ------------------------------------------------------------------ */
/* 4. Egress-Proxy                                                     */
/* ------------------------------------------------------------------ */

/**
 * Der Egress-Proxy ist die Kern-Sicherheit des Servers: er entscheidet, welcher
 * Container überhaupt ins Netz darf. Geprüft werden beide Identitäts-Gates
 * (Token und Quell-Adresse), die Policy 'isolated', die Ziel-Prüfung gegen
 * SSRF/Rebinding und dass das Session-Token nie an einen Upstream weitergeht.
 */
async function egressSmoke(store: Store, manager: SessionManager, repoId: string): Promise<void> {
  section('egress proxy');
  const http = await import('node:http');
  const net = await import('node:net');
  const { createEgressProxyServer, forwardableHeaders, isInternalAddress, resolveTarget } = await import(
    './egress-proxy.js'
  );

  /* ---- Adressen, auf die ein aufgeloester Name nie zeigen darf (pur) ---- */

  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.9', '172.20.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
    assert(isInternalAddress(ip), `${ip} gilt als intern`);
  }
  for (const ip of ['::1', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1']) {
    assert(isInternalAddress(ip), `${ip} gilt als intern`);
  }
  for (const ip of ['140.82.121.4', '2606:4700::1111']) {
    assert(!isInternalAddress(ip), `${ip} ist eine oeffentliche Adresse`);
  }
  assert(isInternalAddress('kein-adresse'), 'alles Unparsebare gilt als intern');

  /* ---- Hop-by-Hop-Header erreichen nie den Upstream (pur) ---- */

  const stripped = forwardableHeaders({
    host: 'api.example',
    'proxy-authorization': 'Basic cGE6c2VjcmV0',
    'proxy-connection': 'keep-alive',
    connection: 'x-hop',
    'x-hop': 'internal',
    authorization: 'Bearer upstream-credential',
  });
  assert(stripped['proxy-authorization'] === undefined, 'proxy-authorization wird vor dem Weiterleiten entfernt');
  assert(stripped['proxy-connection'] === undefined && stripped.connection === undefined, 'proxy-connection/connection werden entfernt');
  assert(stripped['x-hop'] === undefined, 'in connection gelistete Header werden ebenfalls entfernt');
  assert(stripped.authorization === 'Bearer upstream-credential', 'der Authorization-Header des Upstreams ueberlebt');

  /* ---- Sessions mit den drei Policies, direkt aus der DB ---- */

  const allowId = randomUUID();
  const isoId = randomUUID();
  const stoppedId = randomUUID();
  const allowShim = `allow-${allowId}`;
  const isoShim = `iso-${isoId}`;
  const stoppedShim = `stopped-${stoppedId}`;
  // Auf dem Draht (Proxy-Authorization) trägt der Container NICHT den shim_token,
  // sondern das davon abgeleitete Egress-Credential (proxyTokenFor) - so wie es
  // docker.ts in die HTTP(S)_PROXY-URL schreibt. Das Token-Gate validiert exakt diesen.
  const allowToken = proxyTokenFor(allowShim);
  const isoToken = proxyTokenFor(isoShim);
  const stoppedToken = proxyTokenFor(stoppedShim);
  store.insertSession(sessionRow(allowId, repoId, { status: 'idle', shim_token: allowShim }));
  store.insertSession(sessionRow(isoId, repoId, { status: 'idle', shim_token: isoShim, network_policy: 'isolated' }));
  store.insertSession(sessionRow(stoppedId, repoId, { status: 'stopped', shim_token: stoppedShim }));

  assert(manager.egressTokenAllowed(allowToken)?.id === allowId, 'das abgeleitete Token einer lebenden Session benennt ihre Session');
  assert(manager.egressTokenAllowed(allowToken)?.policy === 'allowlist', 'das Token-Gate meldet die Policy der Session');
  assert(manager.egressTokenAllowed(isoToken)?.policy === 'isolated', 'eine isolierte Session wird identifiziert, nicht versteckt');
  assert(manager.egressTokenAllowed(stoppedToken) === null, 'das Token einer gestoppten Session oeffnet den Proxy nicht mehr');
  assert(manager.egressTokenAllowed(allowShim) === null, 'der rohe shim_token taugt nicht als Egress-Credential (nur der abgeleitete Wert)');
  assert(manager.egressTokenAllowed('nie-vergeben') === null, 'ein unbekanntes Token benennt keine Session');
  store.setSessionArchived(allowId, true);
  assert(manager.egressTokenAllowed(allowToken) === null, 'eine archivierte Session verliert ihren Egress sofort');
  store.setSessionArchived(allowId, false);
  assert(manager.egressTokenAllowed(allowToken)?.id === allowId, 'und bekommt ihn beim Entarchivieren zurueck');

  /* ---- der Proxy davor ---- */

  let seenHeaders: import('node:http').IncomingHttpHeaders = {};
  const upstream = http.createServer((req, res) => {
    seenHeaders = req.headers;
    res.writeHead(200).end('pong');
  });
  const upstreamPort = await listen(upstream);
  const target = `http://127.0.0.1:${upstreamPort}/ping`;
  const ports = [80, 443, upstreamPort];

  // Das Peer-Gate antwortet fuer wen auch immer fragt; das Token-Gate ist das echte.
  let peerSession: ReturnType<typeof manager.egressTokenAllowed> = null;
  const proxy = createEgressProxyServer({
    allowlist: ['127.0.0.1'],
    ports,
    tokenValidator: (t) => manager.egressTokenAllowed(t),
    peerValidator: () => peerSession,
  });
  const proxyPort = await listen(proxy);

  const anon = await proxyGet(http, proxyPort, target);
  assert(anon.status === 407, 'ohne Credentials und ohne bekannte Quell-Adresse antwortet der Proxy mit 407');

  const allowed = await proxyGet(http, proxyPort, target, allowToken);
  assert(allowed.status === 200, 'eine allowlist-Session kommt mit ihrem Token durch');
  assert(seenHeaders['proxy-authorization'] === undefined, 'der Upstream sieht nie Proxy-Authorization');
  assert(seenHeaders.host === `127.0.0.1:${upstreamPort}`, 'die weitergeleitete Anfrage adressiert weiter ihren Ursprungs-Host');

  const isolated = await proxyGet(http, proxyPort, target, isoToken);
  assert(isolated.status === 403 && isolated.body.includes('policy'), 'eine isolierte Session wird abgewiesen, Token hin oder her');
  const isolatedConnect = await proxyConnect(net, proxyPort, '127.0.0.1:443', isoToken);
  assert(isolatedConnect === 403, 'eine isolierte Session kann auch keinen CONNECT-Tunnel oeffnen');
  const stopped = await proxyGet(http, proxyPort, target, stoppedToken);
  assert(stopped.status === 407, 'eine gestoppte Session muss sich neu ausweisen - und kann es nicht');

  // Die Quell-Adresse ist der Anspruch, der nicht faelschbar ist.
  peerSession = { id: isoId, policy: 'isolated' };
  const borrowed = await proxyGet(http, proxyPort, target, allowToken);
  assert(borrowed.status === 403, 'ein fremdes Token hebt die Policy des aufrufenden Containers nicht auf');
  peerSession = { id: allowId, policy: 'allowlist' };
  const byPeer = await proxyGet(http, proxyPort, target);
  assert(byPeer.status === 200, 'eine bekannte Quell-Adresse kommt ohne Credentials durch (fetch/undici sendet keine)');
  peerSession = null;

  // Der Klartext-HTTP-Pfad wird genauso port-gegated wie CONNECT.
  const strict = createEgressProxyServer({
    allowlist: ['127.0.0.1'],
    tokenValidator: (t) => manager.egressTokenAllowed(t),
  });
  const strictPort = await listen(strict);
  const oddPort = await proxyGet(http, strictPort, target, allowToken);
  assert(oddPort.status === 403 && oddPort.body.includes('port'), 'weitergeleitetes HTTP wird wie CONNECT port-gegated');
  const offList = await proxyGet(http, proxyPort, `http://evil.example:80/x`, allowToken);
  assert(offList.status === 403 && offList.body.includes('host'), 'ein Host ausserhalb der Allowlist wird abgewiesen');

  /* ---- SSRF: ein Name darf nicht in internen Raum aufloesen ---- */

  const loopbackName = await resolveTarget('localhost', ['localhost']);
  assert(!loopbackName.ok && loopbackName.reason === 'address', 'ein auf Loopback zeigender Name wird abgewiesen');
  const literal = await resolveTarget('127.0.0.1', ['127.0.0.1']);
  assert(literal.ok, 'ein IP-Literal, das der Betreiber in die Allowlist geschrieben hat, bleibt erreichbar');
  const wildcardLiteral = await resolveTarget('127.0.0.1', ['*.0.0.1']);
  assert(!wildcardLiteral.ok, 'ein nur ueber Wildcard getroffenes internes Literal nicht');

  const rebind = createEgressProxyServer({
    allowlist: ['localhost'],
    ports,
    tokenValidator: (t) => manager.egressTokenAllowed(t),
  });
  const rebindPort = await listen(rebind);
  const viaName = await proxyGet(http, rebindPort, `http://localhost:${upstreamPort}/ping`, allowToken);
  assert(viaName.status === 403 && viaName.body.includes('address'), 'ein erlaubter Name, der nach innen zeigt, wird blockiert');
  const viaNameConnect = await proxyConnect(net, rebindPort, 'localhost:443', allowToken);
  assert(viaNameConnect === 403, 'der CONNECT-Pfad loest auf und blockt genauso');

  /* ---- Erreichbarkeit: eine tote Adresse darf einen Host nicht unerreichbar machen ---- */

  const dual = await resolveTarget('dual.example', ['dual.example'], async () => [
    { address: '2606:4700::1111', family: 6 },
    { address: '203.0.113.7', family: 4 },
    { address: '10.1.2.3', family: 4 },
    { address: 'fd00::1', family: 6 },
    { address: '198.51.100.9', family: 4 },
  ]);
  assert(dual.ok && dual.targets.length === 3, 'ein aufgeloester Name behaelt jede geprueft Adresse, nicht nur die erste');
  assert(
    dual.ok && dual.targets.map((t) => t.address).join(',') === '203.0.113.7,198.51.100.9,2606:4700::1111',
    'IPv4 kommt vor IPv6, innerhalb einer Familie bleibt die DNS-Reihenfolge',
  );
  assert(
    dual.ok && !dual.targets.some((t) => isInternalAddress(t.address)),
    'keine interne Adresse erreicht je die Liste, zu der verbunden werden darf',
  );

  for (const s of [upstream, proxy, strict, rebind]) s.close();
  for (const id of [allowId, isoId, stoppedId]) store.deleteSession(id);
}

/* ------------------------------------------------------------------ */
/* 5. Link-Token, Heartbeat, Close-Codes                               */
/* ------------------------------------------------------------------ */

/**
 * Der Link-Weg: ein Token aus dem Store meldet einen Agenten an, sein
 * Heartbeat ist ein Voll-Zustand (keine Deltas), und die beiden Close-Codes,
 * die `link/` als terminal behandelt, kommen wirklich vom Server.
 */
async function linkSmoke(store: Store, manager: SessionManager, wsBase: string, c2: Client): Promise<void> {
  section('link token + heartbeat');
  const { randomBytes } = await import('node:crypto');

  const tokenA = randomBytes(24).toString('hex');
  store.createLink(randomUUID(), 'default', 'smoke-link-a', sha256(tokenA));

  // Ein falsches Token darf nie registrieren.
  const bogus = new Client(wsBase);
  await bogus.opened;
  const bogusClosed = bogus.closeCode();
  bogus.send({ type: 'agent.hello', token: 'nicht-vergeben', name: 'boese' });
  assert((await bogusClosed) === WS_CLOSE_UNAUTHORIZED, 'ein unbekanntes Link-Token wird mit 4001 geschlossen');

  const linkA = new Client(wsBase);
  await linkA.opened;
  linkA.send({ type: 'agent.hello', token: tokenA, name: 'link-a', workDir: '/home/robin/code' });
  const readyA = await linkA.wait((m) => m.type === 'agent.ready');
  const sessionAId = readyA.type === 'agent.ready' ? readyA.sessionId : '';
  assert(sessionAId !== '', 'ein Link registriert sich mit agent.hello');
  const linkRow = store.getSession(sessionAId);
  assert(linkRow?.status === 'idle', 'eine frisch registrierte Link-Session startet idle');
  assert(linkRow?.repo_full_name.includes('/home/robin/code') === true, 'das Arbeitsverzeichnis steht im Anzeigenamen');

  const listed = await request(c2, { type: 'session.list', requestId: 'link-list' });
  assert(
    listed.type === 'session.list' && listed.sessions.find((s) => s.id === sessionAId)?.linked === true,
    'eine Link-Session ist in session.list als linked markiert',
  );

  // Timeline ueber einen Link-Neustart (Tier-2-Fix (a)): der Link-Agent beginnt
  // seine seq bei jedem Verbinden wieder bei 1. registerLinkSession muss die
  // lastPersistedSeq-Marke zuruecksetzen, sonst verwirft persistEvent jedes Event
  // des neuen Laufs als vermeintlichen Replay und die Session verliert ihre
  // Historie. Ein eigener, isolierter Link (tokenR), damit der Reconnect keine
  // andere Bindung stoert.
  const tokenR = randomBytes(24).toString('hex');
  store.createLink(randomUUID(), 'default', 'smoke-link-r', sha256(tokenR));
  const linkR1 = new Client(wsBase);
  await linkR1.opened;
  linkR1.send({ type: 'agent.hello', token: tokenR, name: 'link-r' });
  const readyR1 = await linkR1.wait((m) => m.type === 'agent.ready');
  const sessionRId = readyR1.type === 'agent.ready' ? readyR1.sessionId : '';
  manager.handleLinkEvent(sessionRId, { type: 'message.completed', role: 'assistant', text: 'lauf-1 a', seq: 1 });
  manager.handleLinkEvent(sessionRId, { type: 'message.completed', role: 'assistant', text: 'lauf-1 b', seq: 2 });
  const beforeReconnect = manager
    .sessionEvents(sessionRId)
    .filter((e) => e.type === 'message.completed' && e.role === 'assistant').length;
  assert(beforeReconnect === 2, `vor dem Neustart stehen beide Zeilen des ersten Laufs in der Historie (waren ${beforeReconnect})`);
  linkR1.close();
  // Reconnect desselben Links (gleiches Token) -> registerLinkSession(existing) -> Reset.
  const linkR2 = new Client(wsBase);
  await linkR2.opened;
  linkR2.send({ type: 'agent.hello', token: tokenR, name: 'link-r' });
  const readyR2 = await linkR2.wait((m) => m.type === 'agent.ready');
  assert(
    readyR2.type === 'agent.ready' && readyR2.sessionId === sessionRId,
    'der Reconnect bindet dieselbe Link-Session-Id wieder',
  );
  // seq startet wieder bei 1 - dank Reset darf es NICHT als Replay verworfen werden.
  manager.handleLinkEvent(sessionRId, { type: 'message.completed', role: 'assistant', text: 'lauf-2 a', seq: 1 });
  const afterReconnect = manager
    .sessionEvents(sessionRId)
    .filter((e) => e.type === 'message.completed' && e.role === 'assistant');
  assert(
    afterReconnect.length === 3,
    `nach dem Neustart landet die neue Zeile trotz zurueckgesetzter seq in der Historie (waren ${afterReconnect.length})`,
  );
  assert(
    new Set(afterReconnect.map((e) => e.seq)).size === 3,
    'jede der drei Zeilen traegt eine eigene kanonische seq - keine Kollision ueber den Neustart',
  );
  linkR2.close();

  // Ein zweiter, unabhaengiger Link - Beleg, dass ein Link nur seine eigene Bindung bewegt.
  const tokenC = randomBytes(24).toString('hex');
  store.createLink(randomUUID(), 'default', 'smoke-link-c', sha256(tokenC));
  const linkC = new Client(wsBase);
  await linkC.opened;
  linkC.send({ type: 'agent.hello', token: tokenC, name: 'link-c' });
  const readyC = await linkC.wait((m) => m.type === 'agent.ready');
  const sessionCId = readyC.type === 'agent.ready' ? readyC.sessionId : '';
  assert(sessionCId !== '' && sessionCId !== sessionAId, 'ein zweiter Link registriert seine eigene, getrennte Session');

  linkA.send({
    type: 'agent.heartbeat',
    sessions: [{ sessionId: sessionAId, status: 'busy' }],
  });
  await waitUntil(
    () => store.getSession(sessionAId)?.status === 'running',
    "ein Heartbeat mit 'busy' bringt die gebundene Session auf running",
  );

  linkA.send({ type: 'agent.heartbeat', sessions: [{ sessionId: sessionAId, status: 'idle' }] });
  await waitUntil(
    () => store.getSession(sessionAId)?.status === 'idle',
    "ein Heartbeat mit 'idle' bringt sie zurueck - ganz ohne turn.completed",
  );

  linkA.send({ type: 'agent.heartbeat', sessions: [{ sessionId: sessionAId, status: 'permission' }] });
  await waitUntil(
    () => store.getSession(sessionAId)?.status === 'running',
    "'permission' faltet wie alles Nicht-idle auf running",
  );

  // Voll-Zustand: fehlt die gebundene Session in der Liste, ist sie weg.
  linkA.send({ type: 'agent.heartbeat', sessions: [] });
  await waitUntil(
    () => store.getSession(sessionAId)?.status === 'stopped',
    'eine im Heartbeat fehlende Session gilt als weg (stopped)',
  );

  // Faelschungsversuch + kaputter Eintrag neben dem gueltigen.
  linkA.send({ type: 'agent.heartbeat', sessions: [{ sessionId: sessionAId, status: 'busy' }] });
  await waitUntil(() => store.getSession(sessionAId)?.status === 'running', 'wieder running vor der Toleranzpruefung');
  linkA.send({
    type: 'agent.heartbeat',
    sessions: [
      { sessionId: sessionCId, status: 'busy' },
      { sessionId: sessionAId, status: 'idle' },
      { sessionId: sessionAId, status: 'kein-echter-status' },
    ],
  });
  await waitUntil(
    () => store.getSession(sessionAId)?.status === 'idle',
    'ein Heartbeat mit fremder Session-Id und kaputtem Eintrag wendet den gueltigen trotzdem an',
  );
  assert(
    store.getSession(sessionCId)?.status === 'idle',
    "die fremde Session-Id in linkAs Heartbeat bewegt linkCs Session nicht",
  );

  // `sessions` gar kein Array: degradiert zu "leerer Schnappschuss", kein Absturz.
  linkA.send({ type: 'agent.heartbeat', sessions: 'kein-array' });
  await new Promise((r) => setTimeout(r, 100));
  assert(
    store.getSession(sessionAId)?.status === 'stopped',
    'ein Heartbeat ohne Array-Feld gilt als leerer Schnappschuss, statt den Prozess zu zerlegen',
  );
  assert(store.getSession(sessionCId)?.status === 'idle', "ein kaputter Heartbeat auf linkAs Socket fasst linkCs Session nie an");
  const alive = await request(c2, { type: 'server.stats', requestId: 'link-alive' });
  assert(alive.type === 'server.stats', 'der Server bedient andere Clients nach einem kaputten Heartbeat weiter');

  /* ---- terminale vs. voruebergehende Close-Codes ---- */

  const linkAClosed = linkA.closeCode();
  const linkA2 = new Client(wsBase);
  await linkA2.opened;
  linkA2.send({ type: 'agent.hello', token: tokenA, name: 'link-a-2' });
  await linkA2.wait((m) => m.type === 'agent.ready');
  assert((await linkAClosed) === WS_CLOSE_REPLACED, 'ein durch Reconnect verdraengter Link wird mit WS_CLOSE_REPLACED geschlossen');

  const linkA2Closed = linkA2.closeCode();
  const linkIdA = store.getLinkByTokenHash(sha256(tokenA))?.id ?? '';
  assert(linkIdA !== '', 'die Link-Zeile zu tokenA ist aufloesbar');
  const revoked = await request(c2, { type: 'link.revoke', requestId: 'link-revoke', linkId: linkIdA });
  assert(revoked.type === 'link.revoked', 'link.revoke wird quittiert');
  assert((await linkA2Closed) === WS_CLOSE_UNAUTHORIZED, 'der Socket eines widerrufenen Links wird mit 4001 geschlossen');

  const links = await request(c2, { type: 'link.list', requestId: 'link-list-2' });
  assert(
    links.type === 'link.list' && !links.links.some((l) => l.id === linkIdA),
    'der widerrufene Link ist aus link.list verschwunden',
  );
}

/* ------------------------------------------------------------------ */
/* 6. WS-Heartbeat (halbtote Sockets)                                  */
/* ------------------------------------------------------------------ */

async function heartbeatSmoke(): Promise<void> {
  section('ws heartbeat');
  const { WebSocketServer } = await import('ws');
  const { Heartbeat, WS_HEARTBEAT_MS } = await import('./ws.js');
  assert(WS_HEARTBEAT_MS === 25_000, 'produktiv wird alle 25s gepingt');

  const hb = new Heartbeat(40);
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  wss.on('connection', (s) => hb.track(s));

  const alive = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => alive.once('open', () => resolve()));
  // autoPong aus = der Client antwortet nie, genau wie ein Handy ohne Netz,
  // dessen Socket hier noch offen aussieht.
  const mute = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: false });
  const muteClosed = new Promise<boolean>((resolve) => {
    mute.once('close', () => resolve(true));
    setTimeout(() => resolve(false), 5_000);
  });
  await new Promise<void>((resolve) => mute.once('open', () => resolve()));

  assert(await muteClosed, 'ein Socket, der zwei Pong-Runden verpasst, wird terminiert');
  assert(alive.readyState === WebSocket.OPEN, 'ein antwortender Socket bleibt verbunden');
  assert(hb.size() === 1, 'der Heartbeat vergisst terminierte Sockets');

  hb.stop();
  assert(hb.size() === 0, 'das Herunterfahren leert den Heartbeat');
  alive.close();
  wss.close();
}

/* ------------------------------------------------------------------ */
/* 7. Runner-Client: HTTP-Status wird nicht ignoriert                  */
/* ------------------------------------------------------------------ */

async function shimClientSmoke(): Promise<void> {
  section('runner client');
  const http = await import('node:http');
  const { ShimClient, normalizeModels } = await import('./shim-client.js');

  assert(normalizeModels(null).length === 0, 'ein fehlender Katalog wird zur leeren Liste');
  assert(normalizeModels({ models: ['a', { id: 'b', name: 'B' }, { id: '' }, 42] }).length === 2, 'kaputte Katalog-Eintraege fallen raus');

  let respond: { status: number; body: unknown } = { status: 200, body: {} };
  const server = http.createServer((_req, res) => {
    res.writeHead(respond.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(respond.body));
  });
  const port = await listen(server);
  const client = new ShimClient(`http://127.0.0.1:${port}`, 'smoke-token');

  try {
    // Genau der Fehlermodus aus dem Fund: ein Proxy antwortet mit parsebarem
    // JSON-Fehlerkoerper, waehrend der Runner noch bootet.
    respond = { status: 502, body: { error: 'upstream not ready' } };
    assert((await client.status()) === null, 'ein Nicht-2xx-JSON-Koerper gilt nicht als bereiter Runner');
    respond = { status: 401, body: { mode: 'ask', busy: false } };
    assert((await client.status()) === null, 'ein 401 wird auch mit gut geformtem Koerper abgelehnt');
    respond = { status: 200, body: { mode: 'ask', busy: false } };
    const ready = await client.status();
    assert(ready?.mode === 'ask' && ready.busy === false, 'eine 2xx-Antwort wird normal gelesen');
    assert(!('adapter' in (ready as object)), 'ShimStatus traegt kein adapter-Feld mehr');
  } finally {
    server.close();
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const started = Date.now();
  const { app, store, manager } = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  const wsBase = `ws://127.0.0.1:${addr.port}/ws`;

  /* ---------------- Health + Pairing + WS-Auth ---------------- */

  section('health, pairing, ws auth');
  const health = await fetch(`${base}/api/health`);
  const healthBody = (await health.json()) as { ok: boolean; version: string; docker: boolean };
  assert(health.ok && healthBody.ok, '/api/health antwortet');
  assert(typeof healthBody.version === 'string' && healthBody.docker === false, '/api/health meldet Version und Docker-Zustand');

  const c1 = new Client(wsBase);
  await c1.opened;
  const c1Code = c1.closeCode();
  c1.send({ type: 'hello', deviceId: 'nope', token: 'bad-token' });
  assert((await c1Code) === WS_CLOSE_UNAUTHORIZED, 'ein falsches Geraete-Token schliesst die Verbindung mit 4001');

  const code = generatePairingCode(store);
  const pairRes = await fetch(`${base}/api/pairing/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'smoke-device' }),
  });
  const paired = (await pairRes.json()) as { ok: boolean; deviceId?: string; deviceToken?: string };
  assert(pairRes.ok && paired.ok && paired.deviceId && paired.deviceToken, 'pairing/confirm liefert Geraet und Token');
  const reused = await fetch(`${base}/api/pairing/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'smoke-device-2' }),
  });
  assert(!reused.ok, 'ein Pairing-Code laesst sich nicht wiederverwenden');

  const c2 = new Client(wsBase);
  await c2.opened;
  c2.send({ type: 'hello', deviceId: paired.deviceId, token: paired.deviceToken });
  const welcome = await c2.wait((m) => m.type === 'welcome');
  assert(welcome.type === 'welcome' && welcome.ok, 'ein authentifiziertes hello bekommt welcome');

  // Ein Socket, der gar kein hello sendet, wird nach dem Auth-Timeout geschlossen.
  const { WS_AUTH_TIMEOUT_MS } = await import('./ws.js');
  assert(WS_AUTH_TIMEOUT_MS === 10_000, 'ein Socket ohne hello hat 10s Gnadenfrist');

  /* ---------------- fcm.register ---------------- */

  section('fcm.register');
  c2.send({ type: 'fcm.register', token: 'fcm-smoke-token' });
  await waitUntil(
    () => store.getDevice(paired.deviceId as string)?.fcm_token === 'fcm-smoke-token',
    'das hinterlegte FCM-Token',
  );
  assert(store.listFcmTokens('default').includes('fcm-smoke-token'), 'das Token steht in der Push-Liste des Mandanten');
  // Rotation: Firebase vergibt ein neues Token, das alte wird ersetzt (nicht ergaenzt).
  c2.send({ type: 'fcm.register', token: 'fcm-smoke-rotated' });
  await waitUntil(
    () => store.getDevice(paired.deviceId as string)?.fcm_token === 'fcm-smoke-rotated',
    'das rotierte FCM-Token',
  );
  assert(
    store.listFcmTokens('default').filter((t) => t.startsWith('fcm-smoke')).length === 1,
    'eine Token-Rotation ersetzt den Eintrag, statt einen zweiten anzulegen',
  );

  /* ---------------- Secrets: Vault, Arten, Live-Pruefung ---------------- */

  section('secrets + vault');
  const saved = await request(c2, { type: 'secret.set', requestId: 'sec1', kind: 'openai', value: 'sk-smoke-secret-value' });
  assert(saved.type === 'secret.saved', 'secret.set -> secret.saved');
  assert(!JSON.stringify(saved).includes('sk-smoke-secret-value'), 'der Wert wird nie zurueckgegeben');

  const badKindShape = await request(c2, { type: 'secret.set', requestId: 'sec-bad1', kind: 'Nicht:Erlaubt', value: 'x' });
  assert(badKindShape.type === 'error', 'eine formal ungueltige Secret-Art wird abgewiesen');
  const badKindUnknown = await request(c2, { type: 'secret.set', requestId: 'sec-bad2', kind: 'kilo', value: 'x' });
  assert(
    badKindUnknown.type === 'error' && badKindUnknown.message.includes('unknown secret kind'),
    'eine Art ausserhalb von SECRET_KINDS wird abgewiesen (v1 speicherte sie stillschweigend)',
  );
  for (const kind of SECRET_KINDS) {
    const ok = await request(c2, { type: 'secret.set', requestId: `sec-${kind}`, kind, value: `wert-${kind}` });
    assert(ok.type === 'secret.saved', `SECRET_KINDS-Eintrag "${kind}" wird akzeptiert`);
  }
  assert(SECRET_KINDS.includes('github'), 'github gehoert zu den Secret-Arten (Clone/Push/PR)');

  const secretList = await request(c2, { type: 'secret.list', requestId: 'sec2' });
  assert(
    secretList.type === 'secret.list' && secretList.secrets.length === SECRET_KINDS.length,
    'secret.list liefert je Art genau einen Eintrag (Upsert auf (tenant, kind))',
  );
  assert(
    secretList.type === 'secret.list' && !JSON.stringify(secretList).includes('wert-github'),
    'secret.list traegt nie einen Klartext',
  );

  // Roundtrip durch den Vault: was gespeichert wurde, kommt entschluesselt zurueck.
  assert(store.getSecretValue('github', 'default') === 'wert-github', 'ein gespeichertes Secret laesst sich entschluesseln');
  assert(store.getSecretValue('gibt-es-nicht', 'default') === null, 'eine fehlende Art liefert null');

  const deletedSecret = await request(c2, {
    type: 'secret.delete',
    requestId: 'sec3',
    id: (secretList.type === 'secret.list' ? secretList.secrets.find((s) => s.kind === 'anthropic')?.id : '') ?? '',
  });
  assert(deletedSecret.type === 'secret.deleted', 'secret.delete wird quittiert');
  assert(store.getSecretValue('anthropic', 'default') === null, 'ein geloeschtes Secret ist wirklich weg');

  /* ---- Vault: strikte AAD-Bindung (v2 kennt keinen No-AAD-Fallback mehr) ---- */

  const aad = 'secret:default:smoke-aad';
  const encRound = vault.encrypt('roundtrip-value', aad);
  assert(vault.decryptStrict(encRound, aad) === 'roundtrip-value', 'AES-256-GCM-Roundtrip mit AAD');
  let aadMismatch = false;
  try {
    vault.decryptStrict(encRound, 'secret:default:other');
  } catch {
    aadMismatch = true;
  }
  assert(aadMismatch, 'eine falsche AAD laesst den strikten decrypt scheitern');

  // v2 startet frisch und schreibt jedes Secret AAD-gebunden: getSecretValue
  // entschluesselt strikt und heilt KEINE AAD-lose Zeile mehr (kein Fallback,
  // keine transparente Re-Verschluesselung). Eine ohne AAD geschriebene Zeile
  // scheitert daher fail-closed statt still durchzugehen.
  const noAadKind = 'openai';
  const noAadEnc = vault.encrypt('no-aad-value'); // ohne AAD - darf es in v2 nicht geben
  store.saveSecret(randomUUID(), 'default', noAadKind, noAadEnc.ciphertext, noAadEnc.nonce);
  let noAadThrew = false;
  try {
    store.getSecretValue(noAadKind, 'default');
  } catch {
    noAadThrew = true;
  }
  assert(noAadThrew, 'eine AAD-lose Zeile scheitert strikt (kein stiller No-AAD-Pfad)');
  // Regulaer geschriebenes (AAD-gebundenes) Secret liest getSecretValue sauber.
  const okEnc = vault.encrypt('aad-value', `secret:default:${noAadKind}`);
  store.saveSecret(randomUUID(), 'default', noAadKind, okEnc.ciphertext, okEnc.nonce);
  assert(store.getSecretValue(noAadKind, 'default') === 'aad-value', 'ein AAD-gebundenes Secret entschluesselt strikt');

  /* ---- secret.validate: rein offline mit gestubbtem fetch ---- */

  const stubFetch = (status: number, body: unknown, calls: string[] = []): FetchLike =>
    (url) => {
      calls.push(url);
      return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
    };

  const okCalls: string[] = [];
  const okKey = await validateSecret('openai', 'sk-egal', {
    fetchImpl: stubFetch(200, { data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] }, okCalls),
  });
  assert(okKey.ok && okKey.detail === '2 Modelle verfügbar', 'validateSecret zaehlt die Modelle bei 2xx');
  assert(okCalls[0] === 'https://api.openai.com/v1/models', 'die openai-Pruefung trifft den Modell-Endpunkt');
  const badKey = await validateSecret('anthropic', 'sk-ant-nope', { fetchImpl: stubFetch(401, {}) });
  assert(!badKey.ok && badKey.detail === 'Key ungültig oder abgelaufen', '401 -> Key ungueltig');
  const ghOk = await validateSecret('github', 'ghp_x', { fetchImpl: stubFetch(200, { login: 'octocat' }) });
  assert(ghOk.ok && ghOk.detail === 'Angemeldet als octocat', 'die github-Pruefung meldet den Login');
  const zaiUnverified = await validateSecret('zai', 'x', { fetchImpl: () => Promise.reject(new Error('darf nicht aufgerufen werden')) });
  assert(zaiUnverified.ok && zaiUnverified.unverified === true, 'zai hat keinen belegten Endpunkt und bleibt unverified');
  const offline = await validateSecret('github', 'ghp_x', { fetchImpl: () => Promise.reject(new Error('ENOTFOUND')) });
  assert(!offline.ok && offline.detail === 'Server erreicht Provider nicht', 'ein Netzfehler wird als solcher gemeldet');
  const validated = await request(c2, { type: 'secret.validate', requestId: 'val1', kind: 'zai', value: 'super-geheim' });
  assert(
    validated.type === 'secret.validated' && validated.kind === 'zai' && validated.unverified === true,
    'secret.validate -> secret.validated ueber die WS',
  );
  assert(!JSON.stringify(validated).includes('super-geheim'), 'secret.validated spiegelt den Wert nie zurueck');

  /* ---------------- Repos + session.create ---------------- */

  section('repos + session.create');
  const added = await request(c2, { type: 'repo.add', requestId: 'repo1', fullName: 'acme/demo', defaultBranch: 'main' });
  assert(added.type === 'repo.added' && added.repo.fullName === 'acme/demo', 'repo.add -> repo.added');
  const repoId = added.type === 'repo.added' ? added.repo.id : '';
  const repoList = await request(c2, { type: 'repo.list', requestId: 'repo2' });
  assert(repoList.type === 'repo.list' && repoList.repos.length === 1, 'repo.list liefert das Repo');
  const badRepo = await request(c2, { type: 'repo.add', requestId: 'repo3', fullName: 'bad name!', defaultBranch: 'main' });
  assert(badRepo.type === 'error', 'repo.add mit ungueltigem fullName wird abgewiesen');
  const badBranch = await request(c2, { type: 'repo.add', requestId: 'repo4', fullName: 'acme/ok', defaultBranch: 'ma in!' });
  assert(badBranch.type === 'error', 'repo.add mit ungueltigem defaultBranch wird abgewiesen');

  const badProvider = await request(c2, {
    type: 'session.create',
    requestId: 'ses-bad1',
    repoId,
    provider: 'kilo-gateway',
    model: '',
    mode: 'ask',
  });
  assert(badProvider.type === 'error', 'session.create mit unbekanntem Provider wird abgewiesen');
  const badMode = await request(c2, {
    type: 'session.create',
    requestId: 'ses-bad2',
    repoId,
    provider: 'openai',
    model: '',
    mode: 'turbo',
  });
  assert(badMode.type === 'error', 'session.create mit unbekanntem Modus wird abgewiesen');
  const badRepoId = await request(c2, {
    type: 'session.create',
    requestId: 'ses-bad3',
    repoId: 'gibt-es-nicht',
    provider: 'openai',
    model: '',
    mode: 'ask',
  });
  assert(badRepoId.type === 'error', 'session.create mit unbekanntem Repo wird abgewiesen');

  /* ---- Unbekannte Wire-Felder werden ignoriert, nicht abgelehnt ---- */

  // Die App schickt `adapter: "pi"` weiterhin mit (Wire-Format unveraendert,
  // GREENFIELD-PI.md). Der Server kennt das Feld nicht mehr - er darf die
  // Nachricht deswegen aber nicht abweisen, sonst kann keine App-Version, die
  // aelter ist als dieser Server, noch eine Session anlegen. Dasselbe gilt fuer
  // jedes spaetere Feld: unbekannt = ignoriert.
  const withAdapter = await request(c2, {
    type: 'session.create',
    requestId: 'ses-fwd',
    repoId,
    provider: 'openai',
    model: '',
    mode: 'ask',
    adapter: 'pi',
    authFlow: 'irgendwas-aus-v1',
  });
  assert(withAdapter.type === 'request.ok', 'session.create mit unbekannten Feldern (adapter) wird angenommen');
  const fwdId = (withAdapter.payload as { sessionId?: string } | undefined)?.sessionId ?? '';
  assert(fwdId.length > 0, 'auch diese Session bekommt eine Id');
  const fwdRow = store.getSession(fwdId);
  assert(fwdRow?.provider === 'openai' && fwdRow.mode === 'ask', 'die bekannten Felder werden ganz normal uebernommen');
  assert(
    !Object.keys(fwdRow as object).includes('adapter'),
    'das unbekannte Feld landet nirgends in der Session-Zeile',
  );
  // Aufraeumen: ohne Docker laeuft diese Session sonst in denselben
  // Fehlerstatus wie die naechste und stoert deren Erwartungen.
  await manager.deleteSession(fwdId).catch(() => undefined);

  // Docker ist aus: die Session wird angelegt, angekuendigt und scheitert sauber.
  const created = await request(c2, {
    type: 'session.create',
    requestId: 'ses1',
    repoId,
    provider: 'openai',
    model: 'gpt-5',
    mode: 'yolo',
  });
  assert(created.type === 'request.ok', 'session.create -> request.ok sofort');
  const sessionId = (created.payload as { sessionId?: string } | undefined)?.sessionId;
  assert(typeof sessionId === 'string' && sessionId.length > 0, 'request.ok traegt die sessionId');
  const creatingStatus = await c2.wait(
    (m) => m.type === 'session.status' && m.sessionId === sessionId && m.status === 'creating',
    5_000,
  );
  assert(
    creatingStatus.type === 'session.status' && creatingStatus.session !== undefined,
    'die neue Session wird sofort mit Status creating angekuendigt',
  );
  assert(
    creatingStatus.type === 'session.status' && !('adapter' in (creatingStatus.session as object)),
    'SessionInfo traegt kein adapter-Feld mehr',
  );
  const errorStatus = await c2.wait(
    (m) => m.type === 'session.status' && m.sessionId === sessionId && m.status === 'error',
    20_000,
  );
  assert(errorStatus.type === 'session.status', 'eine Session ohne Docker endet im Status error');
  await c2.wait((m) => m.type === 'session.event' && m.sessionId === sessionId && m.event.type === 'error', 5_000);
  assert(true, 'das Fehler-Event wird mit Meldung verteilt');

  // Prompt-Quittung: mit requestId kommt der Fehler zurueck, ohne bleibt es fire-and-forget.
  const promptAck = await request(c2, { type: 'session.prompt', requestId: 'prm1', sessionId, text: 'hallo' });
  assert(
    promptAck.type === 'error' && promptAck.requestId === 'prm1' && promptAck.sessionId === sessionId,
    'session.prompt mit requestId wird mit error + derselben requestId quittiert',
  );
  c2.send({ type: 'session.prompt', sessionId, text: 'ohne requestId' });
  const silentPrompt = await c2.wait((m) => m.type === 'error' && m.sessionId === sessionId && !('requestId' in m), 5_000);
  assert(silentPrompt.type === 'error', 'session.prompt ohne requestId meldet den Fehler trotzdem');

  // Umbenennen, Archivieren, Loeschen.
  const renamed = await request(c2, { type: 'session.rename', requestId: 'ren1', sessionId, title: '  Login\n umbauen  ' });
  assert(
    renamed.type === 'request.ok' && (renamed.payload as { session: { title?: string } }).session.title === 'Login umbauen',
    'session.rename normalisiert Steuerzeichen und Leerraum',
  );
  const cleared = await request(c2, { type: 'session.rename', requestId: 'ren2', sessionId, title: '   ' });
  assert(
    cleared.type === 'request.ok' && (cleared.payload as { session: { title?: string } }).session.title === undefined,
    'ein leerer Titel setzt den abgeleiteten Namen zurueck',
  );
  const archived = await request(c2, { type: 'session.archive', requestId: 'arc1', sessionId, archived: true });
  assert(
    archived.type === 'request.ok' && (archived.payload as { session: { archived?: boolean } }).session.archived === true,
    'session.archive markiert die Session',
  );
  const listWithArchived = await request(c2, { type: 'session.list', requestId: 'ses2' });
  assert(
    listWithArchived.type === 'session.list' && listWithArchived.sessions.some((s) => s.id === sessionId),
    'eine archivierte Session bleibt in session.list (der Client filtert)',
  );
  const deleted = await request(c2, { type: 'session.delete', requestId: 'del1', sessionId });
  assert(deleted.type === 'session.deleted', 'session.delete -> session.deleted');
  assert(store.getSession(sessionId as string) === undefined, 'die Zeile ist weg');

  const models = await request(c2, { type: 'session.models.get', requestId: 'mod1', sessionId: randomUUID() });
  assert(models.type === 'error', 'session.models.get auf eine unbekannte Session meldet einen Fehler');

  /* ---------------- Unterabschnitte ---------------- */

  await runnerConfigSmoke();
  await turnSmoke(store, manager, c2, repoId);
  await egressSmoke(store, manager, repoId);
  await lifecycleSmoke(store, manager, c2, repoId);
  await linkSmoke(store, manager, wsBase, c2);
  await heartbeatSmoke();
  await shimClientSmoke();

  /* ---------------- Pairing-Haertung ---------------- */

  section('pairing hardening');
  assert(isNoticePhase('container-start') && isNoticePhase('ready'), 'die Vertragsphasen werden akzeptiert');
  assert(!isNoticePhase('image-build'), "'image-build' ist im pi-Contract entfallen");
  assert(!isNoticePhase('fertig') && !isNoticePhase(undefined), 'unbekannte Phasen werden abgelehnt');

  const confirmInject = (pairCode: string, ip: string): ReturnType<typeof app.inject> =>
    app.inject({
      method: 'POST',
      url: '/api/pairing/confirm',
      headers: { 'content-type': 'application/json' },
      remoteAddress: ip,
      payload: { code: pairCode, deviceName: 'smoke-inject' },
    });

  // 5 falsche Codes verbrennen die Versuche der echten Zeile nicht...
  const liveCode = generatePairingCode(store);
  for (let i = 0; i < 5; i++) {
    const r = await confirmInject(`deadbeef000${i}`, '10.0.0.1');
    assert(r.statusCode === 400, `falscher Code #${i + 1} abgewiesen`);
  }
  const stillWorks = await confirmInject(liveCode, '10.0.0.1');
  assert(stillWorks.statusCode === 200, 'der richtige Code funktioniert noch, solange Versuche uebrig sind');
  assert(/^[0-9a-f]{12}$/.test(liveCode), 'Codes sind 12 Hex-Zeichen');

  // Versuchs-Erschoepfung: 5 Fehlversuche gegen EINEN Code sperren ihn.
  const hammered = generatePairingCode(store, 'default', -60_000); // gleich abgelaufen geboren
  for (let i = 0; i < 5; i++) {
    const r = await confirmInject(hammered, '10.0.0.2');
    assert(r.statusCode === 400, `Fehlversuch #${i + 1} abgewiesen`);
  }
  const attemptsRow = store.db.prepare('SELECT attempts FROM pairing_codes WHERE code = ?').get(hammered) as
    | { attempts: number }
    | undefined;
  assert(attemptsRow?.attempts === 5, '5 Fehlversuche haben 5 Versuche verbrannt');
  store.db
    .prepare('UPDATE pairing_codes SET expires_at = ? WHERE code = ?')
    .run(new Date(Date.now() + 600_000).toISOString(), hammered);
  const exhausted = await confirmInject(hammered, '10.0.0.2');
  assert(exhausted.statusCode === 400, 'der 6. Versuch mit dem RICHTIGEN Code wird abgewiesen (Lockout)');

  const expiredCode = generatePairingCode(store, 'default', -1_000);
  assert((await confirmInject(expiredCode, '10.0.0.3')).statusCode === 400, 'ein abgelaufener Code wird abgewiesen');

  /* ---------------- Rate-Limit ---------------- */

  section('rate limiting');
  const rl = new SlidingWindowRateLimiter(60_000, 3);
  assert(rl.allow('k') && rl.allow('k') && rl.allow('k'), 'der Limiter laesst die ersten 3 durch');
  assert(!rl.allow('k'), 'der Limiter blockt den 4. im Fenster');
  assert(rl.allow('other'), 'die Schluessel des Limiters sind unabhaengig');
  rl.dispose();

  for (let i = 0; i < 10; i++) {
    const r = await confirmInject('000000000000', '10.9.9.9');
    assert(r.statusCode === 400, `Anfrage ${i + 1} passiert den Limiter (ungueltiger Code)`);
  }
  const limited = await confirmInject('000000000000', '10.9.9.9');
  assert(limited.statusCode === 429, 'die 11. Anfrage derselben IP binnen einer Minute -> 429');
  assert(JSON.stringify(limited.json()).includes('rate limited'), 'der 429-Koerper sagt "rate limited"');

  // /api/secrets haengt am selben Admin-Token und wird genauso begrenzt.
  const secretsUnauthed = await app.inject({
    method: 'POST',
    url: '/api/secrets',
    headers: { 'content-type': 'application/json' },
    remoteAddress: '10.8.8.8',
    payload: { kind: 'openai', value: 'x' },
  });
  assert(secretsUnauthed.statusCode === 401, '/api/secrets ohne Admin-Token -> 401');

  /* ---------------- Geraete-Verwaltung ---------------- */

  section('devices');
  const code2 = generatePairingCode(store);
  const pairRes2 = await fetch(`${base}/api/pairing/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code2, deviceName: 'smoke-device-2' }),
  });
  const paired2 = (await pairRes2.json()) as { ok: boolean; deviceId?: string; deviceToken?: string };
  assert(pairRes2.ok && paired2.ok && paired2.deviceId, 'ein zweites Geraet wurde gekoppelt');

  const c3 = new Client(wsBase);
  await c3.opened;
  c3.send({ type: 'hello', deviceId: paired2.deviceId, token: paired2.deviceToken });
  const w3 = await c3.wait((m) => m.type === 'welcome');
  assert(w3.type === 'welcome', 'das zweite Geraet ist authentifiziert');

  const devList = await request(c2, { type: 'device.list', requestId: 'dev1' });
  const devices = devList.type === 'device.list' ? devList.devices : [];
  assert(devices.length >= 2, 'device.list liefert die gekoppelten Geraete');
  assert(devices.find((d) => d.id === paired.deviceId)?.online === true, 'device.list markiert einen lebenden Socket als online');

  const c3Closed = c3.closeCode();
  const rev = await request(c2, { type: 'device.revoke', requestId: 'dev2', deviceId: paired2.deviceId as string });
  assert(rev.type === 'device.revoked', 'device.revoke wird quittiert');
  assert((await c3Closed) === WS_CLOSE_UNAUTHORIZED, 'der Socket eines widerrufenen Geraets wird mit 4001 geschlossen');

  const c4 = new Client(wsBase);
  await c4.opened;
  const c4Closed = c4.closeCode();
  c4.send({ type: 'hello', deviceId: paired2.deviceId, token: paired2.deviceToken });
  assert((await c4Closed) === WS_CLOSE_UNAUTHORIZED, 'hello mit widerrufenem Token -> 4001');

  /* ---------------- Speicher-Hygiene + Admin-CLI ---------------- */

  section('storage + admin cli');
  // Der Trim (appendEvent) läuft gedrosselt (etwa jedes 50. Event), damit nicht
  // jeder Schreibvorgang einen Subquery-Scan auslöst. Er kappt auf 5000, kann die
  // Session danach aber kurz um bis zu ~49 Zeilen überschreiten, bis der nächste
  // Trim greift. 5100 Inserts stellen sicher, dass mindestens ein Trim feuert
  // (jedes Fenster von 50 aufeinanderfolgenden rowids enthält ein Vielfaches von
  // 50); die Obergrenze ist damit 5000 + 49.
  store.db.transaction(() => {
    for (let i = 0; i < 5100; i++) store.appendEvent('smoke-prune-session', 'tick', '{}');
  })();
  const cnt = store.db
    .prepare('SELECT COUNT(*) AS c FROM session_events WHERE session_id = ?')
    .get('smoke-prune-session') as { c: number };
  assert(cnt.c <= 5050, `session_events auf ~5000 (gedrosselter Trim) gestutzt (waren ${cnt.c})`);
  assert(cnt.c < 5100, 'der Trim hat wirklich gefeuert, nicht nur eingefügt');

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]): void => {
    logs.push(a.map(String).join(' '));
  };
  try {
    admin.listDevices(store);
    admin.listLinks(store);
  } finally {
    console.log = origLog;
  }
  assert(logs.join('\n').includes(paired.deviceId as string), 'admin list-devices druckt das gekoppelte Geraet');
  store.createDevice('smoke-admin-dev', 'default', 'admin-test', sha256('x'));
  admin.revokeDevice(store, 'smoke-admin-dev');
  assert(!store.getDevice('smoke-admin-dev'), 'admin revokeDevice entfernt die Zeile');

  /* ---------------- Zusammenfassung ---------------- */

  section('done');
  const total = sections.reduce((n, s) => n + s.checks, 0);
  const width = Math.max(...sections.map((s) => s.name.length));
  console.log('');
  console.log('─'.repeat(width + 12));
  for (const s of sections) console.log(`  ${s.name.padEnd(width)}  ${String(s.checks).padStart(4)} checks`);
  console.log('─'.repeat(width + 12));
  console.log(`  ${'TOTAL'.padEnd(width)}  ${String(total).padStart(4)} checks in ${Math.round((Date.now() - started) / 100) / 10}s`);
  console.log('');
  console.log('SMOKE OK');
  process.exit(0);
}

main().catch((e) => {
  console.error(`SMOKE FAILED [${currentSection}]:`, e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
