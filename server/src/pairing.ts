import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PairingConfirmBody, PairingConfirmResponse } from '@pocketagent/protocol';
import { sha256, type Store } from './db.js';

const CODE_TTL_MS = 10 * 60_000;

export function generatePairingCode(store: Store, tenant = 'default', ttlMs = CODE_TTL_MS): string {
  const code = randomBytes(4).toString('hex');
  store.createPairingCode(code, tenant, new Date(Date.now() + ttlMs).toISOString());
  return code;
}

/** Constant-time check of the admin token (env PAIRING_ADMIN_TOKEN); enables remote pairing-code creation when set. */
export function adminTokenOk(token: string | undefined): boolean {
  const expected = process.env.PAIRING_ADMIN_TOKEN;
  if (!expected || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function confirmPairing(
  store: Store,
  body: PairingConfirmBody,
  tenant = 'default',
): PairingConfirmResponse | null {
  if (!body.code || !body.deviceName) return null;
  if (!store.consumePairingCode(body.code)) return null;
  const deviceId = randomUUID();
  const deviceToken = randomBytes(48).toString('hex');
  store.createDevice(deviceId, tenant, body.deviceName, sha256(deviceToken));
  return { ok: true, deviceId, deviceToken };
}
