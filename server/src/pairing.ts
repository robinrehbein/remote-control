import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PairingConfirmBody, PairingConfirmResponse } from '@pocketagent/protocol';
import { sha256, type Store } from './db.js';

const CODE_TTL_MS = 10 * 60_000;

export function generatePairingCode(store: Store, tenant = 'default', ttlMs = CODE_TTL_MS): string {
  // 12 hex chars (48 bits of entropy) - brute-force is additionally bounded by
  // the 5-attempt lockout and the per-IP/global pairing rate limits.
  const code = randomBytes(6).toString('hex');
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
  // Codes are lowercase hex; normalize (e.g. Android keyboards may uppercase input).
  if (!store.consumePairingCode(body.code.trim().toLowerCase(), new Date().toISOString())) return null;
  const deviceId = randomUUID();
  const deviceToken = randomBytes(48).toString('hex');
  store.createDevice(deviceId, tenant, body.deviceName, sha256(deviceToken));
  return { ok: true, deviceId, deviceToken };
}

/** Hard cap on tracked keys so a spoofed-source flood cannot grow the map unbounded. */
const MAX_KEYS = 10_000;

/**
 * In-memory sliding-window rate limiter. One instance per bucket dimension
 * (per-IP, global); timestamps are pruned periodically and on insert.
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {
    this.timer = setInterval(() => this.prune(), Math.min(windowMs, 60_000));
    this.timer.unref();
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, times] of this.hits) {
      const live = times.filter((t) => t > cutoff);
      if (live.length === 0) this.hits.delete(key);
      else if (live.length !== times.length) this.hits.set(key, live);
    }
  }

  private enforceCap(): void {
    this.prune();
    while (this.hits.size >= MAX_KEYS) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }

  allow(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const live = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (live.length >= this.max) {
      this.hits.set(key, live);
      return false;
    }
    live.push(now);
    if (this.hits.size >= MAX_KEYS) this.enforceCap();
    this.hits.set(key, live);
    return true;
  }

  dispose(): void {
    clearInterval(this.timer);
    this.hits.clear();
  }
}
