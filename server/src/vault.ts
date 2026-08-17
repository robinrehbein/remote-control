import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from './config.js';

export interface Encrypted {
  ciphertext: string;
  nonce: string;
}

/**
 * Startup hygiene: MASTER_KEY should be 32 raw bytes as 64 hex chars
 * (openssl rand -hex 32) or base64 decoding to 32 bytes. Anything else is
 * hashed from a passphrase and therefore weak. Read from process.env directly
 * (config.ts already normalized the key material by the time we check).
 */
export const masterKeyWeak: boolean = (() => {
  const raw = process.env.MASTER_KEY?.trim();
  if (!raw) return false; // unset => ephemeral key; config.ts warns about that case
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return false;
  if (Buffer.from(raw, 'base64').length === 32) return false;
  console.warn(
    '[vault] weak MASTER_KEY (hash-derived from passphrase); use openssl rand -hex 32',
  );
  return true;
})();

function crypt(value: string, aad: string | undefined): Encrypted {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.masterKey, nonce);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const buf = Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext: buf.toString('base64'), nonce: nonce.toString('base64') };
}

function cryptBack(enc: Encrypted, aad: string | undefined): string {
  const buf = Buffer.from(enc.ciphertext, 'base64');
  const tag = buf.subarray(buf.length - 16);
  const body = buf.subarray(0, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', config.masterKey, Buffer.from(enc.nonce, 'base64'));
  decipher.setAuthTag(tag);
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export function encrypt(value: string, aad?: string): Encrypted {
  return crypt(value, aad);
}

/** AES-256-GCM decrypt that throws when the ciphertext/AAD pair does not verify. */
export function decryptStrict(enc: Encrypted, aad?: string): string {
  return cryptBack(enc, aad);
}

/**
 * Decrypt with optional AAD. When `aad` is provided and verification fails,
 * retry once WITHOUT aad: rows written before AAD binding was introduced have
 * no AAD; returning normally lets the caller transparently re-encrypt them.
 *
 * Both writers of secret rows (ws.ts `secret.set` and secrets-api.ts
 * `saveSecretValue`) now always encrypt with AAD, so no *new* AAD-less row
 * can be created any more - this fallback exists only to heal rows that
 * predate that change (or were written directly against the DB). Do not
 * widen it into a general "AAD is optional" path; once every legacy row has
 * been touched once by Store.getSecretValue's transparent re-encrypt, it can
 * be removed.
 */
export function decrypt(enc: Encrypted, aad?: string): string {
  if (aad === undefined) return cryptBack(enc, undefined);
  try {
    return cryptBack(enc, aad);
  } catch {
    return cryptBack(enc, undefined);
  }
}
