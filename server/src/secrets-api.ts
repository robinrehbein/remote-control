/**
 * REST counterpart to the WS `secret.set` handler in ws.ts (not modified here).
 *
 * Lets a laptop/CI push a provider secret straight into the vault without a
 * paired device in the loop - e.g. `pocketagent-secret` (see cli/). Reuses
 * the exact same underlying primitives the WS handler uses (vault.encrypt +
 * store.saveSecret/getSecret), so both paths stay byte-for-byte identical in
 * how a secret ends up on disk.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { encrypt } from './vault.js';
import { adminTokenOk } from './pairing.js';
import type { Store } from './db.js';

const KIND_RE = /^[a-z0-9_-]{1,64}$/;

export function isValidSecretKind(kind: unknown): kind is string {
  return typeof kind === 'string' && KIND_RE.test(kind);
}

export interface SavedSecretSummary {
  id: string;
  kind: string;
  createdAt: string;
}

/**
 * Same codepath as the ws.ts `secret.set` case: encrypt(), store.saveSecret(),
 * re-read via store.getSecret() to return the DB-assigned createdAt.
 */
export function saveSecretValue(
  store: Store,
  tenant: string,
  kind: string,
  value: string,
): SavedSecretSummary | null {
  const id = randomUUID();
  const { ciphertext, nonce } = encrypt(value);
  store.saveSecret(id, tenant, kind, ciphertext, nonce);
  const saved = store.getSecret(id);
  if (!saved) return null;
  return { id: saved.id, kind: saved.kind, createdAt: saved.created_at };
}

export function registerSecretsApi(app: FastifyInstance, store: Store): void {
  app.post('/api/secrets', async (req, reply) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!adminTokenOk(token)) return reply.code(401).send({ ok: false, error: 'unauthorized' });

    const body = req.body as { kind?: unknown; value?: unknown } | undefined;
    const kind = body?.kind;
    const value = body?.value;
    if (!isValidSecretKind(kind)) {
      return reply
        .code(400)
        .send({ ok: false, error: 'invalid kind (expected lowercase [a-z0-9_-]{1,64})' });
    }
    if (typeof value !== 'string' || value.length === 0) {
      return reply.code(400).send({ ok: false, error: 'value must be a non-empty string' });
    }

    const saved = saveSecretValue(store, 'default', kind, value);
    if (!saved) return reply.code(500).send({ ok: false, error: 'failed to save secret' });
    return { ok: true, secret: saved };
  });
}
