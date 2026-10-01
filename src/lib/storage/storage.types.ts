/** A signed request the browser makes directly against storage. */
export type SignedRequest = {
  url: string;
  method: 'PUT' | 'GET';
  /** Headers the browser must send exactly as given, or the signature fails. */
  headers: Record<string, string>;
  expiresAt: string;
};

export type StoredObject = { size: number; contentType: string | null };

/**
 * Private object storage. Buckets are never public: every read and write goes
 * through a short-lived signed URL, so a leaked key alone grants nothing.
 */
export interface ObjectStorage {
  readonly driver: 'r2' | 'local';
  /** A URL the browser PUTs the file to. `contentType` is part of the signature. */
  createUploadUrl(key: string, opts: { contentType: string; maxBytes: number; expiresInSeconds: number }): Promise<SignedRequest>;
  /** A URL for playing or downloading. `downloadName` turns it into an attachment. */
  createDownloadUrl(key: string, opts: { expiresInSeconds: number; contentType?: string; downloadName?: string }): Promise<string>;
  /** Size and type of a stored object, or null when it does not exist. */
  stat(key: string): Promise<StoredObject | null>;
  /** The first `bytes` bytes, for checking a file's signature. */
  readStart(key: string, bytes: number): Promise<Buffer>;
  /** Removes the object; a missing object is not an error. */
  remove(key: string): Promise<void>;
}
