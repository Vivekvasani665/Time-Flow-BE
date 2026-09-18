import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { env } from '../../config/env';
import { AppError, BadRequestError } from '../../common/errors';
import { created } from '../../common/http/response';
import { authenticate } from '../../common/middleware/authenticate';

const MAX_BYTES = 2 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

export const avatarDir = path.resolve(env.UPLOAD_DIR, 'avatars');
mkdirSync(avatarDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: avatarDir,
    // Never trust the client filename: random name + extension derived from the validated MIME type.
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${EXTENSIONS[file.mimetype] ?? ''}`),
  }),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 0 },
  fileFilter: (_req, file, cb) => {
    if (EXTENSIONS[file.mimetype]) return cb(null, true);
    return cb(new AppError(400, 'UNSUPPORTED_FILE_TYPE', 'Only PNG, JPEG or WebP images are allowed'));
  },
});

/** MIME type is client-controlled; confirm the file's magic bytes match. */
async function hasImageSignature(filePath: string, mime: string): Promise<boolean> {
  const handle = await open(filePath, 'r');
  try {
    const { buffer } = await handle.read(Buffer.alloc(12), 0, 12, 0);
    if (mime === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    if (mime === 'image/webp') return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
    return false;
  } finally {
    await handle.close();
  }
}

export const uploadRouter = Router();

uploadRouter.post('/avatar', authenticate, upload.single('file'), async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) throw new BadRequestError('No file uploaded', 'VALIDATION_ERROR', [{ path: 'file', message: 'File is required' }]);
  if (!(await hasImageSignature(file.path, file.mimetype))) {
    await unlink(file.path).catch(() => undefined);
    throw new AppError(400, 'UNSUPPORTED_FILE_TYPE', 'File content is not a valid image');
  }
  return created(res, { url: `/uploads/avatars/${file.filename}` }, 'Image uploaded');
});
