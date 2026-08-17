/**
 * In-app Codex OAuth (CODEX-OAUTH.md, Variante A "Browser-Login mit
 * Callback-Forwarding" + Device-Code-Fallback).
 *
 * The orchestrator drives codex's own login through `codex app-server`
 * (JSON-RPC over stdio) inside a short-lived auth container that mounts the
 * ONE canonical CODEX_HOME volume of the tenant. The phone opens the returned
 * auth URL in a browser and runs a loopback listener; the browser redirect
 * (code+state) is captured on the phone and forwarded back over the WSS as
 * `auth.callback`, which this module hands to the login server inside the
 * container. On `AccountLoginCompletedNotification` the flow reads the fresh
 * auth.json from the volume and stores an encrypted backup in the vault
 * (secret kind `codex_oauth`).
 *
 * Security (CODEX-OAUTH.md §2.4): the PKCE `code_verifier` never leaves the
 * container; `code`+`state` are single-use and travel over the already
 * device-authenticated WSS; the orchestrator validates nothing itself — the
 * codex login server checks the state. The transport is injected so the smoke
 * test drives the identical flow logic against a fake app-server + fake login
 * server, with no docker and no network.
 */
import type { AuthFlowType, ServerMessage } from '@pocketagent/protocol';
import type { CodexJsonRpc } from './codex-jsonrpc.js';
import { CodexRpcError } from './codex-jsonrpc.js';
import { saveSecretValue } from './secrets-api.js';
import type { Store } from './db.js';

/** codex login server default port (fallback 1457), CODEX-OAUTH.md §1. */
export const CODEX_LOOPBACK_PORT = 1455;
/** A login flow is valid for 15 minutes (device code TTL), then it is dropped. */
const AUTH_FLOW_TIMEOUT_MS = 15 * 60_000;

/**
 * A live `codex app-server` the auth flow drives. `forwardCallback` performs
 * the HTTP GET to the login server's loopback port *inside* the container;
 * `readAuthJson` returns the auth.json the token exchange wrote to CODEX_HOME.
 */
export interface CodexAppServerSession {
  readonly rpc: CodexJsonRpc;
  /** GET http://127.0.0.1:<port>/auth/callback?code&state; resolves with the HTTP status. */
  forwardCallback(port: number, code: string, state: string): Promise<number>;
  /** Contents of {CODEX_HOME}/auth.json, or null when it does not exist (yet). */
  readAuthJson(): Promise<string | null>;
  close(): Promise<void>;
}

/** Starts an auth container / app-server for a tenant and returns its session. */
export interface CodexAuthTransport {
  open(tenant: string): Promise<CodexAppServerSession>;
}

type SendFn = (m: ServerMessage) => void;

interface AuthFlowState {
  requestId: string;
  tenant: string;
  session: CodexAppServerSession;
  port: number;
  loginId?: string;
  account?: string;
  send: SendFn;
  settle(result: { ok: boolean; error?: string }): void;
  completed: Promise<{ ok: boolean; error?: string }>;
  timer: NodeJS.Timeout;
}

/* ------------------------------------------------------------------ */
/* Pure parsing helpers (unit-tested in smoke)                         */
/* ------------------------------------------------------------------ */

function rec(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** login_chatgpt result: tolerant of snake_case / camelCase field names. */
export function parseLoginResult(raw: unknown): { authUrl?: string; loginId?: string; userCode?: string } {
  const r = rec(raw);
  return {
    authUrl: str(r.auth_url) ?? str(r.authUrl) ?? str(r.url),
    loginId: str(r.login_id) ?? str(r.loginId) ?? str(r.id),
    userCode: str(r.user_code) ?? str(r.userCode),
  };
}

/**
 * The loopback port the phone must listen on: the port of the `redirect_uri`
 * baked into the auth URL (codex's redirect is http://localhost:<port>/auth/
 * callback). Falls back to CODEX_LOOPBACK_PORT when the URL cannot be parsed.
 */
export function parseCallbackPort(authUrl: string | undefined, fallback: number = CODEX_LOOPBACK_PORT): number {
  if (!authUrl) return fallback;
  try {
    const redirect = new URL(authUrl).searchParams.get('redirect_uri');
    if (redirect) {
      const port = new URL(redirect).port;
      if (port) return Number(port);
    }
  } catch {
    /* not a parseable URL: use the fallback */
  }
  return fallback;
}

/** Normalized notification-method match (AccountLoginCompletedNotification etc.). */
function normMethod(method: string): string {
  return method.toLowerCase().replace(/[_./-]/g, '');
}

export function isLoginCompleted(method: string): boolean {
  return normMethod(method).includes('accountlogincompleted');
}

export function isLoginError(method: string): boolean {
  const m = normMethod(method);
  return m.includes('accountloginerror') || m.includes('loginerror');
}

/**
 * A human account label from the completion notification, best effort:
 * "ChatGPT Plus, user@example.com" when both are present. Undefined when the
 * notification carries nothing recognizable (the app then just shows "connected").
 */
export function accountLabelFrom(rawParams: unknown): string | undefined {
  const p = rec(rawParams);
  const account = rec(p.account);
  const email = str(p.email) ?? str(account.email);
  const plan = str(p.plan) ?? str(account.plan) ?? str(p.planType) ?? str(account.planType);
  const id = str(p.account_id) ?? str(p.accountId) ?? str(account.id) ?? str(account.accountId);
  const parts: string[] = [];
  if (plan) parts.push(plan);
  if (email) parts.push(email);
  else if (id) parts.push(id);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/* ------------------------------------------------------------------ */
/* Auth manager                                                        */
/* ------------------------------------------------------------------ */

export class CodexAuthManager {
  private readonly flows = new Map<string, AuthFlowState>();

  constructor(
    private readonly store: Store,
    private readonly transport: CodexAuthTransport,
    private readonly tenant = 'default',
  ) {}

  get inflight(): number {
    return this.flows.size;
  }

  /**
   * Begin an auth flow. Only codex supports an in-app login today; other
   * adapters get a plain `auth.done` error so the app can fall back. `flow`
   * selects oauth-loopback (default) vs device-code; a device-code that the
   * account is not enabled for falls back to oauth-loopback, mirroring codex's
   * own `run_login_with_device_code_fallback_to_browser`.
   */
  async start(requestId: string, adapter: string, flow: AuthFlowType | undefined, send: SendFn): Promise<void> {
    if (this.flows.has(requestId)) {
      send({ type: 'auth.done', requestId, ok: false, error: 'auth flow already running for this request' });
      return;
    }
    if (adapter !== 'codex') {
      send({ type: 'auth.done', requestId, ok: false, error: `adapter "${adapter}" hat keinen In-App-Login` });
      return;
    }
    let session: CodexAppServerSession;
    try {
      session = await this.transport.open(this.tenant);
    } catch (e) {
      send({ type: 'auth.done', requestId, ok: false, error: `Auth-Container startete nicht: ${errText(e)}` });
      return;
    }

    let settleFn: (result: { ok: boolean; error?: string }) => void = () => {};
    const completed = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      settleFn = resolve;
    });
    const state: AuthFlowState = {
      requestId,
      tenant: this.tenant,
      session,
      port: CODEX_LOOPBACK_PORT,
      send,
      completed,
      settle: (result) => settleFn(result),
      timer: setTimeout(() => settleFn({ ok: false, error: 'Login-Zeitfenster (15 min) abgelaufen' }), AUTH_FLOW_TIMEOUT_MS),
    };
    state.timer.unref?.();
    this.flows.set(requestId, state);

    // The completion notification arrives asynchronously after the callback is
    // forwarded and the token exchange runs; a login error notification ends it early.
    session.rpc.onNotification((method, params) => {
      if (isLoginCompleted(method)) {
        state.account = accountLabelFrom(params);
        state.settle({ ok: true });
      } else if (isLoginError(method)) {
        state.settle({ ok: false, error: str(rec(params).message) ?? 'Login fehlgeschlagen' });
      }
    });

    try {
      const login = await this.callLogin(session, flow);
      state.loginId = login.loginId;
      state.port = parseCallbackPort(login.authUrl, CODEX_LOOPBACK_PORT);
      if (!login.authUrl) throw new Error('codex login lieferte keine auth_url');
      const isDevice = flow === 'device-code' && !login.fellBackToBrowser;
      send({
        type: 'auth.url',
        requestId,
        url: login.authUrl,
        // device-code has no loopback listener: port 0 tells the app not to bind one.
        port: isDevice ? 0 : state.port,
        ...(login.usedFlow ? { flow: login.usedFlow } : {}),
        ...(login.userCode ? { userCode: login.userCode } : {}),
      });
    } catch (e) {
      state.settle({ ok: false, error: `Login-Start fehlgeschlagen: ${errText(e)}` });
    }

    // Drive the flow to its terminal state in the background: the app sends
    // auth.callback (or auth.cancel) in the meantime, both matched by requestId.
    void this.finish(state);
  }

  /** Forward a captured loopback callback to the login server in the container. */
  async callback(requestId: string, code: string, state: string): Promise<void> {
    const flow = this.flows.get(requestId);
    if (!flow) return; // unknown/expired flow: nothing to forward
    try {
      const status = await flow.session.forwardCallback(flow.port, code, state);
      if (status >= 400) {
        flow.settle({ ok: false, error: `Login-Server lehnte den Callback ab (HTTP ${status})` });
      }
    } catch (e) {
      flow.settle({ ok: false, error: `Callback konnte nicht zugestellt werden: ${errText(e)}` });
    }
  }

  /** App aborted the flow: best-effort cancel + teardown, then a failed auth.done. */
  cancel(requestId: string): void {
    const flow = this.flows.get(requestId);
    if (!flow) return;
    try {
      flow.session.rpc.notify('cancel_login_account', flow.loginId ? { loginId: flow.loginId } : {});
    } catch {
      /* best effort */
    }
    flow.settle({ ok: false, error: 'abgebrochen' });
  }

  /** Cancel every flow that belongs to a socket that just closed. */
  cancelAll(predicate: (requestId: string) => boolean): void {
    for (const id of [...this.flows.keys()]) if (predicate(id)) this.cancel(id);
  }

  private async callLogin(
    session: CodexAppServerSession,
    flow: AuthFlowType | undefined,
  ): Promise<{ authUrl?: string; loginId?: string; userCode?: string; usedFlow?: AuthFlowType; fellBackToBrowser?: boolean }> {
    if (flow === 'device-code') {
      try {
        const res = parseLoginResult(await session.rpc.request('login_chatgpt_device_code', {}));
        return { ...res, usedFlow: 'device-code' };
      } catch (e) {
        // 404 / "not enabled" => the account has no device flow; fall back to the
        // browser loopback exactly like codex's own fallback does.
        if (!isDeviceCodeUnavailable(e)) throw e;
      }
    }
    const res = parseLoginResult(await session.rpc.request('login_chatgpt', {}));
    return { ...res, usedFlow: 'oauth-loopback', fellBackToBrowser: flow === 'device-code' };
  }

  /** Await the terminal result, back up auth.json on success, emit auth.done, tear down. */
  private async finish(state: AuthFlowState): Promise<void> {
    const result = await state.completed;
    clearTimeout(state.timer);
    this.flows.delete(state.requestId);

    if (result.ok) {
      try {
        const authJson = await state.session.readAuthJson();
        if (authJson && authJson.trim().length > 0) {
          // Encrypted vault backup (CODEX-OAUTH.md §4). The canonical copy stays
          // in the CODEX_HOME volume; this only guards against a volume loss.
          saveSecretValue(this.store, state.tenant, 'codex_oauth', authJson);
        } else {
          console.warn('[codex-auth] login completed but auth.json was empty/missing; no vault backup written');
        }
      } catch (e) {
        console.warn(`[codex-auth] reading/backing up auth.json failed: ${errText(e)}`);
      }
      state.send({
        type: 'auth.done',
        requestId: state.requestId,
        ok: true,
        ...(state.account ? { account: state.account } : {}),
      });
    } else {
      state.send({ type: 'auth.done', requestId: state.requestId, ok: false, ...(result.error ? { error: result.error } : {}) });
    }
    await state.session.close().catch((e) => console.warn(`[codex-auth] closing auth session failed: ${errText(e)}`));
  }
}

/** A device-code method the account is not enabled for: 404 or "not enabled". */
function isDeviceCodeUnavailable(e: unknown): boolean {
  if (e instanceof CodexRpcError) {
    if (e.code === 404 || e.code === -32601) return true;
    return /not enabled|unavailable|unsupported|404/i.test(e.message);
  }
  return e instanceof Error && /not enabled|unavailable|unsupported|404/i.test(e.message);
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
