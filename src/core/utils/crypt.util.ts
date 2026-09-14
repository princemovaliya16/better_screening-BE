import * as bcrypt from 'bcrypt';
import { randomBytes, createHash, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import { getEnv } from '@config/env';

const SALT_ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function comparePassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Random URL-safe token, e.g. for invite/reset links and candidate access tokens. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** One-way hash of an opaque token before storing it (e.g. candidate interview access
 * tokens) — the raw token is only ever known to the recipient of the email link. */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

let cachedEncryptionKey: Buffer | undefined;
function encryptionKey(): Buffer {
  // Unlike hashToken (one-way, for values we never need back), OAuth refresh tokens
  // must be readable again to actually send mail — so this is reversible AES-256-GCM,
  // keyed off a server-only secret, rather than a hash.
  if (!cachedEncryptionKey) {
    cachedEncryptionKey = scryptSync(getEnv('TOKEN_ENCRYPTION_KEY'), 'better-screening-v1', 32);
  }
  return cachedEncryptionKey;
}

/** Encrypts a secret (e.g. a Gmail OAuth refresh token) for storage at rest. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/** Reverses {@link encryptSecret}. */
export function decryptSecret(encoded: string): string {
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
