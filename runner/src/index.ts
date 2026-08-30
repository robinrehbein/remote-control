// Egress proxy first: this side-effect import pins undici's global dispatcher
// before any SDK module below can issue a request (see ./proxy).
import './proxy.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type {
  AgentEvent,
  AgentMode,
  ModelsResponse,
  PromptRequest,
  ReasoningEffort,
  ShimStatus,
} from '@pocketagent/protocol';
import { AGENT_MODES, REASONING_EFFORTS, autoPushForMode, isAgentMode, isReasoningEffort, parseLastEventId } from '@pocketagent/protocol';
import { EventBroadcaster } from './events.js';
import {
  commitTurn,
  createDraftPr,
  ensureRepo,
  getDiff,
  readGithubPat,
  pushBranch,
  type GitContext,
} from './gitops.js';
import { PromptError, RealPiRunner, type PiRunner, type PromptOutcome } from './pi.js';

/**
 * pi addresses models as provider + id, so `model` may carry the
 * `<provider>/<modelId>` form that GET /models returns; the leading segment
 * then overrides the request's `provider`.
 */
export function splitModelRef(
  provider: string | undefined,
  model: string | undefined,
): { provider?: string; model?: string } {
  if (model === undefined) return { provider, model };
  const slash = model.indexOf('/');
  if (slash > 0) return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
  return { provider, model };
}

export interface ShimConfig {
  port: number;
  /** Bind-Adresse; Default '0.0.0.0' (Container). Der Link-Embed setzt '127.0.0.1'. */
  host: string;
  token: string;
  workDir: string;
  sessionId: string;
  mode: AgentMode;
  repoUrl?: string;
  repoBranch?: string;
  githubPat?: string;
  repoFullName?: string;
  autoPush: boolean;
  agentDir: string;
  sessionDir: string;
  heartbeatMs: number;
  permissionTimeoutMs: number;
  autoContinue: boolean;
  provider?: string;
  model?: string;
}

function intEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Wie intEnv, aber 0 ist ein gültiger Wert: PORT=0 heißt "vom OS einen freien
 * Port vergeben lassen" (der Link-Embed nutzt das statt eines eigenen
 * freePort()-Rennens; den tatsächlichen Port liest main() nach dem listen aus
 * app.server.address()). Nur ein negativer/ungültiger Wert fällt auf fallback.
 */
function portEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv): ShimConfig {
  const token = env.SHIM_TOKEN;
  if (!token) throw new Error('SHIM_TOKEN is required');
  const sessionId = env.SESSION_ID;
  if (!sessionId) throw new Error('SESSION_ID is required');
  const mode = env.AGENT_MODE;
  if (mode !== undefined && !isAgentMode(mode)) {
    throw new Error(`AGENT_MODE must be one of ${AGENT_MODES.join('|')}`);
  }
  const workDir = env.WORK_DIR ?? '/work';
  return {
    port: portEnv(env.PORT, 8080),
    host: env.HOST ?? '0.0.0.0',
    token,
    workDir,
    sessionId,
    mode: mode ?? 'ask',
    repoUrl: env.REPO_URL,
    repoBranch: env.REPO_BRANCH,
    // PA_CREDS_FILE ({githubPat}) with GITHUB_PAT env fallback; see readGithubPat.
    githubPat: readGithubPat() ?? env.GITHUB_PAT,
    repoFullName: env.REPO_FULL_NAME,
    autoPush: env.AUTO_PUSH === '1',
    agentDir: env.PI_AGENT_DIR ?? join(homedir(), '.pi', 'agent'),
    sessionDir: env.PI_SESSION_DIR ?? join(workDir, '.pi-sessions'),
    heartbeatMs: intEnv(env.PI_HEARTBEAT_MS, 15_000),
    permissionTimeoutMs: intEnv(env.PI_PERMISSION_TIMEOUT_MS, 600_000),
    autoContinue: env.PI_AUTO_CONTINUE !== '0',
    provider: env.PI_PROVIDER,
    model: env.PI_MODEL,
  };
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const provided = createHash('sha256').update(header.slice(7)).digest();
  const expected = createHash('sha256').update(token).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

interface UnknownBody {
  [key: string]: unknown;
}

function readString(body: UnknownBody, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface AppDeps {
  config: ShimConfig;
  runner: PiRunner;
  bus: EventBroadcaster;
  gitCtx: GitContext;
  branch: string;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, runner, bus, gitCtx, branch } = deps;

  const app = fastify({ logger: false });

  app.addContentTypeParser<string>(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      if (body === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch (error) {
        done(error instanceof Error ? error : new Error('invalid JSON body'), undefined);
      }
    },
  );

  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === '/health' || request.routeOptions.url === '/health') return;
    if (!bearerMatches(request.headers.authorization, config.token)) {
      await reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
  });

  app.get('/health', async () => ({ ok: true as const }));

  app.get('/status', async () => {
    const status = runner.status();
    const response: ShimStatus = {
      sessionRef: status.sessionRef,
      provider: status.provider,
      model: status.model,
      mode: status.mode,
      busy: status.busy,
    };
    return response;
  });

  app.get('/models', async (): Promise<ModelsResponse> => ({ models: runner.listModels?.() ?? [] }));

  app.get('/diff', async () => getDiff(gitCtx));

  app.post('/prompt', async (request, reply) => {
    const body = (request.body ?? {}) as UnknownBody;
    const text = typeof body.text === 'string' ? body.text : undefined;
    if (!text || text.trim().length === 0) {
      return reply.code(400).send({ ok: false, error: 'text is required' });
    }
    const mode = readString(body, 'mode');
    if (mode !== undefined && !isAgentMode(mode)) {
      return reply.code(400).send({ ok: false, error: `mode must be one of ${AGENT_MODES.join('|')}` });
    }
    const { provider, model } = splitModelRef(
      readString(body, 'provider'),
      readString(body, 'model'),
    );
    const reasoningEffort = readString(body, 'reasoningEffort');
    if (reasoningEffort !== undefined && !isReasoningEffort(reasoningEffort)) {
      return reply
        .code(400)
        .send({ ok: false, error: `reasoningEffort must be one of ${REASONING_EFFORTS.join('|')}` });
    }
    try {
      await runner.validateModel(provider, model);
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
    if (runner.status().busy) {
      return reply.code(409).send({ ok: false, error: 'prompt already running' });
    }
    void runTurn({
      text,
      mode: mode as AgentMode | undefined,
      provider,
      model,
      reasoningEffort: reasoningEffort as ReasoningEffort | undefined,
    });
    return { ok: true as const };
  });

  app.post('/abort', async (_request, reply) => {
    try {
      await runner.abort();
    } catch (error) {
      // Abbruch ohne initialisierten Runner/aktive Session ist ein Client-Fehler
      // (nichts zum Abbrechen da), kein Server-Absturz - 400 statt 500.
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
    return { ok: true as const };
  });

  app.post('/resume', async (request, reply) => {
    const body = (request.body ?? {}) as UnknownBody;
    const sessionRef = readString(body, 'sessionRef');
    if (!sessionRef) {
      return reply.code(400).send({ ok: false, error: 'sessionRef is required' });
    }
    if (runner.status().busy) {
      return reply.code(409).send({ ok: false, error: 'prompt already running' });
    }
    try {
      await runner.resume(sessionRef);
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
    publishStatus();
    return { ok: true as const };
  });

  app.post<{ Params: { id: string } }>('/permissions/:id', async (request, reply) => {
    const body = (request.body ?? {}) as UnknownBody;
    const response = readString(body, 'response');
    if (response !== 'once' && response !== 'always' && response !== 'reject') {
      return reply.code(400).send({ ok: false, error: "response must be 'once' | 'always' | 'reject'" });
    }
    if (!runner.resolvePermission(request.params.id, response)) {
      return reply.code(404).send({ ok: false, error: 'unknown permission id' });
    }
    return { ok: true as const };
  });

  app.get('/events', async (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    raw.write('retry: 5000\n\n');
    raw.write(': connected\n\n');
    // On a reconnect the orchestrator sends the last seq it saw; the ring
    // replays everything after it so no event is lost across the gap.
    bus.add(raw, parseLastEventId(request.headers['last-event-id']));
    request.raw.on('close', () => {
      bus.remove(raw);
    });
  });

  function publishStatus(): void {
    const status = runner.status();
    const event: AgentEvent = {
      type: 'status',
      sessionRef: status.sessionRef,
      provider: status.provider,
      model: status.model,
      mode: status.mode,
      busy: status.busy,
    };
    bus.publish(event);
  }

  async function autoPush(): Promise<void> {
    try {
      await pushBranch(gitCtx, branch);
      const prUrl = await createDraftPr(gitCtx, branch);
      bus.publish({ type: 'pushed', branch, prUrl, auto: true });
    } catch (error) {
      bus.publish({ type: 'error', message: errorMessage(error) });
    }
  }

  async function runTurn(request: PromptRequest): Promise<void> {
    let outcome: PromptOutcome;
    try {
      const turn = runner.prompt(request.text, request);
      publishStatus();
      outcome = await turn;
    } catch (error) {
      bus.publish({ type: 'turn.failed', error: errorMessage(error) });
      publishStatus();
      return;
    }
    let commitSha: string | undefined;
    let commitError: string | undefined;
    try {
      commitSha = await commitTurn(gitCtx, new Date().toISOString());
    } catch (error) {
      commitError = errorMessage(error);
    }
    if (outcome.errorMessage) {
      bus.publish({ type: 'turn.failed', error: outcome.errorMessage });
    } else if (outcome.aborted) {
      // Nutzer-/Timeout-Abbruch (stopReason 'aborted'): eigener Endzustand, damit
      // die Timeline „unterbrochen" von „fertig" trennt statt einen leeren Turn
      // als 'abgebrochen'-Zusammenfassung zu zeigen. Kein Auto-Push — ein
      // abgeschnittener Turn soll keinen Draft-PR auslösen.
      bus.publish({ type: 'turn.interrupted', reason: outcome.summary });
    } else {
      bus.publish({
        type: 'turn.completed',
        summary: outcome.summary,
        usage: outcome.usage,
        commitSha,
      });
      // Auto-push ist Eigenschaft des Turn-Modus (PI_MODE_SEMANTICS aus dem
      // Protokoll), nicht des Boot-Modus; siehe autoPushForMode dort.
      if (autoPushForMode(request.mode, config.autoPush)) await autoPush();
    }
    if (commitError) bus.publish({ type: 'error', message: commitError });
    publishStatus();
  }

  return app;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<FastifyInstance> {
  const config = loadConfig(env);
  // Sicherheit: SHIM_TOKEN ist das API-Token, mit dem der Orchestrator u. a. das
  // Permission-Gate (/permissions/<id>) authentifiziert. loadConfig hat es bereits
  // in config.token eingelesen; danach aus der Prozess-Umgebung löschen, damit
  // Bash-Kinder des Agenten es nicht erben und ihr eigenes Approval-Gate per curl
  // auf 127.0.0.1:8080 umgehen können. Die Proxy-Vars (HTTP(S)_PROXY) bleiben - sie
  // tragen ein separates, abgeleitetes Egress-Credential (proxyTokenFor), das dank
  // Host-Allowlist harmlos ist und sich nicht in das API-Token zurückrechnen lässt.
  // Wirkt auf process.env (die Kinder erben genau diese): im Container ist env ===
  // process.env; im Link-Embed erhält main() ein eigenes env-Objekt und process.env
  // trägt hier gar kein SHIM_TOKEN, das delete ist dort ein No-op.
  delete process.env.SHIM_TOKEN;
  const gitCtx: GitContext = {
    workDir: config.workDir,
    sessionId: config.sessionId,
    repoUrl: config.repoUrl,
    repoBranch: config.repoBranch,
    githubPat: config.githubPat,
    repoFullName: config.repoFullName,
  };
  const branch = await ensureRepo(gitCtx);
  const bus = new EventBroadcaster();
  bus.startHeartbeat(config.heartbeatMs);
  const runner = new RealPiRunner({
    workDir: config.workDir,
    agentDir: config.agentDir,
    sessionDir: config.sessionDir,
    mode: config.mode,
    provider: config.provider,
    model: config.model,
    authPath: join(config.agentDir, 'auth.json'),
    autoContinue: config.autoContinue,
    permissionTimeoutMs: config.permissionTimeoutMs,
    emit: event => bus.publish(event),
  });
  await runner.init();
  const app = buildApp({ config, runner, bus, gitCtx, branch });
  await app.listen({ port: config.port, host: config.host });
  // Tatsächlichen Port aus dem Server lesen: bei PORT=0 hat das OS ihn erst hier
  // vergeben (der Link-Embed liest ihn danach ebenfalls aus app.server.address()).
  const addr = app.server.address();
  const boundPort = addr !== null && typeof addr === 'object' ? addr.port : config.port;
  console.log(
    `pi-runner listening on ${config.host}:${boundPort} workDir=${config.workDir} branch=${branch} mode=${config.mode} autoPush=${config.autoPush}`,
  );
  return app;
}

const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(error => {
    console.error('fatal:', errorMessage(error));
    process.exit(1);
  });
}
