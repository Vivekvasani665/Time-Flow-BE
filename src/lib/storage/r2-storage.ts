import { AppError } from '../../common/errors';
import { presignUrl } from './sigv4';
import type { ObjectStorage, SignedRequest, StoredObject } from './storage.types';

export type R2Config = {
  /** e.g. https://<account-id>.r2.cloudflarestorage.com — any S3-compatible endpoint works. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 uses "auto"; S3 needs the bucket's real region. */
  region: string;
};

/** Server-side calls sign for a minute: they are made immediately. */
const SERVER_URL_TTL_SECONDS = 60;

/** `Content-Disposition` with an ASCII fallback and an RFC 5987 UTF-8 name. */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function createR2Storage(config: R2Config): ObjectStorage {
  const base = `${config.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(config.bucket)}`;
  const objectUrl = (key: string) => `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const sign = (method: 'GET' | 'PUT' | 'HEAD' | 'DELETE', key: string, expiresInSeconds: number, extra: Pick<Parameters<typeof presignUrl>[0], 'signedHeaders' | 'query'> = {}) =>
    presignUrl({
      method,
      url: objectUrl(key),
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expiresInSeconds,
      ...extra,
    });

  const unavailable = () => new AppError(502, 'STORAGE_UNAVAILABLE', 'File storage is unavailable. Please try again shortly.');

  async function call(method: 'HEAD' | 'GET' | 'DELETE', key: string, headers: Record<string, string> = {}): Promise<Response> {
    try {
      return await fetch(sign(method, key, SERVER_URL_TTL_SECONDS), { method, headers });
    } catch {
      throw unavailable();
    }
  }

  return {
    driver: 'r2',

    async createUploadUrl(key, { contentType, expiresInSeconds }): Promise<SignedRequest> {
      // Content-Type is signed, so the browser cannot store the object as some other type.
      // Size can't be bound to a presigned PUT; `complete` checks the stored size instead.
      const headers = { 'content-type': contentType };
      return {
        url: sign('PUT', key, expiresInSeconds, { signedHeaders: headers }),
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      };
    },

    async createDownloadUrl(key, { expiresInSeconds, contentType, downloadName }) {
      const query: Record<string, string> = {};
      if (contentType) query['response-content-type'] = contentType;
      if (downloadName) query['response-content-disposition'] = attachmentDisposition(downloadName);
      return sign('GET', key, expiresInSeconds, { query });
    },

    async stat(key): Promise<StoredObject | null> {
      const res = await call('HEAD', key);
      if (res.status === 404) return null;
      if (!res.ok) throw unavailable();
      return { size: Number(res.headers.get('content-length') ?? 0), contentType: res.headers.get('content-type') };
    },

    async readStart(key, bytes) {
      const res = await call('GET', key, { Range: `bytes=0-${bytes - 1}` });
      if (!res.ok) throw unavailable();
      return Buffer.from(await res.arrayBuffer()).subarray(0, bytes);
    },

    async remove(key) {
      const res = await call('DELETE', key);
      if (!res.ok && res.status !== 404) throw unavailable();
    },
  };
}
