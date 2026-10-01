import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { open, rm, stat as statFile } from 'node:fs/promises';
import path from 'node:path';
import type { ObjectStorage, SignedRequest } from './storage.types';

/**
 * Development / single-server stand-in for R2. Objects live in a private
 * directory that is NOT under the public /uploads mount; the browser reaches
 * them only through `/api/storage/<token>`, where the token is an HMAC-signed,
 * expiring grant for one operation on one key — the same contract as an R2
 * presigned URL, so the frontend cannot tell the drivers apart.
 */

export const LOCAL_STORAGE_ROUTE = '/api/storage';

export type LocalGrant = {
  /** Object key. */
  k: string;
  /** Operation. */
  m: 'PUT' | 'GET';
  /** Expiry, seconds since epoch. */
  e: number;
  /** PUT: required Content-Type. GET: Content-Type to serve. */
  t?: string;
  /** PUT: maximum body size in bytes. */
  x?: number;
  /** GET: serve as an attachment with this file name. */
  d?: string;
};

export type LocalStorage = ObjectStorage & {
  readonly root: string;
  verifyGrant(token: string): LocalGrant | null;
  /** Absolute path for a key, refusing anything that would escape the root. */
  pathFor(key: string): string;
};

const KEY_PATTERN = /^[a-z0-9][a-z0-9/_.-]{0,254}$/i;

export function createLocalStorage({ root, secret }: { root: string; secret: Buffer }): LocalStorage {
  const absoluteRoot = path.resolve(root);
  mkdirSync(absoluteRoot, { recursive: true });

  const mac = (payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');

  const issue = (grant: LocalGrant) => {
    const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
    return `${LOCAL_STORAGE_ROUTE}/${payload}.${mac(payload)}`;
  };

  function pathFor(key: string): string {
    if (!KEY_PATTERN.test(key) || key.split('/').some((s) => s === '..' || s === '.' || s === '')) throw new Error('Invalid storage key');
    const resolved = path.resolve(absoluteRoot, key);
    if (!resolved.startsWith(absoluteRoot + path.sep)) throw new Error('Invalid storage key');
    return resolved;
  }

  return {
    driver: 'local',
    root: absoluteRoot,
    pathFor,

    verifyGrant(token) {
      const [payload, signature] = token.split('.');
      if (!payload || !signature) return null;
      const expected = Buffer.from(mac(payload));
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      try {
        const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as LocalGrant;
        if (typeof grant.k !== 'string' || (grant.m !== 'PUT' && grant.m !== 'GET') || typeof grant.e !== 'number') return null;
        if (grant.e * 1000 < Date.now()) return null;
        return grant;
      } catch {
        return null;
      }
    },

    async createUploadUrl(key, { contentType, maxBytes, expiresInSeconds }): Promise<SignedRequest> {
      pathFor(key);
      const e = Math.floor(Date.now() / 1000) + expiresInSeconds;
      return {
        url: issue({ k: key, m: 'PUT', e, t: contentType, x: maxBytes }),
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        expiresAt: new Date(e * 1000).toISOString(),
      };
    },

    async createDownloadUrl(key, { expiresInSeconds, contentType, downloadName }) {
      pathFor(key);
      return issue({ k: key, m: 'GET', e: Math.floor(Date.now() / 1000) + expiresInSeconds, t: contentType, d: downloadName });
    },

    async stat(key) {
      try {
        const s = await statFile(pathFor(key));
        return s.isFile() ? { size: s.size, contentType: null } : null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },

    async readStart(key, bytes) {
      const handle = await open(pathFor(key), 'r');
      try {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(bytes), 0, bytes, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },

    async remove(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}
