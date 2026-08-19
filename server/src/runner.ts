/**
 * Alles, was den EINEN pi-Runner beschreibt: sein Image, sein Build-Kontext im
 * Server-Image und die Umgebung, die ein Session-Container bekommt.
 *
 * Das ist der Rest der Adapter-Schicht aus v1 (`adapters.ts` + `image-build.ts`,
 * beide entfallen): es gibt kein Manifest mehr, keine Registry-Auswahl und keine
 * Content-Hash-Tags. Ein Image, eine Provider-Tabelle - und die steht im
 * Protokoll (`PI_PROVIDER_ENV`), damit Server, Runner und App dieselbe lesen.
 *
 * Bewusst frei von `dockerode`: die Ableitungen hier sind pur und deshalb im
 * Smoke ohne Daemon prüfbar; das Bauen selbst liegt in docker.ts.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentMode, ShimEnv } from '@pocketagent/protocol';
import { PI_MODE_SEMANTICS, piProviderEnvVar } from '@pocketagent/protocol';
import { runnerImageName } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Arbeitsverzeichnis (Repo-Checkout) im Container - Gegenstück zum Volume-Bind. */
export const RUNNER_WORK_DIR = '/work';

/** Port, auf dem der Runner seine REST/SSE-Oberfläche anbietet. */
export const RUNNER_PORT = 8080;

/**
 * Arbeitsverzeichnis des Runners im Image - `WORKDIR /app/runner` in
 * `runner/Dockerfile`. Alles unterhalb entspricht 1:1 dem Verzeichnis `runner/`
 * des Build-Kontexts (bis auf `dist/`, das der Bau selbst erzeugt).
 */
export const RUNNER_IMAGE_DIR = '/app/runner';

/**
 * Eigenständiges Push-Skript, RELATIV zum Runner-Verzeichnis (Tap-Push,
 * `session.push`): es läuft in einem Wegwerf-Container auf demselben Volume,
 * ohne den Agenten zu starten. In v1 kam der Pfad aus dem Adapter-Manifest,
 * jetzt ist es diese eine Konstante.
 *
 * Der Pfad ist bewusst `scripts/…` und nicht `dist/…`: `push.js` ist fertiges
 * JavaScript, kein TypeScript, also emittiert `npm run build` (tsc, `include:
 * ["src"]`) es nie nach `dist/`. `runner/Dockerfile` kopiert `runner/scripts`
 * unverändert nach `/app/runner/scripts` - genau dort liegt die Datei, und
 * weil derselbe relative Pfad auch im Build-Kontext gilt, prüft der Smoke ihn
 * gegen `runnerContextFiles()` statt gegen ein Image.
 */
export const RUNNER_PUSH_SCRIPT_REL = 'scripts/push.js';

/** Absoluter Pfad desselben Skripts im laufenden Container. */
export const RUNNER_PUSH_SCRIPT = `${RUNNER_IMAGE_DIR}/${RUNNER_PUSH_SCRIPT_REL}`;

/** Der eine Image-Name (siehe config.runnerImageName). */
export { runnerImageName };

/**
 * Verzeichnisse, die nie in einen Build-Kontext gehören - das Dockerfile des
 * Runners installiert selbst (`npm ci`).
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.smoke-work']);

let rootCache: string | null | undefined;

/**
 * Wurzel des mitgelieferten Build-Kontexts: `/app/build-context` im
 * Server-Image, das Repo-Root beim Lauf aus den Quellen. Der Inhalt MUSS
 * genau die Struktur haben, die `runner/Dockerfile` erwartet (es kopiert
 * `tsconfig.base.json`, `packages/protocol` und `runner/` aus dem Kontext), weil
 * Coolify nur `server/Dockerfile` baut und das Runner-Image sonst nie entsteht.
 */
export function runnerContextRoot(): string | null {
  if (rootCache !== undefined) return rootCache;
  const candidates = [
    process.env.RUNNER_BUILD_CONTEXT,
    resolve(here, '../build-context'), // dist/ -> /app/build-context
    resolve(here, '../..'), // src/ -> Repo-Root (Entwicklung)
    '/app/build-context',
  ].filter((d): d is string => typeof d === 'string' && d.length > 0);
  rootCache =
    candidates.find(
      (d) =>
        existsSync(join(d, 'tsconfig.base.json')) &&
        existsSync(join(d, 'packages', 'protocol')) &&
        existsSync(join(d, 'runner', 'Dockerfile')),
    ) ?? null;
  return rootCache;
}

/** Cache zurücksetzen (Tests, die RUNNER_BUILD_CONTEXT umbiegen). */
export function resetRunnerContextCache(): void {
  rootCache = undefined;
}

function walk(root: string, rel: string, out: string[]): void {
  const abs = join(root, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return; // optionaler Eintrag
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
 * Sortierte Dateiliste des Build-Kontexts, relativ zu `runnerContextRoot()`;
 * `null`, wenn im Server-Image kein Kontext liegt. Anders als in v1 ist das nur
 * noch der Staging-Plan - gehasht wird nichts mehr.
 */
export function runnerContextFiles(): string[] | null {
  const root = runnerContextRoot();
  if (root === null) return null;
  const files: string[] = [];
  walk(root, 'tsconfig.base.json', files);
  walk(root, 'packages/protocol', files);
  walk(root, 'runner', files);
  return files.sort();
}

/** Zugang zum Vault, wie `buildRunnerEnv` ihn braucht (Kind -> Klartext oder null). */
export type SecretLookup = (kind: string) => string | null;

/**
 * Secret-Arten, die denselben Schlüssel meinen und sich deshalb gegenseitig
 * vertreten dürfen. Genau ein Fall: `moonshot` und `kimi` sind zwei Namen für
 * dasselbe Konto bei platform.moonshot.ai und teilen sich in `PI_PROVIDER_ENV`
 * ohnehin die Variable `KIMI_API_KEY`.
 *
 * Ohne diesen Fallback läuft man in einen Fehler, der wie ein Bug aussieht: in
 * der App liegt unter „Moonshot" ein Key, die Session wählt Provider `kimi` -
 * und der Container startet ohne Schlüssel, obwohl derselbe Wert im Vault
 * liegt. Die App warnt davor bereits (PiCatalog.kt), aber der Server ist die
 * Stelle, an der es entschieden wird.
 */
const SECRET_ALIASES: Readonly<Record<string, string>> = {
  moonshot: 'kimi',
  kimi: 'moonshot',
};

/**
 * Vault-Zugriff mit Alias-Fallback: erst die gefragte Art, dann - falls es für
 * sie einen Alias gibt - dessen Secret. Alles andere bleibt strikt, ein
 * fehlender Key ist weiterhin `null`.
 */
export function lookupProviderSecret(kind: string, secret: SecretLookup): string | null {
  const direct = secret(kind);
  if (direct !== null) return direct;
  const alias = SECRET_ALIASES[kind];
  return alias === undefined ? null : secret(alias);
}

export interface RunnerEnvInput {
  sessionId: string;
  shimToken: string;
  mode: AgentMode;
  provider: string;
  /** Leerer String => pi-Vorgabemodell; wird dann gar nicht gesetzt. */
  model: string;
  repoFullName: string;
  /** Basis-Branch, von dem aus die Session startet. */
  baseBranch: string;
}

/**
 * Container-Umgebung einer Session nach `ShimEnv`.
 *
 * Zwei Regeln, die der Runner sich darauf verlässt:
 *  - Es wird **genau ein** Provider-Key injiziert, unter dem Namen aus
 *    `PI_PROVIDER_ENV`. Ein unbekannter Provider setzt gar keinen Key - der
 *    Runner meldet den fehlenden Key sauber als Turn-Fehler, statt dass hier
 *    ein falsch benannter landet. Welches Secret dafür gezogen wird, entscheidet
 *    `lookupProviderSecret` (moonshot <-> kimi vertreten sich).
 *  - `AUTO_PUSH` ist nur der Startwert (yolo => '1'); den Modus eines einzelnen
 *    Turns entscheidet der Runner über `PromptRequest.mode`
 *    (`autoPushForMode`), weil `session.update` mitten in der Session umschaltet.
 *
 * Der GitHub-PAT wandert NICHT über die Umgebung: er wird als
 * `/run/secrets/pa/creds.json` in den noch nicht gestarteten Container gelegt
 * (docker.injectCredsFile) und der Pfad hier nur benannt. `GITHUB_PAT` bleibt
 * deshalb leer, obwohl `ShimEnv` es kennt.
 */
export function buildRunnerEnv(input: RunnerEnvInput, secret: SecretLookup): ShimEnv {
  const env: ShimEnv = {
    SHIM_TOKEN: input.shimToken,
    WORK_DIR: RUNNER_WORK_DIR,
    AGENT_MODE: input.mode,
    SESSION_ID: input.sessionId,
    REPO_URL: `https://github.com/${input.repoFullName}.git`,
    REPO_BRANCH: input.baseBranch,
    REPO_FULL_NAME: input.repoFullName,
    AUTO_PUSH: PI_MODE_SEMANTICS[input.mode].autoPush ? '1' : '0',
    PI_PROVIDER: input.provider,
    // Creds-Datei statt Env (siehe oben); der Runner liest den Pfad beim Start.
    PA_CREDS_FILE: '/run/secrets/pa/creds.json',
  };
  if (input.model.length > 0) env.PI_MODEL = input.model;
  const providerVar = piProviderEnvVar(input.provider);
  if (providerVar !== undefined) {
    const key = lookupProviderSecret(input.provider, secret);
    if (key !== null) env[providerVar] = key;
  }
  return env;
}
