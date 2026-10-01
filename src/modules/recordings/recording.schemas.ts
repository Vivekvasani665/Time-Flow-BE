import { z } from 'zod';
import { env } from '../../config/env';
import { listQuerySchema } from '../../common/http/pagination';
import { boolQuery, optionalText, trimmed } from '../../common/utils/validation';

/** Entire display, entire display + webcam, or webcam alone. Single-window / single-tab capture is not supported. */
export const RECORDING_TYPES = ['FULL_SCREEN', 'SCREEN_WEBCAM', 'WEBCAM'] as const;

/** Container formats MediaRecorder produces: WebM (Chrome, Edge, Firefox) and MP4 (Safari). */
export const VIDEO_TYPES = { 'video/webm': '.webm', 'video/mp4': '.mp4' } as const;
export type VideoType = keyof typeof VIDEO_TYPES;

export const THUMBNAIL_TYPES = { 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/png': '.png' } as const;
export type ThumbnailType = keyof typeof THUMBNAIL_TYPES;
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The browser reports e.g. "video/webm;codecs=vp9,opus". Only the container
 * matters for storage and playback, so the codecs parameter is dropped.
 */
const videoMimeType = z
  .string()
  .trim()
  .max(127)
  .transform((v) => v.split(';')[0].trim().toLowerCase())
  .pipe(z.enum(Object.keys(VIDEO_TYPES) as [VideoType, ...VideoType[]], { message: 'Only WebM or MP4 video can be uploaded' }));

const projectId = z.uuid({ message: 'Invalid project' }).nullable().optional();

export const createUploadSchema = z
  .object({
    mimeType: videoMimeType,
    /** Declared size, checked up front; the stored size is checked again on completion. */
    fileSize: z
      .number()
      .int()
      .min(1, 'The recording is empty')
      .max(env.RECORDING_MAX_BYTES, `Recordings can be at most ${Math.floor(env.RECORDING_MAX_BYTES / (1024 * 1024))} MB`),
    recordingType: z.enum(RECORDING_TYPES),
    projectId,
    thumbnail: z
      .object({
        mimeType: z.enum(Object.keys(THUMBNAIL_TYPES) as [ThumbnailType, ...ThumbnailType[]]),
        fileSize: z.number().int().min(1).max(THUMBNAIL_MAX_BYTES),
      })
      .strict()
      .optional(),
  })
  .strict();

const tag = z.string().trim().min(1).max(40, 'Tags can be at most 40 characters');

export const completeUploadSchema = z
  .object({
    recordingId: z.uuid({ message: 'Invalid recording' }),
    title: trimmed(1, 160, 'Title'),
    description: optionalText(2000).optional(),
    tags: z
      .array(tag)
      .max(10, 'At most 10 tags')
      .default([])
      // Case-insensitive de-duplication, keeping the first spelling.
      .transform((tags) => tags.filter((t, i) => tags.findIndex((o) => o.toLowerCase() === t.toLowerCase()) === i)),
    projectId,
    /** Seconds. Measured by the recorder; capped at a day. */
    duration: z.number().int().min(0).max(24 * 3600).nullable().optional(),
    recordingType: z.enum(RECORDING_TYPES),
  })
  .strict();

export const listRecordingsQuerySchema = listQuerySchema(['createdAt', 'title', 'duration', 'fileSize'] as const, 'createdAt').extend({
  limit: z.coerce.number().int().min(1).max(100).default(12),
  recordingType: z.enum(RECORDING_TYPES).optional(),
  projectId: z.uuid({ message: 'Invalid project' }).optional(),
  /** Only the caller's own recordings. */
  mine: boolQuery.optional(),
});

export type CreateUploadInput = z.infer<typeof createUploadSchema>;
export type CompleteUploadInput = z.infer<typeof completeUploadSchema>;
export type ListRecordingsQuery = z.infer<typeof listRecordingsQuerySchema>;
