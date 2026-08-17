/**
 * Unit test for resolveWsUrl(): the link agent must never downgrade an
 * explicit wss:// to plaintext ws:// (that would send PA_TOKEN and all
 * session traffic unencrypted). See APP-REVIEW.md, "Link-Agent: wsUrl()
 * stuft explizites wss:// auf unverschluesseltes ws:// herunter".
 *
 * Run: npm run test -w link   (from repo root)
 */
import { resolveWsUrl } from '../src/ws-url.js';

function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

function checkPathAndUrl(input: string, expectedPrefix: string, what: string): void {
  const out = resolveWsUrl(input);
  expect(out.startsWith(expectedPrefix), `${what}: expected prefix ${expectedPrefix}, got ${out}`);
  expect(new URL(out).pathname === '/ws', `${what}: expected pathname /ws, got ${new URL(out).pathname}`);
}

// Explicit wss:// must stay encrypted - the original bug downgraded this to ws://.
checkPathAndUrl('wss://orch.example.com', 'wss://orch.example.com', 'explicit wss:// preserved');

// Explicit ws:// (e.g. localhost dev) must stay plaintext, not get "upgraded".
checkPathAndUrl('ws://127.0.0.1:8080', 'ws://127.0.0.1:8080', 'explicit ws:// preserved');

// https:// shorthand maps to wss://.
checkPathAndUrl('https://orch.example.com', 'wss://orch.example.com', 'https:// maps to wss://');

// http:// shorthand maps to ws://.
checkPathAndUrl('http://127.0.0.1:8080', 'ws://127.0.0.1:8080', 'http:// maps to ws://');

// Existing path/query on the input is replaced with /ws, not appended.
{
  const out = resolveWsUrl('wss://orch.example.com/some/path?x=1');
  const u = new URL(out);
  expect(u.pathname === '/ws', `path replaced with /ws, got ${u.pathname}`);
  expect(u.protocol === 'wss:', `protocol stays wss:, got ${u.protocol}`);
}

console.log('WS-URL TEST OK');
