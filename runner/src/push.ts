#!/usr/bin/env node
/**
 * PocketAgent pi-runner standalone push helper (Tap-Push).
 *
 * Committet schmutzigen Stand, pusht die Agenten-Branch und legt eine Draft-PR
 * an. Best-effort: beendet sich IMMER mit Exit 0 - Fehler landen (mit
 * redigierten Secrets) auf stderr; stdout gehört keinem, der Orchestrator liest
 * nur den Exitcode. Der Orchestrator startet dieses Skript in einem
 * Wegwerf-Container auf demselben Volume (server/src/docker.ts oneShotPush,
 * `node dist/push.js`, siehe RUNNER_PUSH_SCRIPT).
 *
 * Diese Datei dupliziert NICHTS mehr aus gitops.ts (früher war push.js eine
 * per Hand kopierte Zweitfassung von ASKPASS_SCRIPT/readGithubPat/askpassEnv/
 * redact/stripPat/Draft-PR-Fetch - die driftete). Sie ruft dieselben
 * exportierten Funktionen auf, die auch der laufende Runner nutzt, und wird über
 * tsconfig.build.json (`include: ["src"]`) nach dist/push.js gebaut.
 *
 * Env: WORK_DIR, SESSION_ID, PA_CREDS_FILE/GITHUB_PAT, REPO_FULL_NAME,
 *      REPO_BRANCH (Basis, Default main).
 */
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { installEnvProxyDispatcher } from '@pocketagent/protocol';
import {
  agentBranch,
  commitTurn,
  createDraftPr,
  hasUncommittedChanges,
  pushBranch,
  readGithubPat,
  redact,
  type GitContext,
} from './gitops.js';

// Dieselbe Egress-Regel wie der Runner-Prozess selbst (src/proxy.ts): Node
// beachtet HTTP_PROXY/HTTPS_PROXY nicht von allein, und unter Policy 'allowlist'
// hat dieser Container keinen anderen Weg zu api.github.com. Keine Logzeile hier.
installEnvProxyDispatcher(process.env, () => {
  setGlobalDispatcher(new EnvHttpProxyAgent());
});

function log(message: string, pat?: string): void {
  process.stderr.write(`[push] ${redact(message, pat)}\n`);
}

async function main(): Promise<void> {
  const pat = readGithubPat();
  const ctx: GitContext = {
    workDir: process.env.WORK_DIR || process.cwd(),
    sessionId: process.env.SESSION_ID || 'unknown-session',
    repoBranch: process.env.REPO_BRANCH || 'main',
    githubPat: pat,
    repoFullName: process.env.REPO_FULL_NAME || undefined,
  };
  const branch = agentBranch(ctx.sessionId);

  try {
    // Nur committen, wenn es wirklich etwas zu committen gibt - kein
    // --allow-empty-Leer-Commit pro Push (siehe commitTurn/hasUncommittedChanges).
    if (await hasUncommittedChanges(ctx)) {
      await commitTurn(ctx, new Date().toISOString());
      log('committed dirty state', pat);
    }
  } catch (e) {
    log(`commit failed: ${e instanceof Error ? e.message : String(e)}`, pat);
    return;
  }

  try {
    await pushBranch(ctx, branch);
    log(`pushed ${branch}`, pat);
  } catch (e) {
    log(`push failed: ${e instanceof Error ? e.message : String(e)}`, pat);
    return;
  }

  if (!pat || !ctx.repoFullName) {
    log('no GitHub PAT/REPO_FULL_NAME; skipping draft PR', pat);
    return;
  }
  try {
    const url = await createDraftPr(ctx, branch);
    log(url ? `draft PR: ${url}` : 'draft PR already exists', pat);
  } catch (e) {
    log(`draft PR failed: ${e instanceof Error ? e.message : String(e)}`, pat);
  }
}

// Best-effort: immer Exit 0 (der Orchestrator wertet nur einen Absturz als
// Fehler; jeder inhaltliche Fehler steht redigiert auf stderr).
void main().then(() => process.exit(0));
