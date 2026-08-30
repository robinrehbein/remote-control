/**
 * Bettet den pi-Runner (runner/src/index.ts) in-process im Link-Agenten ein,
 * statt ihn wie in v1 als externen Shim-Kindprozess zu spawnen. `PA_ADAPTER`
 * entfällt komplett - der Link-Agent startet immer denselben pi-Runner-Code,
 * den auch jeder Session-Container fährt (siehe GREENFIELD-PI.md, G1.4).
 *
 * Relativer Import statt npm-Paket-Abhängigkeit: `runner/` ist (bewusst,
 * siehe G1.3) kein Mitglied des Root-Workspace, und dieses Paket darf die
 * Root-`package.json` nicht anfassen (G2.1 formalisiert die Workspace-
 * Aufnahme). Node/tsx lösen den relativen Pfad zur Laufzeit direkt auf;
 * `runner`s eigene Laufzeit-Abhängigkeiten (fastify, `@earendil-works/pi-
 * coding-agent`, undici, `@pocketagent/protocol`) werden dabei ganz normal
 * ab `runner/node_modules` gefunden, weil Node die Auflösung eines bloßen
 * Bezeichners immer beim Verzeichnis der IMPORTIERENDEN Datei beginnt -
 * unabhängig davon, wer sie importiert hat. Voraussetzung: `npm install` lief
 * einmal in `runner/` (eigenes package-lock.json, siehe RUNBOOK-PI).
 */
import { randomBytes } from 'node:crypto';
import type { AgentMode } from '@pocketagent/protocol';
import { main } from '../../runner/src/index.js';
import type { EmbeddedRunner } from './agent.js';

export interface EmbedPiRunnerOptions {
  /** Bereits vorhandener lokaler Checkout - siehe REPO_URL unten. */
  workDir: string;
  mode: AgentMode;
  /** Git-Branch des Runners (`agent/<sessionId>`) und Boot-Wert von SESSION_ID. */
  sessionId: string;
  /** owner/name für die Draft-PR-API; ohne sie legt der Runner keine PR an. */
  repoFullName?: string;
  autoPush: boolean;
}

/**
 * Startet eine frische pi-Runner-Instanz auf einem neuen ephemeren Port mit
 * einem neu erzeugten SHIM_TOKEN (Server-Vault ist hier nicht im Spiel - das
 * Token schützt nur die lokale HTTP-Schnittstelle im selben Prozess). Provider-
 * Keys (OPENAI_API_KEY etc., siehe PI_PROVIDER_ENV im Protokoll) und
 * GITHUB_PAT werden NICHT extra verdrahtet: sie kommen aus der echten
 * process.env dieses Link-Agent-Prozesses, in der sie der Betreiber beim
 * Start gesetzt hat, und laufen über `...process.env` unverändert durch -
 * der pi-SDK und `readGithubPat()` (runner/src/gitops.ts) lesen sie selbst.
 */
export async function embedPiRunner(opts: EmbedPiRunnerOptions): Promise<EmbeddedRunner> {
  const token = randomBytes(24).toString('hex');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SHIM_TOKEN: token,
    // PORT=0: das OS vergibt einen freien Loopback-Port, den main() nach dem
    // listen aus app.server.address() zurückgibt. Kein eigenes freePort()-Rennen
    // mehr (zwischen Wahl und listen könnte ein anderer Prozess den Port belegen).
    PORT: '0',
    // Nur lokal erreichbar: der eingebettete Runner ist eine reine In-Process-
    // Schnittstelle des Link-Agenten, nichts von aussen darf ihn ansprechen.
    HOST: '127.0.0.1',
    WORK_DIR: opts.workDir,
    AGENT_MODE: opts.mode,
    SESSION_ID: opts.sessionId,
    // Lokaler Checkout, kein Klon: der Link-Agent arbeitet direkt auf dem
    // bereits vorhandenen Repo unter PA_WORKDIR. ensureRepo() (runner/src/
    // gitops.ts) erkennt das leere REPO_URL und legt nur die
    // agent/<sessionId>-Branch auf dem bestehenden Checkout an.
    REPO_URL: '',
    // Kein Fallback auf sessionId: ohne echtes owner/name legt der Runner keine
    // Draft-PR an. Ein Fallback wie <sessionId> ergäbe repos/<sessionId>/pulls ->
    // 404 nach jedem Yolo-Turn. undefined => REPO_FULL_NAME bleibt ungesetzt.
    ...(opts.repoFullName !== undefined ? { REPO_FULL_NAME: opts.repoFullName } : {}),
    AUTO_PUSH: opts.autoPush ? '1' : '0',
  };
  const app = await main(env);
  const addr = app.server.address();
  const port = addr !== null && typeof addr === 'object' ? addr.port : 0;
  return {
    port,
    token,
    close: () => app.close(),
  };
}
