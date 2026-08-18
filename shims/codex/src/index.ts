// Egress proxy first: this side-effect import pins undici's global dispatcher
// before any SDK module below can issue a request (see ./proxy).
import './proxy.js';
import { spawn } from 'node:child_process';
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
  ShimStatus,
} from '@pocketagent/protocol';
import { parseLastEventId } from '@pocketagent/protocol';
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
import {
  PromptError,
  RealCodexRunner,
  parseDeviceCodePrompt,
  type CodexRunner,
  type PromptOutcome,
} from './codex.js';

const AGENT_MODES: readonly AgentMode[] = ['yolo', 'auto', 'acceptEdits', 'ask'];

/**
 * Auto-push is a property of the *mode of the current turn*, not of the mode
 * the container booted with: `session.update` switches yolo<->ask mid-session
 * and the orchestrator carries the effective mode on every prompt, while
 * AUTO_PUSH is frozen at container start. Prompts without a mode keep the env.
 */
export function autoPushForMode(mode: AgentMode | undefined, envDefault: boolean): boolean {
  return mode === undefined ? envDefault : mode === 'yolo';
}

/**
 * The app may address models as `<provider>/<modelId>`; codex is always the
 * OpenAI provider, so we keep only the model id (the leading segment, if any,
 * is dropped).
 */
export function splitModelRef(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(slash + 1) : model;
}

export interface ShimConfig {
  port: number;
  token: string;
  workDir: string;
  sessionId: string;
  mode: AgentMode;
  repoUrl?: string;
  repoBranch?: string;
  githubPat?: string;
  repoFullName?: string;
  autoPush: boolean;
  codexHome: string;
  heartbeatMs: number;
  permissionTimeoutMs: number;
  model?: string;
  codexBin?: string;
  codexArgs?: string[];
  deviceAuth: boolean;
}

function intEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv): ShimConfig {
  const token = env.SHIM_TOKEN;
  if (!token) throw new Error('SHIM_TOKEN is required');
  const sessionId = env.SESSION_ID;
  if (!sessionId) throw new Error('SESSION_ID is required');
  const adapter = env.ADAPTER;
  if (adapter !== undefined && adapter !== 'codex') {
    throw new Error(`ADAPTER must be 'codex', got '${adapter}'`);
  }
  const mode = env.AGENT_MODE as AgentMode | undefined;
  if (mode !== undefined && !AGENT_MODES.includes(mode)) {
    throw new Error(`AGENT_MODE must be one of ${AGENT_MODES.join('|')}`);
  }
  const workDir = env.WORK_DIR ?? '/work';
  return {
    port: intEnv(env.PORT, 8080),
    token,
    workDir,
    sessionId,
    mode: mode ?? 'ask',
    repoUrl: env.REPO_URL,
    repoBranch: env.REPO_BRANCH,
    githubPat: readGithubPat() ?? env.GITHUB_PAT,
    repoFullName: env.REPO_FULL_NAME,
    autoPush: env.AUTO_PUSH === '1',
    // Dedicated writable CODEX_HOME (token refresh + thread state); a volume so
    // resume survives container restarts.
    codexHome: env.CODEX_HOME ?? join(homedir(), '.codex'),
    heartbeatMs: intEnv(env.CODEX_HEARTBEAT_MS, 15_000),
    permissionTimeoutMs: intEnv(env.CODEX_PERMISSION_TIMEOUT_MS, 600_000),
    model: splitModelRef(env.CODEX_MODEL),
    codexBin: env.CODEX_BIN,
    codexArgs: env.CODEX_APP_SERVER_ARGS ? env.CODEX_APP_SERVER_ARGS.split(' ').filter(Boolean) : undefined,
    deviceAuth: env.CODEX_DEVICE_AUTH === '1',
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
  runner: CodexRunner;
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
      adapter: 'codex',
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
    const mode = readString(body, 'mode') as AgentMode | undefined;
    if (mode !== undefined && !AGENT_MODES.includes(mode)) {
      return reply.code(400).send({ ok: false, error: `mode must be one of ${AGENT_MODES.join('|')}` });
    }
    const model = splitModelRef(readString(body, 'model'));
    if (runner.status().busy) {
      return reply.code(409).send({ ok: false, error: 'prompt already running' });
    }
    const provider = readString(body, 'provider');
    void runTurn({ text, mode, model, provider });
    return { ok: true as const };
  });

  app.post('/abort', async () => {
    await runner.abort();
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
    // Last-Event-ID replay: on a reconnect the orchestrator's shim client sends
    // the id it last saw and the ring resends everything after it (W2.1), so a
    // dropped SSE connection no longer loses codex events.
    bus.add(raw, parseLastEventId(request.headers['last-event-id']));
  });

  function publishStatus(): void {
    const status = runner.status();
    const event: AgentEvent = {
      type: 'status',
      adapter: 'codex',
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
    } else {
      bus.publish({
        type: 'turn.completed',
        summary: outcome.summary,
        usage: outcome.usage,
        commitSha,
      });
      if (autoPushForMode(request.mode, config.autoPush)) await autoPush();
    }
    if (commitError) bus.publish({ type: 'error', message: commitError });
    publishStatus();
  }

  return app;
}

/**
 * Optional `codex login --device-auth`: prints a verification URL + user code
 * that we surface to the app as a notice event. The full in-app OAuth loopback
 * flow is a later package (W3.4); here we only make the device code visible.
 */
export function startDeviceCodeLogin(config: ShimConfig, emit: (event: AgentEvent) => void): void {
  const child = spawn(config.codexBin ?? 'codex', ['login', '--device-auth'], {
    env: { ...process.env, CODEX_HOME: config.codexHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let announced = false;
  const scan = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) {
      const prompt = parseDeviceCodePrompt(line);
      if (prompt && !announced) {
        announced = true;
        emit({
          type: 'notice',
          message: prompt.verificationUrl
            ? `Codex-Login: ${prompt.verificationUrl} öffnen und Code ${prompt.userCode} eingeben`
            : `Codex-Login: Code ${prompt.userCode} eingeben`,
          detail: JSON.stringify(prompt),
        });
      }
    }
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('error', (error) => emit({ type: 'error', message: `codex login failed: ${error.message}` }));
  child.on('exit', (code) => {
    if (code === 0) emit({ type: 'notice', message: 'Codex-Login abgeschlossen' });
    else emit({ type: 'error', message: `codex login exited with code ${code}` });
  });
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<FastifyInstance> {
  const config = loadConfig(env);
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

  if (config.deviceAuth && !process.env.OPENAI_API_KEY) {
    startDeviceCodeLogin(config, (event) => bus.publish(event));
  }

  const runner = new RealCodexRunner({
    workDir: config.workDir,
    codexHome: config.codexHome,
    mode: config.mode,
    model: config.model,
    permissionTimeoutMs: config.permissionTimeoutMs,
    emit: (event) => bus.publish(event),
    command: config.codexBin,
    args: config.codexArgs,
  });
  await runner.init();

  const app = buildApp({ config, runner, bus, gitCtx, branch });

  // SIGTERM drain: close the app-server child gracefully on container stop.
  const shutdown = (): void => {
    void runner.dispose().finally(() => {
      bus.stop();
      void app.close().finally(() => process.exit(0));
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(
    `codex-shim listening on :${config.port} workDir=${config.workDir} branch=${branch} mode=${config.mode} autoPush=${config.autoPush}`,
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
