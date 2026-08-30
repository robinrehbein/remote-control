/**
 * REST counterpart to the WS `secret.set` handler in ws.ts (not modified here).
 *
 * Lets a laptop/CI push a provider secret straight into the vault without a
 * paired device in the loop - e.g. via a small helper like the v1
 * `pocketagent-secret` CLI (that CLI lives on in tag v0.13.0; this greenfield
 * tree ships only the REST/WS endpoint, not the client). Reuses
 * the exact same underlying primitives the WS handler uses (vault.encrypt +
 * store.saveSecret/getSecret) *and* the same AAD binding (`secret:<tenant>:
 * <kind>`, ws.ts:518), so both paths produce byte-for-byte the same shape of
 * row on disk - including the kind/tenant binding that stops a ciphertext
 * from being transplanted onto another kind's row without failing GCM
 * verification.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { SECRET_KINDS } from '@pocketagent/protocol';
import { encrypt } from './vault.js';
import { adminTokenOk, SlidingWindowRateLimiter } from './pairing.js';
import type { Store } from './db.js';

const KIND_RE = /^[a-z0-9_-]{1,64}$/;

/** Formprüfung: nur solche Arten dürfen in den AAD-String `secret:<tenant>:<kind>`. */
export function isValidSecretKind(kind: unknown): kind is string {
  return typeof kind === 'string' && KIND_RE.test(kind);
}

/**
 * Gehört die Art zum pi-Contract (`SECRET_KINDS` = pi-Provider + `github`)?
 * Getrennt von der Formprüfung, weil beide Aufrufer unterschiedliche Meldungen
 * geben - und weil eine Art, die kein Session-Env füllt, nur Verwirrung im
 * Secrets-Screen der App stiftet.
 */
export function isKnownSecretKind(kind: unknown): kind is string {
  return typeof kind === 'string' && SECRET_KINDS.includes(kind);
}

/**
 * /api/secrets is, like /api/pairing/*, an admin-token consumer: whoever
 * guesses PAIRING_ADMIN_TOKEN here gets write access to the vault, not just
 * pairing rights. Same sliding-window shape as index.ts's pairingRateLimit
 * (10 req/min/IP, 60 req/min globally) so the endpoint cannot be brute-forced
 * at wire speed.
 */
const secretsIpLimiter = new SlidingWindowRateLimiter(60_000, 10);
const secretsGlobalLimiter = new SlidingWindowRateLimiter(60_000, 60);

export interface SavedSecretSummary {
  id: string;
  kind: string;
  createdAt: string;
}

/**
 * Same codepath as the ws.ts `secret.set` case: encrypt() with the same AAD
 * (`secret:<tenant>:<kind>`, ws.ts:518), store.saveSecret(), re-read via
 * store.getSecret() to return the DB-assigned createdAt.
 */
export function saveSecretValue(
  store: Store,
  tenant: string,
  kind: string,
  value: string,
): SavedSecretSummary | null {
  const id = randomUUID();
  const { ciphertext, nonce } = encrypt(value, `secret:${tenant}:${kind}`);
  store.saveSecret(id, tenant, kind, ciphertext, nonce);
  const saved = store.getSecret(id);
  if (!saved) return null;
  return { id: saved.id, kind: saved.kind, createdAt: saved.created_at };
}

export function registerSecretsApi(app: FastifyInstance, store: Store): void {
  const rateLimit = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!secretsIpLimiter.allow(req.ip) || !secretsGlobalLimiter.allow('global')) {
      await reply.code(429).send({ ok: false, error: 'rate limited' });
    }
  };

  app.post('/api/secrets', { preHandler: rateLimit }, async (req, reply) => {
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
    if (!isKnownSecretKind(kind)) {
      return reply
        .code(400)
        .send({ ok: false, error: `unknown secret kind "${kind}" (expected one of ${SECRET_KINDS.join(', ')})` });
    }
    if (typeof value !== 'string' || value.length === 0) {
      return reply.code(400).send({ ok: false, error: 'value must be a non-empty string' });
    }

    const saved = saveSecretValue(store, 'default', kind, value);
    if (!saved) return reply.code(500).send({ ok: false, error: 'failed to save secret' });
    return { ok: true, secret: saved };
  });
}
