/**
 * Provisioning-Fortschritt: alles hinter den `notice`-Events mit `phase`, die
 * einer startenden Session zeigen, was gerade passiert (Runner-Image-Bau,
 * Container-Start, Repo-Clone). Bewusst pur und docker-frei - die
 * Ableitungsregeln sind der Teil, der von der Smoke-Suite gedeckt bleiben muss,
 * die Daemon-Klempnerei liegt in docker.ts.
 */

/** Log lines read per poll while a session container boots (keep the poll cheap). */
export const LOG_TAIL_LINES = 20;
/** Mindestabstand zweier Bau-Meldungen (der Daemon sendet viele Zeilen/s). */
export const BUILD_NOTICE_INTERVAL_MS = 2_000;
/** Poll-Abstand des Container-Logs, während auf den Runner gewartet wird. */
export const SHIM_LOG_POLL_MS = 3_000;

const MAX_DETAIL_LINES = 6;
const MAX_DETAIL_CHARS = 600;

/** CSI escapes: build/runtime output is colored, the app renders plain text. */
const ANSI = /\[[0-9;?]*[ -\/]*[@-~]/g;

/**
 * Docker multiplexes non-TTY logs into 8-byte-framed chunks; strip the frames
 * so the payload stays readable when a stream carries both stdout and stderr.
 */
export function stripLogFraming(buf: Buffer): string {
  const out: string[] = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const type = buf[off] ?? 255;
    const len = buf.readUInt32BE(off + 4);
    // Frame headers always start with stream id 0-2; anything else means the
    // daemon sent a raw (TTY) stream, which is already plain text.
    if (type > 2 || len > buf.length - off - 8) return buf.toString('utf8').trim();
    out.push(buf.toString('utf8', off + 8, off + 8 + len));
    off += 8 + len;
  }
  return (off === 0 ? buf.toString('utf8') : out.join('')).trim();
}

/** Mask long token-shaped words (>=20 chars of key/token alphabet). */
export function redactTokens(text: string): string {
  return text.replace(/\b[A-Za-z0-9_-]{20,}\b/g, (m) => `${m.slice(0, 4)}…[gekürzt]`);
}

/** Log blob -> trimmed, escape-free, non-empty lines (oldest first). */
export function splitLogLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(ANSI, '').trim())
    .filter((l) => l.length > 0);
}

/**
 * Lines of `tail` that were not part of `prev` yet. Both are windows onto the
 * same append-only log, so the new part is whatever follows the longest suffix
 * of `prev` that `tail` still starts with; a window that scrolled past
 * everything counts as entirely new.
 */
export function newTailLines(prev: readonly string[], tail: readonly string[]): string[] {
  if (prev.length === 0) return [...tail];
  const max = Math.min(prev.length, tail.length);
  for (let k = max; k > 0; k--) {
    let same = true;
    for (let i = 0; i < k; i++) {
      if (prev[prev.length - k + i] !== tail[i]) {
        same = false;
        break;
      }
    }
    if (same) return tail.slice(k);
  }
  return [...tail];
}

/**
 * Log excerpt for a notice `detail`: the youngest lines last, token-masked and
 * hard-capped - this text is forwarded to the app and the server log.
 */
export function detailFrom(
  lines: readonly string[],
  maxLines = MAX_DETAIL_LINES,
  maxChars = MAX_DETAIL_CHARS,
): string {
  const kept = lines
    .slice(-maxLines)
    .map((l) => redactTokens(l.replace(ANSI, '').trim()))
    .filter((l) => l.length > 0);
  while (kept.join('\n').length > maxChars && kept.length > 1) kept.shift();
  const text = kept.join('\n');
  return text.length > maxChars ? `…${text.slice(text.length - maxChars + 1)}` : text;
}

export const BUILD_MESSAGE = 'Image wird gebaut';

/** `Step 7/14 : RUN ...` (classic builder) and `#9 [7/14] RUN ...` (buildkit). */
const BUILD_STEP = /(?:^|\s)Step\s+(\d+)\/(\d+)\b|\[\s*(\d+)\/(\d+)\s*\]/;

/** Build message from the build log so far; newest recognizable step wins. */
export function buildProgressMessage(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = BUILD_STEP.exec(lines[i] ?? '');
    if (m) return `${BUILD_MESSAGE} (Schritt ${m[1] ?? m[3]}/${m[2] ?? m[4]})`;
  }
  return BUILD_MESSAGE;
}

export const SHIM_START_MESSAGE = 'Agent-Container startet';

/** Markerzeilen, die der Runner beim Booten druckt (gitops/index). */
const SHIM_MARKERS: readonly { readonly re: RegExp; readonly message: string }[] = [
  { re: /\[git\]\s*cloning|cloning into|git clone/i, message: 'Repo wird geklont' },
  { re: /\[git\]\s*on branch|switched to (?:a new )?branch|git checkout/i, message: 'Branch wird vorbereitet' },
  { re: /npm (?:ci|install)|installing dependencies/i, message: 'Abhängigkeiten werden installiert' },
  { re: /listening on/i, message: 'Agent-Prozess läuft – Verbindung wird geprüft' },
];

/** Meldung zum jüngsten erkannten Marker; sonst die allgemeine. */
export function shimProgressMessage(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    const hit = SHIM_MARKERS.find((m) => m.re.test(line));
    if (hit) return hit.message;
  }
  return SHIM_START_MESSAGE;
}

/**
 * Rate limiter for progress notices: the first call passes, every following one
 * only after `intervalMs`. `now` is injectable so the throttling is testable.
 */
export function createThrottle(intervalMs: number): (now?: number) => boolean {
  let last: number | null = null;
  return (now = Date.now()) => {
    if (last !== null && now - last < intervalMs) return false;
    last = now;
    return true;
  };
}
