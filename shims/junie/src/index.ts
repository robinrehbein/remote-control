import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { AgentEvent, AgentMode, ModelsResponse, PromptRequest, ShimStatus } from '@pocketagent/protocol';
import { EventBroadcaster } from './events';
import { commitTurn, createDraftPr, ensureRepo, getDiff, pushBranch, type GitContext } from './gitops';
import { RealJunieRunner, type JunieRunner } from './junie';

const AGENT_MODES: readonly AgentMode[] = ['yolo', 'auto', 'acceptEdits', 'ask'];

const NO_APPROVALS_WARNING = 'Junie: keine Remote-Approvals, läuft ohne Gates';
const NO_PERMISSIONS_WARNING = 'Junie: Permission-Antworten werden nicht unterstützt (no-op)';

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
  heartbeatMs: number;
  provider?: string;
  model?: string;
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
  if (adapter !== undefined && adapter !== 'junie') {
    throw new Error(`ADAPTER must be 'junie', got '${adapter}'`);
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
    githubPat: env.GITHUB_PAT,
    repoFullName: env.REPO_FULL_NAME,
    autoPush: env.AUTO_PUSH === '1',
    heartbeatMs: intEnv(env.JUNIE_HEARTBEAT_MS, 15_000),
    provider: env.JUNIE_LLM_PROVIDER,
    model: env.JUNIE_MODEL,
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
  runner: JunieRunner;
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
      if (body === '' || body === undefined) {
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
      adapter: 'junie',
      sessionRef: status.sessionRef,
      provider: status.provider,
      model: status.model,
      mode: status.mode,
      busy: status.busy,
    };
    return response;
  });

  // junie has no queryable model catalog (models come from the CLI/BYOK
  // config), so the list stays empty and the app falls back to free text.
  app.get('/models', async (): Promise<ModelsResponse> => ({ models: [] }));

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
    if (runner.status().busy) {
      return reply.code(409).send({ ok: false, error: 'prompt already running' });
    }
    const prompt: PromptRequest = {
      text,
      mode,
      provider: readString(body, 'provider'),
      model: readString(body, 'model'),
    };
    void runTurn(prompt);
    return { ok: true as const };
  });

  app.post('/abort', async () => {
    await runner.abort();
    return { ok: true as const };
  });

  // Degradation: junie one-shot cannot resume a session; the ref is only
  // stored so /status can surface it to the orchestrator.
  app.post('/resume', async (request, reply) => {
    const body = (request.body ?? {}) as UnknownBody;
    const sessionRef = readString(body, 'sessionRef');
    if (!sessionRef) {
      return reply.code(400).send({ ok: false, error: 'sessionRef is required' });
    }
    if (runner.status().busy) {
      return reply.code(409).send({ ok: false, error: 'prompt already running' });
    }
    await runner.resume(sessionRef);
    publishStatus();
    return { ok: true as const };
  });

  // Degradation: junie has no permission callbacks; acknowledge + warn.
  app.post<{ Params: { id: string } }>('/permissions/:id', async (request, reply) => {
    const body = (request.body ?? {}) as UnknownBody;
    const response = readString(body, 'response');
    if (response !== 'once' && response !== 'always' && response !== 'reject') {
      return reply.code(400).send({ ok: false, error: "response must be 'once' | 'always' | 'reject'" });
    }
    bus.publish({ type: 'error', message: NO_PERMISSIONS_WARNING });
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
    bus.add(raw);
    request.raw.on('close', () => {
      bus.remove(raw);
    });
  });

  function publishStatus(): void {
    const status = runner.status();
    const event: AgentEvent = {
      type: 'status',
      adapter: 'junie',
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
    const effectiveMode = request.mode ?? runner.status().mode;
    if (effectiveMode === 'ask' || effectiveMode === 'acceptEdits') {
      bus.publish({ type: 'error', message: NO_APPROVALS_WARNING });
    }
    let outcome;
    try {
      const turn = runner.prompt(request.text, request);
      publishStatus();
      outcome = await turn;
    } catch (error) {
      bus.publish({ type: 'turn.failed', error: errorMessage(error) });
      publishStatus();
      return;
    }
    if (!outcome.ok) {
      bus.publish({ type: 'turn.failed', error: outcome.error ?? 'junie turn failed' });
      publishStatus();
      return;
    }
    if (outcome.finalText !== undefined && outcome.finalText.length > 0) {
      bus.publish({ type: 'message.completed', role: 'assistant', text: outcome.finalText });
    }
    let commitSha: string | undefined;
    let commitError: string | undefined;
    try {
      commitSha = await commitTurn(gitCtx, new Date().toISOString());
    } catch (error) {
      commitError = errorMessage(error);
    }
    bus.publish({
      type: 'turn.completed',
      summary: outcome.finalText?.slice(0, 200),
      usage: outcome.usage,
      commitSha,
    });
    if (commitError !== undefined) bus.publish({ type: 'error', message: commitError });
    if (config.autoPush) await autoPush();
    publishStatus();
  }

  return app;
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
  const runner = new RealJunieRunner({
    workDir: config.workDir,
    mode: config.mode,
    provider: config.provider,
    model: config.model,
    env,
    emit: event => bus.publish(event),
  });
  const app = buildApp({ config, runner, bus, gitCtx, branch });
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(
    `junie-shim listening on :${config.port} workDir=${config.workDir} branch=${branch} mode=${config.mode} autoPush=${config.autoPush}`,
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
