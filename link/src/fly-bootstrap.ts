/**
 * Fly-Machine-Bootstrap (Fly-Sessions, F4): läuft VOR dem normalen
 * Link-Agent-Einstieg (index.ts) und bringt eine disk-lose Fly-Machine in
 * einen definierten Repo-Zustand - Repo-State lebt im Git, nicht auf Disk:
 *
 *   - PA_WORKDIR leer/halbleer (frische Machine, oder ein früherer Clone wurde
 *     unterbrochen): frischer `git clone` von PA_REPO_URL (PA_REPO_BRANCH,
 *     Default-Branch ohne Angabe) nach PA_WORKDIR. Das Workdir IST der Checkout
 *     selbst (kein Unterverzeichnis `repo/`), weil runner-embed.ts genau das
 *     erwartet: WORK_DIR = PA_WORKDIR, und ensureRepo() (runner/src/gitops.ts)
 *     arbeitet auf genau diesem Verzeichnis.
 *   - Existiert Remote-Branch PA_AGENT_BRANCH (Resume: der Runner der vorigen
 *     Machine-Runde hat auf agent/<session-id> committet und gepusht): den
 *     auschecken und per --ff-only auf den Remote-Stand ziehen. Lokale, noch
 *     nicht gepushte Commits bleiben erhalten; Divergenz wird nur gemeldet.
 *   - Existiert er nicht (frische Session): Basis-Checkout stehen lassen -
 *     ensureRepo() legt die agent/<sessionId>-Branch beim Runner-Start selbst an.
 *   - Checkout vorhanden (Machine-Restart ohne Diskverlust): fetch + dieselbe
 *     Branch-Logik; die HEAD-Position einer laufenden Runde wird nicht
 *     umgebogen, ensureRepo() sortiert das beim Runner-Start.
 *
 * PAT-Handling: der GitHub-PAT (GITHUB_PAT) läuft NIE durch die Clone-URL,
 * .git/config oder argv, sondern - exakt wie bei den Link-/Docker-Sessions des
 * Runners - über den wiederverwendeten GIT_ASKPASS-Helfer aus runner/src/
 * gitops.ts (askpassEnv): git fragt den Helfer, der den PAT aus der Env liest.
 *
 * Proxy: Git (libcurl) liest HTTPS_PROXY/HTTP_PROXY/NO_PROXY selbst - Clone und
 * Fetch einer 'allowlist'-Session laufen also durch den Egress-Proxy des
 * Orchestrators, 'isolated' (HTTPS_PROXY=http://127.0.0.1:9) bricht den Clone
 * bewusst. Die WSS-Verbindung des Link-Agenten ist davon unberührt (ws nutzt
 * keine Proxy-Env, siehe agent.ts). Vor dem Start des Agenten ergänzt
 * ensureLoopbackNoProxy() eine Loopback-Ausnahme, damit die eigenen
 * 127.0.0.1-Fetches zum eingebetteten Runner (agent.ts) den globalen
 * EnvHttpProxyDispatcher des Runner-Embeds nie nehmen müssen.
 *
 * Danach startet main() den unveränderten CLI-Einstieg (index.ts) per
 * dynamischem Import - PA_SERVER/PA_TOKEN/PA_MODE/PA_NAME/PA_WORKDIR usw.
 * werden dort genau wie sonst gelesen.
 *
 * Nutzung (Runner/Dockerfile.fly, ENTRYPOINT):
 *   node --import tsx /app/link/src/fly-bootstrap.ts
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { envProxyUrl } from '@pocketagent/protocol';
import { askpassEnv, redact, stripCredentials } from '../../runner/src/gitops.js';

const execFileAsync = promisify(execFile);

const LOG_PREFIX = '[fly-bootstrap]';

export interface FlyBootstrapOptions {
  /** PA_WORKDIR: Ziel des Clones/Checkout - identisch zum Runner-WORK_DIR. */
  workDir: string;
  /** PA_REPO_URL: https-Clone-URL ohne Token. Ohne sie findet kein Bootstrap statt. */
  repoUrl?: string;
  /** PA_REPO_BRANCH: Basis-Branch (Vorgabe: Default-Branch des Repos). */
  repoBranch?: string;
  /** PA_AGENT_BRANCH: agent/<session-id>; wird ausgerollt, wenn er remote existiert. */
  agentBranch?: string;
  /** GITHUB_PAT: nur für Clone/Fetch/Push; nie in URL, .git/config oder argv. */
  githubPat?: string;
  log?: (message: string) => void;
}

/** Git-Kindprozess mit askpassEnv (PAT via GIT_ASKPASS) und PAT-Redaktion in Fehlern. */
async function runGit(
  cwd: string,
  args: string[],
  githubPat: string | undefined,
  timeoutMs = 120_000,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: askpassEnv(githubPat),
    });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(redact(`git ${args[0] ?? ''} failed: ${detail}`, githubPat));
  }
}

/**
 * True, wenn workDir ein benutzbares Checkout von expectedUrl ist. Ein
 * unterbrochener Clone (z. B. Machine mitten im Clone gestoppt) hinterlässt
 * entweder kein .git, keins mit auflösbarem HEAD oder keins mit dem
 * erwarteten Origin - alles zählt als "halbleer" und wird neu geklont.
 */
async function isUsableCheckout(workDir: string, expectedUrl: string): Promise<boolean> {
  if (!existsSync(join(workDir, '.git'))) return false;
  try {
    await runGit(workDir, ['rev-parse', '--verify', 'HEAD'], undefined);
    const url = (await runGit(workDir, ['remote', 'get-url', 'origin'], undefined)).trim();
    return stripCredentials(url) === stripCredentials(expectedUrl);
  } catch {
    return false;
  }
}

function wipeWorkDir(workDir: string): void {
  if (workDir === '/' || workDir.length <= 1) {
    throw new Error(`refusing to wipe unsafe workdir '${workDir}'`);
  }
  rmSync(workDir, { recursive: true, force: true });
}

/** Ob origin/<branch> als Remote-Ref bekannt ist (nach Clone oder Fetch; kein Netz). */
async function hasRemoteBranch(workDir: string, branch: string): Promise<boolean> {
  try {
    await runGit(workDir, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], undefined);
    return true;
  } catch {
    return false;
  }
}

async function currentBranch(workDir: string): Promise<string> {
  return (await runGit(workDir, ['rev-parse', '--abbrev-ref', 'HEAD'], undefined)).trim();
}

/**
 * Bringt PA_WORKDIR in den Zielzustand (Clone/Resume) und liefert das
 * Workdir samttatsächlich ausgecheckter Branch zurück. Wirft bei Fehlern
 * mit deutlicher Meldung - der Aufrufer (Machine-Restart-Policy) fängt auf.
 */
export async function prepareFlyWorkdir(opts: FlyBootstrapOptions): Promise<{ workDir: string; branch: string }> {
  const log = opts.log ?? ((m: string) => console.log(`${LOG_PREFIX} ${m}`));
  const workDir = resolve(opts.workDir);
  if (!opts.repoUrl) {
    log('no repo URL configured - skipping repo bootstrap');
    return { workDir, branch: '' };
  }
  const repoUrl = stripCredentials(opts.repoUrl.trim());

  if (await isUsableCheckout(workDir, repoUrl)) {
    // Resume ohne Diskverlust: Remote-Stand anziehen, dann Branch-Logik.
    log(`existing checkout of ${repoUrl} - fetching origin`);
    await runGit(workDir, ['fetch', 'origin', '--prune'], opts.githubPat, 300_000);
  } else {
    // Leer, halbleer (unterbrochener Clone) oder Fremd-Checkout: neu klonen.
    if (existsSync(workDir) && readdirSync(workDir).length > 0) {
      log(`workdir is not a usable checkout of ${repoUrl} - wiping and re-cloning`);
      wipeWorkDir(workDir);
    }
    await mkdir(dirname(workDir), { recursive: true });
    const args = ['clone'];
    if (opts.repoBranch) args.push('--branch', opts.repoBranch);
    // Nackte URL: Auth (GITHUB_PAT) fließt über GIT_ASKPASS, nie über die URL.
    args.push(repoUrl, workDir);
    await runGit(dirname(workDir), args, opts.githubPat, 300_000);
    log(`cloned ${repoUrl}${opts.repoBranch ? ` (branch ${opts.repoBranch})` : ''}`);
  }

  const agentBranch = opts.agentBranch?.trim();
  if (agentBranch && (await hasRemoteBranch(workDir, agentBranch))) {
    if ((await currentBranch(workDir)) !== agentBranch) {
      // DWIM: legt eine lokale Tracking-Branch an, falls noch keine existiert.
      await runGit(workDir, ['checkout', agentBranch], undefined);
    }
    try {
      await runGit(workDir, ['merge', '--ff-only', `origin/${agentBranch}`], opts.githubPat);
    } catch (error) {
      // Lokal divergiert (z. B. unpusheter Commit aus einer abgerissenen Runde):
      // Lokalen Stand behalten - der nächste Push scheitert dann sichtbar,
      // statt dass hier still Daten weggeräumt werden.
      const detail = error instanceof Error ? error.message : String(error);
      log(`warning: ${agentBranch} is not fast-forwardable to origin/${agentBranch} - keeping local state (${detail.split('\n')[0]})`);
    }
    log(`agent branch ${agentBranch} checked out`);
    return { workDir, branch: agentBranch };
  }

  // Kein Remote-Agent-Branch (frische Session): Basis-Checkout stehen lassen -
  // nach frischem Clone ist HEAD bereits PA_REPO_BRANCH/Default-Branch, und in
  // einem laufenden Checkout sortiert ensureRepo() die Branch beim Runner-Start.
  const branch = await currentBranch(workDir);
  log(`base checkout on ${branch}${agentBranch ? ` (no remote branch ${agentBranch} yet)` : ''}`);
  return { workDir, branch };
}

/**
 * Ergänzt 127.0.0.1/localhost zur NO_PROXY-Liste, wenn ein Proxy konfiguriert
 * ist - die eigenen Loopback-Fetches des Link-Agenten (agent.ts gegen den
 * eingebetteten Runner) dürfen nie über den Egress-Proxy laufen, und der
 * Runner-Embed installiert den EnvHttpProxyDispatcher global. Vorhandene
 * Einträge (z. B. der Orchestrator-Host) bleiben erhalten; ohne Proxy-Env
 * ('open') passiert nichts. Wird vor dem Import von index.ts aufgerufen,
 * weil der Dispatcher die Env beim Import von runner/src/proxy.ts liest.
 */
export function ensureLoopbackNoProxy(env: NodeJS.ProcessEnv): void {
  if (envProxyUrl(env) === undefined) return;
  const tokens = new Set(['127.0.0.1', 'localhost']);
  for (const key of ['NO_PROXY', 'no_proxy'] as const) {
    const raw = env[key];
    if (!raw) continue;
    for (const token of raw.split(',')) {
      const trimmed = token.trim();
      if (trimmed) tokens.add(trimmed);
    }
  }
  const merged = [...tokens].join(',');
  env.NO_PROXY = merged;
  env.no_proxy = merged;
}

async function main(): Promise<void> {
  // Zuerst die Env für alles Folgende richten (Runner-Embed, git, undici).
  ensureLoopbackNoProxy(process.env);

  const repoUrl = process.env.PA_REPO_URL;
  if (repoUrl) {
    const workDir = process.env.PA_WORKDIR;
    if (!workDir) {
      throw new Error('PA_REPO_URL is set but PA_WORKDIR is missing - cannot bootstrap the repo');
    }
    const { branch } = await prepareFlyWorkdir({
      workDir,
      repoUrl,
      repoBranch: process.env.PA_REPO_BRANCH,
      agentBranch: process.env.PA_AGENT_BRANCH,
      githubPat: process.env.GITHUB_PAT,
    });
    console.log(`${LOG_PREFIX} repo ready: workDir=${workDir} branch=${branch || '(unchanged)'}`);
  } else {
    console.log(`${LOG_PREFIX} PA_REPO_URL not set - starting link agent without repo bootstrap`);
  }

  // Unverändert der normale CLI-Einstieg: liest PA_SERVER/PA_TOKEN/PA_MODE/
  // PA_NAME/PA_WORKDIR (nun der frische Checkout) und bindet agent.ts +
  // runner-embed.ts an den echten pi-Runner. Import bewusst dynamisch und erst
  // nach dem Clone - so wertet kein Modul des Agenten eine Env aus, bevor
  // NO_PROXY und das Repo stehen.
  await import('./index.js');
}

const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(`${LOG_PREFIX} fatal: ${error instanceof Error ? error.message : String(error)}`);
    // Non-zero: die Restart-Policy der Machine (Provisioning, F5) greift.
    process.exit(1);
  });
}
