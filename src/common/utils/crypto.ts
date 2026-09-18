import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { env } from '../../config/env';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

/** Stable hash of a JSON-serialisable value (object keys sorted) for cache keys. */
export function stableHash(value: unknown): string {
  return createHash('sha1').update(stableStringify(value)).digest('hex').slice(0, 20);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

// ── Secrets at rest ─────────────────────────────────────────
// SMTP credentials entered in the UI must not sit in the database in plain
// text. AES-256-GCM so tampering is detected, not just hidden.

const ENCRYPTION_PREFIX = 'v1';

/**
 * Derived from JWT_ACCESS_SECRET rather than a second required secret.
 * Rotating that secret therefore invalidates stored SMTP credentials — they
 * simply have to be re-entered, which is the safe failure.
 */
let cachedKey: Buffer | null = null;
function encryptionKey(): Buffer {
  cachedKey ??= scryptSync(env.JWT_ACCESS_SECRET, 'timeflow.secret-at-rest.v1', 32);
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [ENCRYPTION_PREFIX, iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

/** Returns null for anything unreadable — a wrong key must not crash the worker. */
export function decryptSecret(payload: string): string | null {
  try {
    const [version, iv, tag, data] = payload.split(':');
    if (version !== ENCRYPTION_PREFIX || !iv || !tag || !data) return null;
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
