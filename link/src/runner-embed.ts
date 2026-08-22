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
import net from 'node:net';
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
 * Freien Loopback-Port belegen. Der Runner selbst kennt kein "PORT=0" fürs
 * automatische Vergeben - `intEnv` in runner/src/index.ts verwirft 0 als
 * ungültig und fällt auf 8080 zurück -, also muss der Aufrufer den Port
 * vorher selbst wählen, genau wie v1 es für den Shim-Kindprozess tat.
 */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('no free port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolvePort(port));
    });
  });
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
 *
 * Proxy-Env (HTTPS_PROXY/HTTP_PROXY inkl. Userinfo, NO_PROXY) läuft ebenso
 * unverändert mit: Der Import von runner/src/index.js hier unten zieht dessen
 * ersten Import './proxy.js' hoch, der bei gesetzter Proxy-Env (siehe
 * envProxyUrl im Protokoll) den globalen EnvHttpProxyDispatcher installiert -
 * NO_PROXY (Orchestrator-Host, Loopback für die eigenen 127.0.0.1-Aufrufe in
 * agent.ts) respektiert der Agent selbst. Die WSS-Verbindung des Link-Agenten
 * bleibt davon unberührt: Die ws-Library nutzt weder Proxy-Env noch undici-
 * Dispatcher (verifiziert - link/src setzt nirgends einen globalen Dispatcher
 * und übergibt der WebSocket kein Agent-Objekt).
 */
export async function embedPiRunner(opts: EmbedPiRunnerOptions): Promise<EmbeddedRunner> {
  const port = await freePort();
  const token = randomBytes(24).toString('hex');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SHIM_TOKEN: token,
    PORT: String(port),
    WORK_DIR: opts.workDir,
    AGENT_MODE: opts.mode,
    SESSION_ID: opts.sessionId,
    // Lokaler Checkout, kein Klon: der Link-Agent arbeitet direkt auf dem
    // bereits vorhandenen Repo unter PA_WORKDIR. ensureRepo() (runner/src/
    // gitops.ts) erkennt das leere REPO_URL und legt nur die
    // agent/<sessionId>-Branch auf dem bestehenden Checkout an.
    REPO_URL: '',
    REPO_FULL_NAME: opts.repoFullName ?? opts.sessionId,
    AUTO_PUSH: opts.autoPush ? '1' : '0',
  };
  const app = await main(env);
  return {
    port,
    token,
    close: () => app.close(),
  };
}
