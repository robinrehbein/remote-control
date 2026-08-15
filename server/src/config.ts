import { existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

export const SERVER_VERSION = '0.1.0';

function loadMasterKey(): Buffer {
  const raw = process.env.MASTER_KEY?.trim();
  if (raw) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === 32) return b64;
    return createHash('sha256').update(raw).digest();
  }
  console.warn('[config] MASTER_KEY not set - using ephemeral key, secrets will not survive restarts');
  return randomBytes(32);
}

function loadDockerEnabled(): boolean {
  const raw = process.env.DOCKER_ENABLED;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return existsSync('/var/run/docker.sock');
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dataDir: resolve(process.env.DATA_DIR ?? './data'),
  masterKey: loadMasterKey(),
  dockerEnabled: loadDockerEnabled(),
  networkName: process.env.NETWORK_NAME ?? 'pocketagent',
  sessionMemLimit: process.env.SESSION_MEM_LIMIT ?? '2g',
  idleStopSec: Number(process.env.IDLE_STOP_SEC ?? 900),
  gcDays: Number(process.env.GC_DAYS ?? 14),
  adapterImagePrefix: process.env.ADAPTER_IMAGE_PREFIX ?? 'pocketagent',
} as const;
