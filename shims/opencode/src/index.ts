import { spawn, type ChildProcess } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import Fastify, { type FastifyReply } from 'fastify';
import { selectModel } from '@pocketagent/protocol';
import type { AgentMode, PermissionDecision, PromptRequest, ResumeRequest, ShimStatus } from '@pocketagent/protocol';
import { readEnv, type ShimEnvConfig } from './env';
import { parsePermissionJson, permissionForMode, writeOpencodeConfig, type PermissionMap } from './modes';
import * as gitops from './gitops';
import { OpenCodeClient, type PromptMessageBody } from './opencode-client';
import { Broadcaster, EventNormalizer } from './events';

const MODES: readonly AgentMode[] = ['yolo', 'auto', 'acceptEdits', 'ask'];
const DECISIONS: readonly PermissionDecision[] = ['once', 'always', 'reject'];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function resolveOpenCodeBin(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('opencode-ai/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin?: string | Record<string, string> };
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.opencode ?? pkg.bin?.['opencode-ai'];
  if (typeof rel !== 'string') throw new Error('opencode-ai bin entry not found');
  return resolve(dirname(pkgPath), rel);
}

function spawnOpenCode(env: ShimEnvConfig, onDead: (reason: string) => void): ChildProcess {
  const bin = resolveOpenCodeBin();
  const args = ['serve', '--port', String(env.opencodePort), '--hostname', '127.0.0.1'];
  // inherit full env so provider credentials (OPENAI_API_KEY, ...) reach opencode
  const isJs = /\.(c|m)?js$/.test(bin);
  const child = isJs
    ? spawn(process.execPath, [bin, ...args], { cwd: env.workDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(bin, args, { cwd: env.workDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tail: string[] = [];
  const collect = (chunk: Buffer): void => {
    tail.push(chunk.toString());
    while (tail.join('').length > 4000 && tail.length > 1) tail.shift();
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  child.on('exit', (code, signal) => {
    onDead(`opencode serve exited (code=${code ?? '?'} signal=${signal ?? '?'}): ${tail.join('').slice(-1500)}`);
  });
  return child;
}

/**
 * Auto-push is a property of the *mode of the current turn*, not of the mode
 * the container happened to boot with: `session.update` switches yolo<->ask
 * mid-session and the orchestrator carries the effective mode on every prompt.
 * Prompts without a mode (older orchestrators) keep the AUTO_PUSH env default.
 */
function autoPushForMode(mode: AgentMode | undefined, envDefault: boolean): boolean {
  return mode === undefined ? envDefault : mode === 'yolo';
}

function tokenOk(header: string | undefined, expected: string): boolean {
  if (header === undefined) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function main(): Promise<void> {
  const env = readEnv();
  if (!env.shimToken) {
    console.error('SHIM_TOKEN is required');
    process.exit(1);
  }

  let mode: AgentMode = env.agentMode;
  let permission: PermissionMap = env.opencodePermission
    ? parsePermissionJson(env.opencodePermission)
    : permissionForMode(mode);
  let provider: string | undefined;
  let model: string | undefined;
  let opencodeSessionId: string | undefined;
  let autoPush = env.autoPush;
  // last mode written to opencode.json - re-writing it on every prompt is
  // pointless work, so the config is only rewritten when the mode changed
  let appliedMode: AgentMode = mode;

  const branch = await gitops.ensureRepo(env);
  writeOpencodeConfig(env.workDir, permission, mode);

  const client = new OpenCodeClient(env.opencodeBase);
  let child: ChildProcess | undefined;
  if (env.opencodeSpawn) {
    child = spawnOpenCode(env, (reason) => {
      console.error(`[opencode] ${reason}`);
    });
    if (!(await client.waitReady(30000))) {
      console.error('[opencode] not reachable within 30s');
      child.kill('SIGTERM');
      process.exit(1);
    }
  }

  for (let attempt = 0; attempt < 3 && opencodeSessionId === undefined; attempt++) {
    opencodeSessionId = await client.createSession(env.workDir);
    if (opencodeSessionId === undefined) await sleep(500);
  }
  if (opencodeSessionId === undefined && env.opencodeSpawn) {
    console.error('[opencode] could not create session');
    child?.kill('SIGTERM');
    process.exit(1);
  }
  console.log(`[opencode] session ${opencodeSessionId ?? 'pending'}`);

  const broadcaster = new Broadcaster();
  const normalizer = new EventNormalizer({
    client,
    broadcaster,
    getSessionId: () => opencodeSessionId,
    getBranch: () => branch,
    getMode: () => mode,
    getProviderModel: () => ({ provider, model }),
    isAutoPush: () => autoPush,
    commitTurn: () => gitops.commitTurn(env.workDir),
    pushTurn: () => gitops.pushAndDraftPR(env),
  });
  client.startEventStream((raw) => normalizer.handleRaw(raw));

  const tickTimer = setInterval(() => normalizer.tick(), 2000);
  const beatTimer = setInterval(() => broadcaster.broadcast({ type: 'ping', ts: Date.now() }), 15000);

  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health' || request.url.startsWith('/health?')) return;
    if (!tokenOk(request.headers.authorization, env.shimToken)) {
      await reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
  });

  app.setErrorHandler((err, _request, reply) => {
    reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/status', async (): Promise<ShimStatus> => ({
    adapter: 'opencode',
    sessionRef: opencodeSessionId,
    provider,
    model,
    mode,
    busy: normalizer.isBusy(),
  }));

  app.post('/prompt', async (request, reply) => {
    const body = request.body as Partial<PromptRequest> | undefined;
    const text = body?.text;
    if (typeof text !== 'string' || text.length === 0) {
      return await reply.code(400).send({ ok: false, error: 'text is required' });
    }
    const promptMode = body?.mode !== undefined && MODES.includes(body.mode) ? body.mode : undefined;
    if (promptMode !== undefined) {
      mode = promptMode;
      if (mode !== appliedMode) {
        permission = permissionForMode(mode);
        // best effort: opencode may pick up config changes on new turns
        writeOpencodeConfig(env.workDir, permission, mode);
        appliedMode = mode;
      }
    }
    autoPush = autoPushForMode(promptMode, env.autoPush);
    // reasoningEffort is intentionally ignored: opencode has no per-prompt
    // effort knob, so the manifest reports capabilities.reasoning === false.
    const selected = selectModel({ provider, model }, body ?? {});
    provider = selected.provider;
    model = selected.model;
    if (opencodeSessionId === undefined) {
      return await reply.code(409).send({ ok: false, error: 'no opencode session' });
    }
    const payload: PromptMessageBody = {
      parts: [{ type: 'text', text }],
      ...(provider !== undefined && model !== undefined ? { model: { providerID: provider, modelID: model } } : {}),
    };
    // mark busy up-front: the sync /message route only responds after the whole
    // turn streamed past, so events arrive while the POST is still in flight
    normalizer.startPrompt();
    // opencode >= 1.18 has /prompt_async (204 now, failures via session.error events);
    // fall back to the legacy sync /message route for older runtimes
    let status = await client.promptMessageAsync(opencodeSessionId, payload);
    if (status === 404 || status === 405 || status === 501) {
      status = await client.promptMessage(opencodeSessionId, payload);
    }
    if (status < 200 || status >= 300) {
      const error = `opencode message failed (HTTP ${status})`;
      broadcaster.broadcast({ type: 'error', message: error, fatal: false });
      normalizer.failTurn(error);
      return await reply.code(502).send({ ok: false, error });
    }
    return await reply.send({ ok: true });
  });

  app.post('/abort', async (_request, reply) => {
    if (opencodeSessionId !== undefined) await client.abort(opencodeSessionId);
    normalizer.abortPrompt();
    return await reply.send({ ok: true });
  });

  app.post('/resume', async (request, reply) => {
    const body = request.body as Partial<ResumeRequest> | undefined;
    if (typeof body?.sessionRef !== 'string' || body.sessionRef.length === 0) {
      return await reply.code(400).send({ ok: false, error: 'sessionRef is required' });
    }
    const sessions = await client.listSessions(env.workDir);
    if (sessions.includes(body.sessionRef)) {
      opencodeSessionId = body.sessionRef;
    } else {
      opencodeSessionId = await client.createSession(env.workDir);
    }
    if (opencodeSessionId === undefined) {
      return await reply.code(502).send({ ok: false, error: 'could not resume or create opencode session' });
    }
    normalizer.emitStatus();
    return await reply.send({ ok: true });
  });

  app.post<{ Params: { permissionId: string } }>('/permissions/:permissionId', async (request, reply) => {
    const response = (request.body as { response?: unknown } | undefined)?.response;
    if (typeof response !== 'string' || !DECISIONS.includes(response as PermissionDecision)) {
      return await reply.code(400).send({ ok: false, error: 'response must be once|always|reject' });
    }
    if (opencodeSessionId === undefined) {
      return await reply.code(409).send({ ok: false, error: 'no opencode session' });
    }
    const result = await client.respondPermission(opencodeSessionId, request.params.permissionId, response as PermissionDecision);
    if (result === 'error') {
      return await reply.code(502).send({ ok: false, error: `permission respond failed (HTTP error)` });
    }
    if (result === 'unavailable') {
      broadcaster.broadcast({
        type: 'error',
        message: `warning: permission respond route unavailable for ${request.params.permissionId}; decisions are handled via the opencode event bus`,
        fatal: false,
      });
    }
    return await reply.send({ ok: true });
  });

  app.get('/models', async () => ({ models: await client.models() }));

  app.get('/diff', async () => (opencodeSessionId === undefined ? [] : await client.diff(opencodeSessionId)));

  app.get('/events', (_request, reply) => {
    openEventStream(reply, broadcaster, () => normalizer.emitStatus());
  });

  const shutdown = (): void => {
    clearInterval(tickTimer);
    clearInterval(beatTimer);
    child?.kill('SIGTERM');
    void app.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: env.port, host: '0.0.0.0' });
  console.log(`[shim] listening on :${env.port} (opencode ${env.opencodeSpawn ? `spawned :${env.opencodePort}` : `external ${env.opencodeBase}`})`);
}

function openEventStream(reply: FastifyReply, broadcaster: Broadcaster, sendInitial: () => void): void {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  raw.write(': connected\n\n');
  broadcaster.add(raw);
  sendInitial();
  raw.on('close', () => broadcaster.remove(raw));
}

void main();
