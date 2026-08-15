import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type {
  AgentEvent,
  AgentMode,
  PromptRequest,
  ShimStatus,
} from '@pocketagent/protocol';
import { EventBroadcaster } from './events';
import { commitTurn, createDraftPr, ensureRepo, getDiff, pushBranch, type GitContext } from './gitops';
import { PromptError, RealPiRunner, type PiRunner, type PromptOutcome } from './pi';

const AGENT_MODES: readonly AgentMode[] = ['yolo', 'auto', 'acceptEdits', 'ask'];

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
  agentDir: string;
  sessionDir: string;
  authJson?: string;
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

export function loadConfig(env: NodeJS.ProcessEnv): ShimConfig {
  const token = env.SHIM_TOKEN;
  if (!token) throw new Error('SHIM_TOKEN is required');
  const sessionId = env.SESSION_ID;
  if (!sessionId) throw new Error('SESSION_ID is required');
  const adapter = env.ADAPTER;
  if (adapter !== undefined && adapter !== 'pi') {
    throw new Error(`ADAPTER must be 'pi', got '${adapter}'`);
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
    agentDir: env.PI_AGENT_DIR ?? join(homedir(), '.pi', 'agent'),
    sessionDir: env.PI_SESSION_DIR ?? join(workDir, '.pi-sessions'),
    authJson: env.PI_AUTH_JSON,
    heartbeatMs: intEnv(env.PI_HEARTBEAT_MS, 15_000),
    permissionTimeoutMs: intEnv(env.PI_PERMISSION_TIMEOUT_MS, 600_000),
    autoContinue: env.PI_AUTO_CONTINUE !== '0',
    provider: env.PI_PROVIDER,
    model: env.PI_MODEL,
  };
}

/** Orchestrator-injected pi auth.json (credential store), written 0600. */
async function writeAuthFile(config: ShimConfig): Promise<void> {
  if (!config.authJson) return;
  await mkdir(config.agentDir, { recursive: true });
  await writeFile(join(config.agentDir, 'auth.json'), config.authJson, { mode: 0o600 });
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
      adapter: 'pi',
      sessionRef: status.sessionRef,
      provider: status.provider,
      model: status.model,
      mode: status.mode,
      busy: status.busy,
    };
    return response;
  });

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
    const provider = readString(body, 'provider');
    const model = readString(body, 'model');
    try {
      await runner.validateModel(provider, model);
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
    if (runner.status().busy) {
      return reply.code(409).send({ ok: false, error: 'prompt already running' });
    }
    void runTurn({ text, mode, provider, model });
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
    bus.add(raw);
    request.raw.on('close', () => {
      bus.remove(raw);
    });
  });

  function publishStatus(): void {
    const status = runner.status();
    const event: AgentEvent = {
      type: 'status',
      adapter: 'pi',
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
      if (config.autoPush) await autoPush();
    }
    if (commitError) bus.publish({ type: 'error', message: commitError });
    publishStatus();
  }

  return app;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<FastifyInstance> {
  const config = loadConfig(env);
  await writeAuthFile(config);
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
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(
    `pi-shim listening on :${config.port} workDir=${config.workDir} branch=${branch} mode=${config.mode} autoPush=${config.autoPush}`,
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
