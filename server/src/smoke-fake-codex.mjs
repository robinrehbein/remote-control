/**
 * Fake `codex app-server` + login server for the server-side auth.* smoke test
 * (CODEX-OAUTH.md). Speaks the same newline-delimited JSON-RPC over stdio the
 * real binary does AND hosts the loopback login HTTP server on 127.0.0.1, so
 * the orchestrator's CodexAuthManager + CodexJsonRpc + callback forwarding are
 * exercised end to end with no real codex binary, no container and no network.
 *
 * Flow:
 *  - initialize / initialized: handshake.
 *  - login_chatgpt: start an ephemeral 127.0.0.1 login server, answer with
 *    {login_id, auth_url} whose redirect_uri points at that port.
 *  - GET /auth/callback?code&state on the login server: writes auth.json to
 *    CODEX_HOME and emits AccountLoginCompletedNotification over stdio.
 *  - login_chatgpt_device_code: replies with a -32601 so the manager's
 *    device->browser fallback can be exercised on demand.
 *
 * Node builtins only. Set FAKE_DEVICE_CODE=unavailable to force the fallback.
 */
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CODEX_HOME = process.env.CODEX_HOME ?? process.cwd();
let buffer = '';
let loginServer = null;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handleLine(line);
    nl = buffer.indexOf('\n');
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}
function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function startLoginServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/auth/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code || !state) {
          res.writeHead(400).end('missing code/state');
          return;
        }
        // Token exchange happened here (PKCE verifier stayed in this process):
        // write the fresh auth.json to CODEX_HOME, then report completion.
        try {
          writeFileSync(
            join(CODEX_HOME, 'auth.json'),
            JSON.stringify({
              OPENAI_API_KEY: 'sk-fake-from-exchange',
              tokens: { access_token: 'at', refresh_token: 'rt', account_id: 'acc-123' },
              last_refresh: new Date().toISOString(),
            }),
            { mode: 0o600 },
          );
        } catch {
          /* ignore */
        }
        res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Erfolg</h1>');
        notify('AccountLoginCompletedNotification', {
          loginId: 'login-1',
          account: { email: 'smoke@openai.test', plan: 'ChatGPT Plus', accountId: 'acc-123' },
        });
        return;
      }
      res.writeHead(404).end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      loginServer = server;
      resolve(server.address().port);
    });
  });
}

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof msg.method !== 'string') return;
  switch (msg.method) {
    case 'initialize':
      respond(msg.id, { protocolVersion: '1', serverInfo: { name: 'fake-codex', version: '0.0.0' } });
      return;
    case 'initialized':
    case 'shutdown':
    case 'cancel_login_account':
      return;
    case 'login_chatgpt_device_code':
      if (process.env.FAKE_DEVICE_CODE === 'unavailable') {
        respondError(msg.id, -32601, 'device code login not enabled for this account');
        return;
      }
      respond(msg.id, {
        login_id: 'login-dev-1',
        auth_url: 'https://auth.openai.com/device',
        user_code: 'ABCD-1234',
      });
      return;
    case 'login_chatgpt': {
      const port = await startLoginServer();
      const redirect = encodeURIComponent(`http://127.0.0.1:${port}/auth/callback`);
      respond(msg.id, {
        login_id: 'login-1',
        auth_url: `https://auth.openai.com/authorize?client_id=app&redirect_uri=${redirect}&state=fake-state`,
      });
      return;
    }
    default:
      if (msg.id != null) respond(msg.id, {});
      return;
  }
}

process.on('SIGTERM', () => {
  loginServer?.close();
  process.exit(0);
});
