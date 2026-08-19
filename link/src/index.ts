/**
 * PocketAgent link agent - CLI-Einstiegspunkt.
 *
 * Läuft in JEDER Umgebung mit Node 22 + diesem Repo-Checkout (Devcontainer,
 * Heim-PC, VPS): bettet den pi-Runner IN-PROCESS ein (siehe runner-embed.ts,
 * die HTTP-Schnittstelle spricht Localhost auf einem ephemeren Port) und
 * verbindet sich per AUSGEHENDER WebSocket mit dem Orchestrator - keine
 * offenen Ports, kein NAT/Tunnel-Setup nötig. `PA_ADAPTER` gibt es nicht
 * mehr: der Link-Agent startet immer denselben pi-Runner-Code, den auch
 * jeder Session-Container fährt.
 *
 * Env-Contract (siehe RUNBOOK-PI.md):
 *   PA_SERVER   wss://orchestrator (Pflicht)
 *   PA_TOKEN    Link-Token aus `npm run link-token` o.ä. (Pflicht)
 *   PA_WORKDIR  lokaler Repo-Checkout, auf dem der Agent arbeitet (Vorgabe: cwd)
 *   PA_NAME     Anzeigename + SESSION_ID-Vorgabe des Runners (Vorgabe: hostname)
 *   PA_MODE     yolo|auto|acceptEdits|ask (Vorgabe: ask)
 *   PA_BRANCH   optionaler Basis-Branch, an `agent.hello` gereicht
 *   OPENAI_API_KEY / ZAI_API_KEY / KIMI_API_KEY / ANTHROPIC_API_KEY /
 *               GEMINI_API_KEY   pi-Provider-Keys, direkt aus der Umgebung
 *               dieses Prozesses gelesen (PI_PROVIDER_ENV im Protokoll) -
 *               kein Server-Vault-Bezug, die Keys bleiben auf diesem Rechner.
 *   GITHUB_PAT  optional, nur für Auto-Push + Draft-PR im yolo-Modus nötig.
 *   PA_REPO_FULL_NAME  optional, owner/name für die Draft-PR-API (ohne sie
 *               pusht der Runner im yolo-Modus, legt aber keine PR an).
 *
 * Nutzung:
 *   PA_SERVER=wss://orch.example.com PA_TOKEN=... OPENAI_API_KEY=sk-... \
 *     npm run start -w link -- --mode ask --workdir /home/robin/code/myproject
 */
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import type { AgentMode } from '@pocketagent/protocol';
import { AGENT_MODES } from '@pocketagent/protocol';
import { startLinkAgent } from './agent.js';
import { embedPiRunner } from './runner-embed.js';

interface Args {
  server: string;
  token: string;
  mode: AgentMode;
  workDir: string;
  name: string;
  branch: string;
}

function arg(name: string, fallback: string): string {
  const flag = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(flag));
  return hit ? hit.slice(flag.length) : fallback;
}

function isAgentMode(value: string): value is AgentMode {
  return (AGENT_MODES as readonly string[]).includes(value);
}

const rawMode = arg('mode', process.env.PA_MODE ?? 'ask');
const args: Args = {
  server: arg('server', process.env.PA_SERVER ?? ''),
  token: arg('token', process.env.PA_TOKEN ?? ''),
  mode: isAgentMode(rawMode) ? rawMode : 'ask',
  workDir: resolve(arg('workdir', process.env.PA_WORKDIR ?? process.cwd())),
  name: arg('name', process.env.PA_NAME ?? hostname()),
  branch: arg('branch', process.env.PA_BRANCH ?? ''),
};

if (!args.server || !args.token) {
  console.error('usage: PA_SERVER=wss://... PA_TOKEN=... npm run start -w link -- [--mode ask] [--workdir /path]');
  process.exit(1);
}

const log = (m: string): void => console.log(`[link] ${m}`);
log(`mode=${args.mode} workDir=${args.workDir} name=${args.name}`);

const handle = startLinkAgent({
  server: args.server,
  token: args.token,
  name: args.name,
  mode: args.mode,
  workDir: args.workDir,
  branch: args.branch || undefined,
  startRunner: () =>
    embedPiRunner({
      workDir: args.workDir,
      mode: args.mode,
      sessionId: args.name,
      repoFullName: process.env.PA_REPO_FULL_NAME,
      autoPush: args.mode === 'yolo',
    }),
  log,
  onTerminal: (code) => {
    // Kleine Gnadenfrist, damit der letzte WS-Close-Frame noch rausgeht,
    // bevor der Prozess endet - wie v1.
    setTimeout(() => process.exit(code), 500);
  },
});

function shutdownFromSignal(): void {
  void handle.shutdown().then(() => process.exit(0));
}

process.on('SIGINT', shutdownFromSignal);
process.on('SIGTERM', shutdownFromSignal);
