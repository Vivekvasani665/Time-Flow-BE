import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { AppError, ForbiddenError, NotFoundError } from '../../common/errors';
import { attachmentDisposition } from '../../lib/storage/r2-storage';
import type { LocalStorage } from '../../lib/storage/local-storage';

const tooLarge = () => new AppError(413, 'PAYLOAD_TOO_LARGE', 'File is too large');

/**
 * Signed-URL endpoint for STORAGE_DRIVER=local — the local equivalent of R2's
 * presigned PUT and GET. No session is involved: the token in the path is the
 * whole authorisation, exactly like a presigned URL, and it expires.
 */
export function createLocalStorageRouter(store: LocalStorage): Router {
  const router = Router();

  router.put('/:token', async (req: Request, res: Response) => {
    const grant = store.verifyGrant(String(req.params.token));
    if (!grant || grant.m !== 'PUT') throw new ForbiddenError('This upload link is invalid or has expired', 'INVALID_SIGNATURE');
    if ((req.get('content-type') ?? '') !== grant.t) throw new ForbiddenError('Content-Type does not match the signed upload', 'INVALID_SIGNATURE');
    const max = grant.x ?? 0;
    if (Number(req.get('content-length') ?? 0) > max) throw tooLarge();

    const target = store.pathFor(grant.k);
    await mkdir(path.dirname(target), { recursive: true });
    // Written beside the target and renamed, so a half-finished upload is never visible.
    const partial = `${target}.${randomUUID()}.part`;
    let received = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        cb(received > max ? tooLarge() : null, chunk);
      },
    });
    try {
      await pipeline(req, limit, createWriteStream(partial, { flags: 'wx' }));
      await rename(partial, target);
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
    res.status(200).end();
  });

  router.get('/:token', (req: Request, res: Response, next: NextFunction) => {
    const grant = store.verifyGrant(String(req.params.token));
    if (!grant || grant.m !== 'GET') return next(new ForbiddenError('This link is invalid or has expired', 'INVALID_SIGNATURE'));
    const headers: Record<string, string> = {
      'Cache-Control': 'private, max-age=300',
      'Content-Disposition': grant.d ? attachmentDisposition(grant.d) : 'inline',
    };
    // sendFile handles Range requests, which video seeking depends on.
    res.sendFile(store.pathFor(grant.k), { headers, dotfiles: 'deny' }, (err?: NodeJS.ErrnoException) => {
      if (!err || res.headersSent) return;
      next(err.code === 'ENOENT' || (err as { status?: number }).status === 404 ? new NotFoundError('File') : err);
    });
  });

  return router;
}
