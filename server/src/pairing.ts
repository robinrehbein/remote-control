import { randomBytes, randomUUID } from 'node:crypto';
import type { PairingConfirmBody, PairingConfirmResponse } from '@pocketagent/protocol';
import { sha256, type Store } from './db.js';

const CODE_TTL_MS = 10 * 60_000;

export function generatePairingCode(store: Store, tenant = 'default', ttlMs = CODE_TTL_MS): string {
  const code = randomBytes(4).toString('hex');
  store.createPairingCode(code, tenant, new Date(Date.now() + ttlMs).toISOString());
  return code;
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
