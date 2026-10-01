import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { storage } from '../../lib/storage';
import { env } from '../../config/env';
import { skipTake } from '../../common/http/pagination';
import { buildMeta } from '../../common/http/response';
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../common/errors';
import type { RequestContext } from '../../common/utils/request-context';
import { activityService } from '../activity-logs/activity.service';
import type { AuthContext } from '../auth/auth.types';
import { projectScope } from '../projects/project.repository';
import { canManage, recordingScope, recordingSelect, toRecording, toRecordingDetail } from './recording.repository';
import {
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_TYPES,
  VIDEO_TYPES,
  type CompleteUploadInput,
  type CreateUploadInput,
  type ListRecordingsQuery,
  type ThumbnailType,
} from './recording.schemas';

/** An upload not completed within this window is abandoned and swept. */
const ABANDONED_AFTER_MS = 24 * 3600 * 1000;
/** Unfinished uploads one person may have open at once. */
const MAX_PENDING_UPLOADS = 5;

const UNTITLED = 'Untitled recording';

/** MIME types are client-controlled; the stored bytes must carry the matching signature. */
function hasSignature(head: Buffer, mimeType: string): boolean {
  switch (mimeType) {
    case 'video/webm':
      return head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    case 'video/mp4':
      return head.toString('ascii', 4, 8) === 'ftyp';
    case 'image/jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'image/png':
      return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/webp':
      return head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP';
    default:
      return false;
  }
}

const thumbnailTypeOf = (key: string) =>
  (Object.entries(THUMBNAIL_TYPES).find(([, ext]) => key.endsWith(ext))?.[0] ?? null) as ThumbnailType | null;

async function removeObjects(keys: (string | null)[]): Promise<void> {
  await Promise.all(
    keys.filter((k): k is string => !!k).map((key) => storage.remove(key).catch((err: unknown) => logger.warn({ err, key }, 'failed to delete stored recording object'))),
  );
}

async function assertProjectVisible(actor: AuthContext, projectId: string): Promise<void> {
  const found = await prisma.project.count({ where: { AND: [{ id: projectId }, projectScope(actor)] } });
  if (!found) {
    throw new BadRequestError('You can only attach a recording to a project you belong to', 'VALIDATION_ERROR', [
      { path: 'projectId', message: 'Project not found or not accessible' },
    ]);
  }
}

/** Removes this person's uploads that were started but never completed. */
async function sweepAbandoned(userId: string): Promise<void> {
  const stale = await prisma.recording.findMany({
    where: { userId, status: 'UPLOADING', createdAt: { lt: new Date(Date.now() - ABANDONED_AFTER_MS) } },
    select: { id: true, storageKey: true, thumbnailKey: true },
  });
  if (!stale.length) return;
  await prisma.recording.deleteMany({ where: { id: { in: stale.map((s) => s.id) }, status: 'UPLOADING' } });
  await removeObjects(stale.flatMap((s) => [s.storageKey, s.thumbnailKey]));
}

/** Confirms the uploaded thumbnail, or drops it: a recording is still fine without one. */
async function verifiedThumbnail(key: string | null): Promise<string | null> {
  if (!key) return null;
  const type = thumbnailTypeOf(key);
  const stat = await storage.stat(key);
  if (stat && type && stat.size > 0 && stat.size <= THUMBNAIL_MAX_BYTES && hasSignature(await storage.readStart(key, 12), type)) return key;
  if (stat) await removeObjects([key]);
  return null;
}

export const recordingService = {
  async list(actor: AuthContext, query: ListRecordingsQuery) {
    const filters: Prisma.RecordingWhereInput = {};
    if (query.recordingType) filters.recordingType = query.recordingType;
    if (query.projectId) filters.projectId = query.projectId;
    if (query.mine) filters.userId = actor.id;
    if (query.search) {
      filters.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
        { tags: { has: query.search } },
      ];
    }
    const where: Prisma.RecordingWhereInput = { AND: [recordingScope(actor), filters] };
    const orderBy: Prisma.RecordingOrderByWithRelationInput =
      query.sortBy === 'duration' ? { duration: { sort: query.sortOrder, nulls: 'last' } } : { [query.sortBy]: query.sortOrder };

    const [records, total] = await prisma.$transaction([
      prisma.recording.findMany({ where, select: recordingSelect, orderBy: [orderBy, { id: 'asc' }], ...skipTake(query.page, query.limit) }),
      prisma.recording.count({ where }),
    ]);
    return { items: await Promise.all(records.map((r) => toRecording(actor, r))), meta: buildMeta(query.page, query.limit, total) };
  },

  async get(actor: AuthContext, id: string) {
    const record = await prisma.recording.findFirst({ where: { AND: [{ id }, recordingScope(actor)] }, select: recordingSelect });
    if (!record) throw new NotFoundError('Recording');
    return toRecordingDetail(actor, record);
  },

  /**
   * Step 1 of saving: reserves a recording and returns signed URLs the browser
   * uploads the finished file (and its thumbnail) to, directly to storage.
   */
  async createUpload(ctx: RequestContext, input: CreateUploadInput) {
    const { actor } = ctx;
    if (input.projectId) await assertProjectVisible(actor, input.projectId);

    await sweepAbandoned(actor.id).catch((err: unknown) => logger.warn({ err }, 'abandoned recording sweep failed'));
    const pending = await prisma.recording.count({ where: { userId: actor.id, status: 'UPLOADING' } });
    if (pending >= MAX_PENDING_UPLOADS) {
      throw new ConflictError('You have too many unfinished uploads. Finish or discard them, then try again.', 'TOO_MANY_PENDING_UPLOADS');
    }

    // Keys are generated here, never taken from the client.
    const id = randomUUID();
    const prefix = `recordings/${actor.id}/${id}`;
    const storageKey = `${prefix}/video${VIDEO_TYPES[input.mimeType]}`;
    const thumbnailKey = input.thumbnail ? `${prefix}/thumbnail${THUMBNAIL_TYPES[input.thumbnail.mimeType]}` : null;
    const expiresInSeconds = env.RECORDING_UPLOAD_URL_TTL_SECONDS;

    const [upload, thumbnailUpload] = await Promise.all([
      storage.createUploadUrl(storageKey, { contentType: input.mimeType, maxBytes: env.RECORDING_MAX_BYTES, expiresInSeconds }),
      input.thumbnail && thumbnailKey
        ? storage.createUploadUrl(thumbnailKey, { contentType: input.thumbnail.mimeType, maxBytes: THUMBNAIL_MAX_BYTES, expiresInSeconds })
        : Promise.resolve(null),
    ]);

    await prisma.recording.create({
      data: {
        id,
        userId: actor.id,
        projectId: input.projectId ?? null,
        title: UNTITLED,
        storageKey,
        thumbnailKey,
        mimeType: input.mimeType,
        fileSize: BigInt(input.fileSize),
        recordingType: input.recordingType,
      },
    });

    return { recordingId: id, maxBytes: env.RECORDING_MAX_BYTES, upload, thumbnailUpload };
  },

  /**
   * Step 2 of saving: the browser reports the upload finished. Nothing it says
   * about the file is trusted — size and type are read back from storage.
   */
  async completeUpload(ctx: RequestContext, input: CompleteUploadInput) {
    const { actor } = ctx;
    const pending = await prisma.recording.findFirst({
      where: { id: input.recordingId, userId: actor.id, status: 'UPLOADING' },
      select: { id: true, storageKey: true, thumbnailKey: true, mimeType: true, projectId: true },
    });
    if (!pending) throw new NotFoundError('Recording upload');

    const stored = await storage.stat(pending.storageKey);
    if (!stored || stored.size === 0) {
      throw new BadRequestError('The recording has not finished uploading. Please try saving again.', 'UPLOAD_INCOMPLETE');
    }
    const discard = async () => {
      await prisma.recording.deleteMany({ where: { id: pending.id, status: 'UPLOADING' } });
      await removeObjects([pending.storageKey, pending.thumbnailKey]);
    };
    if (stored.size > env.RECORDING_MAX_BYTES) {
      await discard();
      throw new AppError(413, 'RECORDING_TOO_LARGE', 'The recording is larger than the maximum allowed size');
    }
    if (!hasSignature(await storage.readStart(pending.storageKey, 16), pending.mimeType)) {
      await discard();
      throw new AppError(400, 'UNSUPPORTED_FILE_TYPE', 'The uploaded file is not a valid video');
    }

    const projectId = input.projectId === undefined ? pending.projectId : input.projectId;
    if (projectId) await assertProjectVisible(actor, projectId);
    const thumbnailKey = await verifiedThumbnail(pending.thumbnailKey);

    // Conditional on UPLOADING, so two concurrent completions cannot both succeed.
    const { count } = await prisma.recording.updateMany({
      where: { id: pending.id, status: 'UPLOADING' },
      data: {
        status: 'READY',
        title: input.title,
        description: input.description ?? null,
        tags: input.tags,
        projectId,
        duration: input.duration ?? null,
        recordingType: input.recordingType,
        fileSize: BigInt(stored.size),
        thumbnailKey,
      },
    });
    if (!count) throw new ConflictError('This recording has already been saved', 'RECORDING_ALREADY_SAVED');

    const record = await prisma.recording.findUniqueOrThrow({ where: { id: pending.id }, select: recordingSelect });
    await activityService.record(ctx, {
      action: 'recording.created',
      entity: 'recording',
      entityId: record.id,
      description: `Saved recording ${record.title}`,
      metadata: { recordingType: record.recordingType, fileSize: stored.size, duration: record.duration, projectId },
    });
    return toRecordingDetail(actor, record);
  },

  async remove(ctx: RequestContext, id: string) {
    const { actor } = ctx;
    const record = await prisma.recording.findFirst({ where: { AND: [{ id }, recordingScope(actor)] }, select: recordingSelect });
    if (!record) throw new NotFoundError('Recording');
    if (!canManage(actor, record)) throw new ForbiddenError('Only the owner or the project manager can delete this recording');

    await prisma.recording.delete({ where: { id } });
    // The row is gone, so the files are unreachable even if deleting them fails here.
    await removeObjects([record.storageKey, record.thumbnailKey]);
    await activityService.record(ctx, {
      action: 'recording.deleted',
      entity: 'recording',
      entityId: id,
      description: `Deleted recording ${record.title}`,
      metadata: { ownerId: record.userId },
    });
  },
};
