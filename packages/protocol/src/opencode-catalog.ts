/**
 * Shared opencode-wire helpers (used by the `opencode` and `kilo` shims).
 *
 * The rest of this package is pure types; this file is the one deliberate
 * exception: kilo is an OpenCode fork, so both shims speak the exact same
 * `/config/providers` catalog format and the same `provider/model` id form.
 * The logic below is pure, synchronous and dependency-free (no node builtins,
 * no imports beyond the protocol's own types), so it stays as portable as the
 * type declarations next to it instead of being copy-pasted per shim.
 */
import type { ModelInfo } from './index.js';

/**
 * Flatten opencode's `GET /config/providers` catalog into `provider/model` ids
 * (the form POST /session/:id/prompt accepts as {providerID, modelID}).
 * Shape: { providers: [{ id, name, models: { <modelID>: { id?, name? } } }] };
 * anything unexpected yields an empty catalog instead of an error.
 */
export function parseProviderCatalog(raw: unknown): ModelInfo[] {
  const providers = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { providers?: unknown }).providers)
      ? ((raw as { providers: unknown[] }).providers)
      : [];
  const out: ModelInfo[] = [];
  for (const entry of providers) {
    if (typeof entry !== 'object' || entry === null) continue;
    const p = entry as { id?: unknown; name?: unknown; models?: unknown };
    const providerId = typeof p.id === 'string' ? p.id : undefined;
    if (providerId === undefined) continue;
    const providerName = typeof p.name === 'string' ? p.name : providerId;
    const models = p.models;
    const list: Array<[string, { name?: unknown } | null]> = Array.isArray(models)
      ? models.map((m) => {
          const rec = typeof m === 'object' && m !== null ? (m as { id?: unknown; name?: unknown }) : null;
          return [typeof rec?.id === 'string' ? rec.id : '', rec] as [string, { name?: unknown } | null];
        })
      : typeof models === 'object' && models !== null
        ? Object.entries(models as Record<string, unknown>).map(([key, value]) => {
            const rec = typeof value === 'object' && value !== null ? (value as { id?: unknown; name?: unknown }) : null;
            const id = typeof rec?.id === 'string' ? rec.id : key;
            return [id, rec] as [string, { name?: unknown } | null];
          })
        : [];
    for (const [modelId, rec] of list) {
      if (modelId.length === 0) continue;
      const modelName = typeof rec?.name === 'string' ? rec.name : modelId;
      out.push({ id: `${providerId}/${modelId}`, name: `${providerName} · ${modelName}` });
    }
  }
  return out;
}

/**
 * Model selection for one prompt. opencode addresses models as
 * {providerID, modelID}, so `model` may carry the `provider/model` form the
 * shim's GET /models returns; an empty string falls back to the runtime's own
 * default (the documented "adapter default" reset).
 */
export function selectModel(
  current: { provider?: string; model?: string },
  body: { provider?: unknown; model?: unknown },
): { provider?: string; model?: string } {
  const next = { ...current };
  if (typeof body.provider === 'string' && body.provider.length > 0) next.provider = body.provider;
  if (typeof body.model !== 'string') return next;
  const raw = body.model.trim();
  if (raw.length === 0) {
    // explicit reset: let the runtime pick its configured default again
    next.model = undefined;
    return next;
  }
  const slash = raw.indexOf('/');
  if (slash > 0) {
    next.provider = raw.slice(0, slash);
    next.model = raw.slice(slash + 1);
  } else {
    next.model = raw;
  }
  return next;
}
