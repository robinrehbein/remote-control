/**
 * Live key validation for `secret.validate`.
 *
 * One cheap read-only request per provider — enough to tell "key works" from
 * "key rejected" without spending tokens. Rules:
 *  - the value is only ever used as a request credential; it is never logged,
 *    persisted or put into a result message,
 *  - kinds without a *known* endpoint answer `unverified` instead of guessing
 *    (a wrong URL would produce a false "key invalid"),
 *  - every request is capped by an 8 s AbortController timeout.
 */

/** Subset of `fetch` used here; injectable so smoke tests never hit the network. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface SecretValidation {
  ok: boolean;
  detail?: string;
  /** No live check exists for this kind — present neutrally, not as success. */
  unverified?: boolean;
}

export interface ValidateOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

const NO_CHECK_DETAIL = 'Keine Live-Prüfung verfügbar — gespeichert wird trotzdem';

interface Check {
  url: (value: string) => string;
  headers: (value: string) => Record<string, string>;
  /** Turns a 2xx body into a short German detail line. */
  detail: (body: unknown) => string;
}

/** `{ data: [...] }` — the OpenAI-compatible catalog shape. */
function countData(body: unknown): number | null {
  const data = (body as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data.length : null;
}

function modelsDetail(count: number | null): string {
  if (count === null) return 'Key gültig';
  return count === 1 ? '1 Modell verfügbar' : `${count} Modelle verfügbar`;
}

function bearer(value: string): Record<string, string> {
  return { authorization: `Bearer ${value}` };
}

const openAiStyle = (url: string): Check => ({
  url: () => url,
  headers: bearer,
  detail: (body) => modelsDetail(countData(body)),
});

/**
 * Nur belegte Endpunkte, und nur für die Arten aus `SECRET_KINDS` (pi-Provider
 * + github). `zai` fehlt bewusst: die öffentliche Z.AI-Basis ist
 * `https://api.z.ai/api/paas/v4/`, ein Modell-Listing-Pfad darunter ist aber
 * nicht bestätigt - ein 404 von einem geratenen Pfad läse sich als „Key kaputt".
 * Es fällt damit auf `unverified` zurück und wird trotzdem gespeichert.
 */
const CHECKS: Record<string, Check> = {
  openai: openAiStyle('https://api.openai.com/v1/models'),
  moonshot: openAiStyle('https://api.moonshot.ai/v1/models'),
  kimi: openAiStyle('https://api.moonshot.ai/v1/models'),
  anthropic: {
    url: () => 'https://api.anthropic.com/v1/models',
    headers: (value) => ({ 'x-api-key': value, 'anthropic-version': '2023-06-01' }),
    detail: (body) => modelsDetail(countData(body)),
  },
  google: {
    // Google takes the key as a query param, not a header.
    url: (value) => `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(value)}`,
    headers: () => ({}),
    detail: (body) => {
      const models = (body as { models?: unknown } | null)?.models;
      return modelsDetail(Array.isArray(models) ? models.length : null);
    },
  },
  github: {
    url: () => 'https://api.github.com/user',
    headers: (value) => ({
      authorization: `token ${value}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'pocketagent',
    }),
    detail: (body) => {
      const login = (body as { login?: unknown } | null)?.login;
      return typeof login === 'string' && login.length > 0 ? `Angemeldet als ${login}` : 'Token gültig';
    },
  },
};

/** Kinds this server can actually check — used by tests and docs. */
export function validatableKinds(): string[] {
  return Object.keys(CHECKS).sort();
}

export async function validateSecret(
  kind: string,
  value: string,
  options: ValidateOptions = {},
): Promise<SecretValidation> {
  if (value.trim().length === 0) return { ok: false, detail: 'Kein Wert angegeben' };

  const check = CHECKS[kind];
  if (!check) return { ok: true, detail: NO_CHECK_DETAIL, unverified: true };

  const doFetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await doFetch(check.url(value), {
      method: 'GET',
      headers: check.headers(value),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: 'Key ungültig oder abgelaufen' };
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, detail: `Provider antwortet mit HTTP ${res.status}` };
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: true, detail: check.detail(body) };
  } catch (e) {
    if (controller.signal.aborted) {
      return { ok: false, detail: `Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)} s` };
    }
    // Never surface the raw error: it can contain the request URL (and with
    // it the Google API key).
    void e;
    return { ok: false, detail: 'Server erreicht Provider nicht' };
  } finally {
    clearTimeout(timer);
  }
}
