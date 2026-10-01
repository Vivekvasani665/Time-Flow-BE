import type { Prisma } from '@prisma/client';
import { userRefSelect } from '../../common/http/selects';
import { env } from '../../config/env';
import { storage } from '../../lib/storage';
import type { AuthContext } from '../auth/auth.types';
import { projectScope } from '../projects/project.repository';
import { VIDEO_TYPES, type VideoType } from './recording.schemas';

export const recordingSelect = {
  id: true,
  userId: true,
  title: true,
  description: true,
  tags: true,
  storageKey: true,
  thumbnailKey: true,
  mimeType: true,
  fileSize: true,
  duration: true,
  recordingType: true,
  createdAt: true,
  updatedAt: true,
  user: { select: userRefSelect },
  project: { select: { id: true, name: true, managerId: true, deletedAt: true } },
} satisfies Prisma.RecordingSelect;

export type RecordingRecord = Prisma.RecordingGetPayload<{ select: typeof recordingSelect }>;

/**
 * Row-level data scope. Without `recordings.manage_all` a user sees their own
 * recordings plus those attached to a project they can see — attaching a
 * recording to a project is how it is shared. Applied to every read and delete.
 */
export function recordingScope(actor: AuthContext): Prisma.RecordingWhereInput {
  if (actor.permissions.has('recordings.manage_all')) return { status: 'READY' };
  return { status: 'READY', OR: [{ userId: actor.id }, { project: projectScope(actor) }] };
}

/** Owner, the linked project's manager, or a recordings administrator. */
export function canManage(actor: AuthContext, r: Pick<RecordingRecord, 'userId' | 'project'>): boolean {
  return r.userId === actor.id || actor.permissions.has('recordings.manage_all') || (!!r.project && !r.project.deletedAt && r.project.managerId === actor.id);
}

function downloadName(r: RecordingRecord): string {
  const base = r.title.replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'recording';
  return `${base}${VIDEO_TYPES[r.mimeType as VideoType] ?? ''}`;
}

const ttl = () => env.RECORDING_PLAYBACK_URL_TTL_SECONDS;

export async function toRecording(actor: AuthContext, r: RecordingRecord) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    tags: r.tags,
    mimeType: r.mimeType,
    // BigInt does not serialise to JSON; recordings are far below 2^53 bytes.
    fileSize: Number(r.fileSize),
    duration: r.duration,
    recordingType: r.recordingType,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    owner: r.user,
    project: r.project && !r.project.deletedAt ? { id: r.project.id, name: r.project.name } : null,
    thumbnailUrl: r.thumbnailKey ? await storage.createDownloadUrl(r.thumbnailKey, { expiresInSeconds: ttl() }) : null,
    canDelete: canManage(actor, r),
  };
}

/** Detail view: adds signed playback and download URLs. */
export async function toRecordingDetail(actor: AuthContext, r: RecordingRecord) {
  const [base, playbackUrl, downloadUrl] = await Promise.all([
    toRecording(actor, r),
    storage.createDownloadUrl(r.storageKey, { expiresInSeconds: ttl(), contentType: r.mimeType }),
    storage.createDownloadUrl(r.storageKey, { expiresInSeconds: ttl(), contentType: r.mimeType, downloadName: downloadName(r) }),
  ]);
  return { ...base, playbackUrl, downloadUrl, urlsExpireAt: new Date(Date.now() + ttl() * 1000).toISOString() };
}

export type RecordingDto = Awaited<ReturnType<typeof toRecording>>;
export type RecordingDetailDto = Awaited<ReturnType<typeof toRecordingDetail>>;
