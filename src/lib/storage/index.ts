import { scryptSync } from 'node:crypto';
import { env } from '../../config/env';
import { createLocalStorage, type LocalStorage } from './local-storage';
import { createR2Storage } from './r2-storage';
import type { ObjectStorage } from './storage.types';

export type { ObjectStorage, SignedRequest, StoredObject } from './storage.types';

function build(): ObjectStorage {
  if (env.STORAGE_DRIVER === 'r2') {
    return createR2Storage({
      endpoint: env.R2_ENDPOINT ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      bucket: env.R2_BUCKET!,
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      region: env.R2_REGION,
    });
  }
  // Grants are signed with a key derived from JWT_ACCESS_SECRET rather than a second required secret.
  return createLocalStorage({ root: env.LOCAL_STORAGE_DIR, secret: scryptSync(env.JWT_ACCESS_SECRET, 'timeflow.local-storage.v1', 32) });
}

/** The configured object storage (R2 in production, a private local directory in development). */
export const storage: ObjectStorage = build();

/** The local driver, when it is the active one: its signed-URL endpoint is mounted only then. */
export const localStorage: LocalStorage | null = storage.driver === 'local' ? (storage as LocalStorage) : null;
