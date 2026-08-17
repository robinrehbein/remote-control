/**
 * Normalizes a configured orchestrator URL into the outbound WebSocket URL.
 *
 * Only maps the http(s) shorthand onto the matching ws(s) scheme; an
 * explicit `ws://` or `wss://` is left exactly as given. Downgrading an
 * explicit `wss://` to `ws://` would silently send PA_TOKEN and all session
 * traffic in cleartext, so this must never happen (see APP-REVIEW.md,
 * "Link-Agent: wsUrl() stuft explizites wss:// auf unverschluesseltes ws://
 * herunter").
 */
export function resolveWsUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol === 'http:') u.protocol = 'ws:';
  u.pathname = '/ws';
  return u.toString();
}
