/**
 * PocketAgent Claude shim: fastify HTTP server exposing the unified shim
 * protocol on top of the Claude Code Agent SDK.
 */
import type {
  AgentMode,
  AgentEvent,
  DiffEntry,
  ModelsResponse,
  PromptRequest,
  ReasoningEffort,
  ResumeRequest,
  ShimStatus,
} from '@pocketagent/protocol';
import { fastify } from 'fastify';
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import {
  CLAUDE_MODELS,
  ClaudeSession,
  hasCredentials,
  sdkRunnerFactory,
  writeClaudeAuthBootstrap,
} from './claude.ts';
import type { RunnerFactory } from './claude.ts';
import { EventBroadcaster } from './events.ts';
import { commitTurn, ensureRepo, getDiff, pushAndCreatePr, readGithubPat } from './gitops.ts';

const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

export interface ShimConfig {
  token: string;
  workDir: string;
  sessionId: string;
  mode: AgentMode;
  model?: string;
  autoPush: boolean;
  github: { pat?: string; repoFullName?: string; base?: string };
}

/** Constant-time bearer-token comparison (same approach as shims/opencode). */
function tokenOk(header: string | undefined, expected: string): boolean {
  if (header === undefined) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function loadConfigFromEnv(): ShimConfig {
  const modeEnv = process.env.AGENT_MODE;
  const mode: AgentMode =
    modeEnv === 'yolo' || modeEnv === 'auto' || modeEnv === 'acceptEdits' || modeEnv === 'ask'
      ? modeEnv
      : 'ask';
  return {
    token: process.env.SHIM_TOKEN ?? '',
    workDir: process.env.WORK_DIR ?? '/work',
    sessionId: process.env.SESSION_ID ?? 'local',
    mode,
    model: process.env.CLAUDE_MODEL,
    autoPush: process.env.AUTO_PUSH === '1',
    github: {
      pat: readGithubPat(),
      repoFullName: process.env.REPO_FULL_NAME,
      base: process.env.REPO_BRANCH,
    },
  };
}

export function buildServer(cfg: ShimConfig, runnerFactory?: RunnerFactory): FastifyInstance {
  const app = fastify({ logger: false, forceCloseConnections: true });
  const broadcaster = new EventBroadcaster();
  broadcaster.startHeartbeat(15_000);

  const session = new ClaudeSession({
    cwd: cfg.workDir,
    mode: cfg.mode,
    model: cfg.model,
    autoPush: cfg.autoPush,
    runnerFactory: runnerFactory ?? sdkRunnerFactory,
    publish: (event: AgentEvent) => broadcaster.publish(event),
    commitTurn: () => commitTurn(cfg.workDir),
    pushBranch: () =>
      pushAndCreatePr({
        workDir: cfg.workDir,
        sessionId: cfg.sessionId,
        pat: cfg.github.pat,
        repoFullName: cfg.github.repoFullName,
        base: cfg.github.base,
      }),
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health' || req.url.startsWith('/health')) return;
    if (!cfg.token || !tokenOk(req.headers.authorization, cfg.token)) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/status', async (): Promise<ShimStatus> => session.status());

  app.post<{ Body: PromptRequest }>('/prompt', async (req, reply) => {
    const body = req.body;
    if (typeof body?.text !== 'string' || body.text.trim().length === 0) {
      return reply.code(400).send({ ok: false, error: 'text required' });
    }
    if (body.reasoningEffort !== undefined && !REASONING_EFFORTS.includes(body.reasoningEffort)) {
      return reply.code(400).send({ ok: false, error: 'reasoningEffort must be low|medium|high' });
    }
    try {
      await session.prompt(body.text, {
        mode: body.mode,
        model: body.model,
        reasoningEffort: body.reasoningEffort,
      });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message === 'busy' ? 409 : 500;
      return reply.code(code).send({ ok: false, error: message });
    }
  });

  app.post('/abort', async () => {
    await session.abort();
    return { ok: true };
  });

  app.post<{ Body: ResumeRequest }>('/resume', async (req, reply) => {
    const sessionRef = req.body?.sessionRef;
    if (typeof sessionRef !== 'string' || sessionRef.length === 0) {
      return reply.code(400).send({ ok: false, error: 'sessionRef required' });
    }
    try {
      await session.resume(sessionRef);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message === 'busy' ? 409 : 500;
      return reply.code(code).send({ ok: false, error: message });
    }
  });

  app.post<{ Params: { id: string }; Body: { response?: string } }>(
    '/permissions/:id',
    async (req, reply) => {
      const response = req.body?.response;
      if (response !== 'once' && response !== 'always' && response !== 'reject') {
        return reply.code(400).send({ ok: false, error: 'response must be once|always|reject' });
      }
      if (!session.replyPermission(req.params.id, response)) {
        return reply.code(404).send({ ok: false, error: 'unknown permissionId' });
      }
      return { ok: true };
    },
  );

  app.get('/models', async (): Promise<ModelsResponse> => ({ models: [...CLAUDE_MODELS] }));

  app.get('/diff', async (): Promise<DiffEntry[]> => {
    try {
      return await getDiff(cfg.workDir);
    } catch (err) {
      throw Object.assign(
        new Error(err instanceof Error ? err.message : String(err)),
        { statusCode: 500 },
      );
    }
  });

  app.get('/events', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    broadcaster.add(reply.raw);
  });

  app.setNotFoundHandler(async (req, reply) => {
    reply.code(404).send({ ok: false, error: 'not found' });
  });

  app.setErrorHandler(async (err, req, reply) => {
    const e = err as { statusCode?: number; message?: string };
    const statusCode = e.statusCode ?? 500;
    reply.code(statusCode).send({ ok: false, error: e.message ?? 'internal error' });
  });

  app.addHook('onClose', async () => {
    broadcaster.stopHeartbeat();
    session.close();
  });

  return app;
}

export async function main(): Promise<void> {
  const cfg = loadConfigFromEnv();
  if (!cfg.token) {
    console.error('SHIM_TOKEN env var is required');
    process.exit(1);
  }

  let runnerFactory: RunnerFactory | undefined;
  if (process.env.SMOKE_FAKE === '1') {
    // Non-literal specifier keeps smoke/ out of the tsc emit graph
    // (tsconfig.build.json uses rootDir=src); reachable via tsx from source.
    const fakeModulePath = '../smoke/fakerunner.ts';
    const mod = (await import(fakeModulePath)) as { fakeRunnerFactory: RunnerFactory };
    runnerFactory = mod.fakeRunnerFactory;
  }

  await writeClaudeAuthBootstrap();
  if (!hasCredentials()) {
    console.error('warning: neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set');
  }

  try {
    const result = await ensureRepo({
      workDir: cfg.workDir,
      repoUrl: process.env.REPO_URL,
      repoBranch: process.env.REPO_BRANCH,
      pat: cfg.github.pat,
      sessionId: cfg.sessionId,
    });
    console.log(`repo bootstrap: ${result}`);
  } catch (err) {
    console.error(`repo bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const app = buildServer(cfg, runnerFactory);
  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`claude-shim listening on :${port}`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.filename === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
