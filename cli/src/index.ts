#!/usr/bin/env node
/**
 * pocketagent-secret - push a provider secret from your laptop straight into
 * the PocketAgent server vault (POST /api/secrets), no typing on the phone.
 *
 * Runs on plain Node 22.18+ (native TypeScript execution, no build step, no
 * dependencies beyond Node builtins - `fetch` is global in Node 22).
 *
 * Usage:
 *   pocketagent-secret <kind> [value] [--url URL] [--token TOKEN] [--insecure-http]
 *
 *   POCKETAGENT_URL=https://orch.example.com POCKETAGENT_ADMIN_TOKEN=... \
 *     pocketagent-secret openai sk-...
 *
 *   echo sk-... | pocketagent-secret openai            # value via stdin (piped)
 *   cat kilo-auth.json | pocketagent-secret kilo        # file contents via stdin
 *   pocketagent-secret openai                           # hidden TTY prompt
 *   pocketagent-secret claude                            # runs `claude setup-token`
 *
 * Exit codes: 0 = ok, 1 = usage/network/server error.
 */
import { spawn } from 'node:child_process';

const KIND_RE = /^[a-z0-9_-]{1,64}$/;

class CliError extends Error {}

interface ParsedArgs {
  kind: string;
  value: string | undefined;
  url: string;
  token: string;
  insecureHttp: boolean;
}

function printUsage(): void {
  console.error(
    [
      'Verwendung: pocketagent-secret <kind> [value] [--url URL] [--token TOKEN] [--insecure-http]',
      '',
      'Env (alternativ zu den Flags): POCKETAGENT_URL, POCKETAGENT_ADMIN_TOKEN',
      '',
      'Beispiele:',
      '  pocketagent-secret claude                    # führt `claude setup-token` aus, speichert als claude_oauth',
      '  echo sk-... | pocketagent-secret openai       # Wert per stdin (pipe)',
      '  cat auth.json | pocketagent-secret kilo       # Datei-Inhalt per stdin',
      '  pocketagent-secret openai                     # interaktiver, versteckter Prompt (TTY)',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  let url = process.env.POCKETAGENT_URL ?? '';
  let token = process.env.POCKETAGENT_ADMIN_TOKEN ?? '';
  let insecureHttp = false;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--insecure-http') {
      insecureHttp = true;
    } else if (a === '--url') {
      url = argv[++i] ?? '';
    } else if (a.startsWith('--url=')) {
      url = a.slice('--url='.length);
    } else if (a === '--token') {
      token = argv[++i] ?? '';
    } else if (a.startsWith('--token=')) {
      token = a.slice('--token='.length);
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      positionals.push(a);
    }
  }

  const [kind, value] = positionals;
  if (!kind) {
    printUsage();
    throw new CliError('kind fehlt (z.B. "openai", "kilo", "claude").');
  }
  if (!KIND_RE.test(kind)) {
    throw new CliError(
      `ungültiger kind "${kind}" - erlaubt: lowercase Buchstaben/Ziffern/-/_ (1-64 Zeichen).`,
    );
  }
  if (!url) throw new CliError('Server-URL fehlt (POCKETAGENT_URL oder --url).');
  if (!token) throw new CliError('Admin-Token fehlt (POCKETAGENT_ADMIN_TOKEN oder --token).');

  return { kind, value, url, token, insecureHttp };
}

/** https:// always allowed; http:// only to localhost, or explicitly with --insecure-http. */
function checkUrl(rawUrl: string, insecureHttp: boolean): URL {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new CliError(`ungültige URL "${rawUrl}".`);
  }
  if (u.protocol === 'https:') return u;
  if (u.protocol !== 'http:') {
    throw new CliError(`nicht unterstütztes URL-Schema "${u.protocol}" - erwartet http(s)://`);
  }
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  if (isLocal) return u;
  if (insecureHttp) {
    console.warn(
      `WARNUNG: unverschlüsseltes http:// zu "${u.hostname}" - Token und Secret-Wert gehen im Klartext über die Leitung.`,
    );
    return u;
  }
  throw new CliError(
    `http:// zu "${u.hostname}" ist nicht erlaubt (Secrets würden im Klartext übertragen). Nutze https://, oder erzwinge es explizit mit --insecure-http.`,
  );
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Hidden-echo prompt for interactive TTY use (no readline, no dependency on its private API). */
function readHiddenTTY(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      reject(new CliError('stdin ist kein TTY und es wurde kein Wert übergeben.'));
      return;
    }
    process.stdout.write(promptText);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let input = '';

    const cleanup = (): void => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r') {
          cleanup();
          process.stdout.write('\n');
          resolve(input);
          return;
        } else if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        } else if (ch === '\u007f' || ch === '\b') {
          input = input.slice(0, -1);
        } else {
          input += ch;
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

async function resolveValue(explicitValue: string | undefined): Promise<string> {
  if (explicitValue !== undefined) return explicitValue;
  if (process.stdin.isTTY) {
    return readHiddenTTY('Wert für Secret (Eingabe wird nicht angezeigt): ');
  }
  return (await readAllStdin()).trim();
}

/**
 * Fish the OAuth token out of `claude setup-token` stdout.
 *
 * "last non-empty line" is not good enough: the CLI may print a footer/hint
 * after the token, and storing that in the vault would silently break every
 * claude session. So the output is scanned for an actual token instead:
 * `sk-ant-...` first, otherwise exactly one long whitespace-free line.
 * Anything ambiguous returns undefined so the caller can abort loudly.
 */
export function extractClaudeToken(stdout: string): string | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const tokens = lines.filter((l) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(l));
  if (tokens.length > 0) return tokens[tokens.length - 1];
  // fallback for token formats we do not know: a single long line without any
  // whitespace looks like a credential, several of them are too ambiguous
  const candidates = lines.filter((l) => l.length > 40 && !/\s/.test(l));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Runs `claude setup-token` inheriting stdin/stderr (interactive OAuth login) while
 * still capturing stdout to fish the token out - true `stdio: 'inherit'` would forward
 * stdout straight to the terminal with no way for us to read it back. */
async function runClaudeSetupToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['setup-token'], { stdio: ['inherit', 'pipe', 'inherit'] });
    let captured = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      captured += chunk.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new CliError(
            '`claude` CLI wurde nicht gefunden. Installieren mit `npm install -g @anthropic-ai/claude-code` (oder ' +
              'sicherstellen, dass sie im PATH liegt) und erneut versuchen.',
          ),
        );
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new CliError(`\`claude setup-token\` wurde mit Exit-Code ${code} beendet.`));
        return;
      }
      const token = extractClaudeToken(captured);
      if (!token) {
        reject(
          new CliError(
            'Konnte keinen Token aus der Ausgabe von `claude setup-token` extrahieren ' +
              '(erwartet: eine Zeile "sk-ant-..."). Token bitte manuell übergeben: ' +
              '`pocketagent-secret claude_oauth <token>`.',
          ),
        );
        return;
      }
      resolve(token);
    });
  });
}

interface SecretSummary {
  id: string;
  kind: string;
  createdAt: string;
}

async function postSecret(url: URL, token: string, kind: string, value: string): Promise<SecretSummary> {
  const endpoint = new URL('/api/secrets', url).toString();
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind, value }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new CliError(`Verbindung zu ${endpoint} fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new CliError(`Server lehnte den Secret-Upload ab: ${msg}`);
  }
  if (!body || typeof body !== 'object' || !('secret' in body)) {
    throw new CliError('Unerwartete Serverantwort (kein "secret"-Feld).');
  }
  return (body as { secret: SecretSummary }).secret;
}

async function main(): Promise<void> {
  const { kind, value: explicitValue, url: rawUrl, token, insecureHttp } = parseArgs(process.argv.slice(2));
  const url = checkUrl(rawUrl, insecureHttp);

  let value: string;
  let effectiveKind = kind;
  if (kind === 'claude') {
    value = await runClaudeSetupToken();
    effectiveKind = 'claude_oauth';
  } else {
    value = await resolveValue(explicitValue);
  }
  if (!value) throw new CliError('kein Wert übergeben (leer).');

  const saved = await postSecret(url, token, effectiveKind, value);
  console.log(`✓ ${saved.kind} im Server-Vault hinterlegt (id ${saved.id})`);
}

main().catch((e) => {
  if (e instanceof CliError) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  console.error(`✗ Unerwarteter Fehler: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
