import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from './config.js';

export interface Encrypted {
  ciphertext: string;
  nonce: string;
}

export function encrypt(value: string): Encrypted {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.masterKey, nonce);
  const buf = Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext: buf.toString('base64'), nonce: nonce.toString('base64') };
}

export function decrypt(enc: Encrypted): string {
  const buf = Buffer.from(enc.ciphertext, 'base64');
  const tag = buf.subarray(buf.length - 16);
  const body = buf.subarray(0, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', config.masterKey, Buffer.from(enc.nonce, 'base64'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
