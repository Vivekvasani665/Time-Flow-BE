import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { skipTake } from '../../common/http/pagination';
import { buildMeta, created, ok, paginated } from '../../common/http/response';
import { getQueues } from '../../queue/queues';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../common/errors/app-error';
import { authenticate, requirePermission } from '../../common/middleware/authenticate';
import { rateLimit } from '../../common/middleware/rate-limit';
import { env } from '../../config/env';
import { requireAuth } from '../../common/utils/request-context';
import { uuidParam } from '../../common/utils/validation';
import { P } from '../permissions/permission-catalog';
import { composeSchema, draftUpdateSchema, emailService, MAX_ATTACHMENT_BYTES } from './email.service';

/**
 * Mailbox. Folders are derived from who a message belongs to:
 *   inbox  — you are the recipient      (toUserId; includes replies to your
 *            mail that arrived from outside, which are INBOUND rows)
 *   sent   — your action triggered it   (fromUserId)
 *   drafts — composed but not sent yet  (fromUserId, status DRAFT)
 *   all    — everything sent (needs emails.view_all; never anyone's drafts)
 */
const boxSchema = z.enum(['inbox', 'sent', 'drafts', 'all']).default('inbox');

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['QUEUED', 'SENT', 'FAILED']).optional(),
  box: boxSchema,
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v ? v : undefined)),
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

const readBody = z.object({ read: z.boolean().default(true) });

/** Recipient / sender identity shown in the mail header. */
const userPreview = { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } } as const;

/** List rows omit the body — it is only fetched when a message is opened. */
const listSelect = {
  id: true,
  to: true,
  cc: true,
  fromAddress: true,
  fromName: true,
  direction: true,
  subject: true,
  template: true,
  status: true,
  attempts: true,
  lastError: true,
  readAt: true,
  sentAt: true,
  createdAt: true,
  toUser: userPreview,
  fromUser: userPreview,
  _count: { select: { attachments: true } },
} satisfies Prisma.EmailLogSelect;

const attachmentMeta = { select: { id: true, fileName: true, mimeType: true, size: true }, orderBy: { createdAt: 'asc' } } as const;

/** A draft is private to its author — even the `all` audit view leaves it out. */
const notDraft: Prisma.EmailLogWhereInput = { status: { not: 'DRAFT' } };

/**
 * Scopes a query to the requested folder, rejecting `all` without the
 * permission. Each folder hides only the copies *this* user deleted — the other
 * party still has theirs.
 */
function boxFilter(box: z.infer<typeof boxSchema>, userId: string, canViewAll: boolean): Prisma.EmailLogWhereInput {
  switch (box) {
    case 'all':
      // The audit view: it deliberately still shows mail either side has hidden.
      if (!canViewAll) throw new ForbiddenError();
      return notDraft;
    case 'drafts':
      return { fromUserId: userId, status: 'DRAFT' };
    case 'sent':
      return { fromUserId: userId, deletedByFromAt: null, ...notDraft };
    case 'inbox':
      return { toUserId: userId, deletedByToAt: null, ...notDraft };
  }
}

/** Everything the caller has not deleted, in either direction. */
const ownVisible = (userId: string): Prisma.EmailLogWhereInput => ({
  ...notDraft,
  OR: [
    { toUserId: userId, deletedByToAt: null },
    { fromUserId: userId, deletedByFromAt: null },
  ],
});

/**
 * Composing is the one mailbox route that leaves the building: it sends real
 * email carrying the organisation's SPF/DKIM. The global API limiter (hundreds
 * of requests a minute, per IP) is the wrong budget for that, so this one is
 * tighter and counted per user.
 */
const composeLimiter = rateLimit({
  name: 'email-compose',
  limit: env.RATE_LIMIT_EMAIL_MAX,
  windowSeconds: env.RATE_LIMIT_EMAIL_WINDOW_SECONDS,
  message: 'You are sending messages too quickly. Try again in a moment.',
  identify: (req) => req.auth?.id ?? req.ip ?? 'unknown',
});

export const emailRouter = Router();

emailRouter.use(authenticate, requirePermission(P['emails.view']));

/** Counters for the System Monitor strip and the sidebar unread badge. */
emailRouter.get('/stats', async (req: Request, res: Response) => {
  const auth = requireAuth(req);
  const canViewAll = auth.permissions.has(P['emails.view_all']);
  // Admins watch the whole system; everyone else only their own mail.
  const scope: Prisma.EmailLogWhereInput = canViewAll ? notDraft : ownVisible(auth.id);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [total, queued, sent, failed, unread, last24h, drafts] = await prisma.$transaction([
    prisma.emailLog.count({ where: scope }),
    prisma.emailLog.count({ where: { ...scope, status: 'QUEUED' } }),
    prisma.emailLog.count({ where: { ...scope, status: 'SENT' } }),
    prisma.emailLog.count({ where: { ...scope, status: 'FAILED' } }),
    prisma.emailLog.count({ where: { toUserId: auth.id, readAt: null, deletedByToAt: null } }),
    prisma.emailLog.count({ where: { ...scope, createdAt: { gte: since } } }),
    // Always the caller's own: nobody else's drafts are counted.
    prisma.emailLog.count({ where: { fromUserId: auth.id, status: 'DRAFT' } }),
  ]);

  return ok(res, { total, queued, sent, failed, unread, last24h, drafts, scope: canViewAll ? 'all' : 'own' });
});

async function listBox(req: Request, res: Response, box?: z.infer<typeof boxSchema>) {
  const auth = requireAuth(req);
  const q = listQuery.parse(box ? { ...req.query, box } : req.query);
  const where: Prisma.EmailLogWhereInput = {
    ...boxFilter(q.box, auth.id, auth.permissions.has(P['emails.view_all'])),
    ...(q.status ? { status: q.status } : {}),
    ...(q.unreadOnly ? { readAt: null } : {}),
    ...(q.search
      ? {
          OR: [
            { subject: { contains: q.search, mode: 'insensitive' as const } },
            { to: { contains: q.search, mode: 'insensitive' as const } },
            { fromAddress: { contains: q.search, mode: 'insensitive' as const } },
            { fromName: { contains: q.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.emailLog.findMany({ where, select: listSelect, orderBy: { createdAt: 'desc' }, ...skipTake(q.page, q.limit) }),
    prisma.emailLog.count({ where }),
  ]);
  return paginated(res, items, buildMeta(q.page, q.limit, total));
}

emailRouter.get('/', (req: Request, res: Response) => listBox(req, res));
/** Folder shortcuts: the same as `GET /?box=…`. */
emailRouter.get('/inbox', (req: Request, res: Response) => listBox(req, res, 'inbox'));
emailRouter.get('/sent', (req: Request, res: Response) => listBox(req, res, 'sent'));
emailRouter.get('/drafts', (req: Request, res: Response) => listBox(req, res, 'drafts'));

/**
 * Compose. Sends at once, or with `draft: true` saves to Drafts. A recipient
 * that is an active team member also lands in their Inbox; any other address
 * is delivered by the mail provider only and sends from the organisation's own
 * identity, so it needs `emails.send_external` on top of `emails.send`.
 */
emailRouter.post('/', requirePermission(P['emails.send']), composeLimiter, async (req: Request, res: Response) => {
  const auth = requireAuth(req);
  const input = composeSchema.parse(req.body);
  const result = await emailService.compose(auth, input);
  return created(res, result, input.draft ? 'Draft saved' : 'Message sent');
});

/**
 * Upload a file to attach, as multipart field `file`. Returns an id to pass in
 * `attachmentIds` when composing or saving a draft. Held in memory, then in
 * the database: the worker that sends the mail does not share this disk.
 */
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 0 },
  // Browsers send the filename as UTF-8; multer's default would mangle "Résumé.pdf".
  defParamCharset: 'utf8',
});

emailRouter.post(
  '/attachments',
  requirePermission(P['emails.send']),
  composeLimiter,
  attachmentUpload.single('file'),
  async (req: Request, res: Response) => {
    const auth = requireAuth(req);
    if (!req.file) throw new BadRequestError('No file uploaded', 'VALIDATION_ERROR', [{ path: 'file', message: 'File is required' }]);
    return created(res, await emailService.storeAttachment(auth, req.file), 'File attached');
  },
);

emailRouter.delete('/attachments/:id', requirePermission(P['emails.send']), async (req: Request, res: Response) => {
  const auth = requireAuth(req);
  const { id } = uuidParam.parse(req.params);
  await emailService.removeAttachment(auth, id);
  return ok(res, null, 'Attachment removed');
});

/**
 * "Check for replies now". The poll also runs on a schedule; this only brings
 * the next one forward. The fixed job id collapses repeated clicks into one.
 */
emailRouter.post('/sync', async (_req: Request, res: Response) => {
  await getQueues().inbox.add('sync', { reason: 'manual' }, { jobId: 'inbox-sync-manual', removeOnComplete: true, removeOnFail: true });
  return ok(res, { queued: true }, 'Checking for new replies');
});

emailRouter.get('/:id', async (req: Request, res: Response) => {
  const auth = requireAuth(req);
  const { id } = uuidParam.parse(req.params);
  const email = await prisma.emailLog.findUnique({
    where: { id },
    select: {
      ...listSelect,
      bodyHtml: true,
      bodyText: true,
      jobId: true,
      toUserId: true,
      fromUserId: true,
      replyToId: true,
      replyTo: { select: { id: true, subject: true, createdAt: true } },
      bcc: true,
      providerMessageId: true,
      attachments: attachmentMeta,
      deletedByToAt: true,
      deletedByFromAt: true,
    },
  });
  if (!email) throw new NotFoundError('Email');
  // A draft is its author's alone; to anyone else it does not exist.
  if (email.status === 'DRAFT' && email.fromUserId !== auth.id) throw new NotFoundError('Email');

  // Deleting hides a message from its owner, so it must stop being fetchable by
  // id too — otherwise a stale link would still open it.
  const asRecipient = email.toUserId === auth.id && email.deletedByToAt === null;
  const asSender = email.fromUserId === auth.id && email.deletedByFromAt === null;
  if (!asRecipient && !asSender) {
    if (!auth.permissions.has(P['emails.view_all'])) throw new ForbiddenError();
  }

  const { deletedByToAt, deletedByFromAt, bcc, ...view } = email;
  // Bcc is secret from the other recipients by definition — only the sender
  // (and the audit view) may see who was on it.
  const showBcc = email.fromUserId === auth.id || auth.permissions.has(P['emails.view_all']);
  return ok(res, { ...view, bcc: showBcc ? bcc : [] });
});

/** Download one attachment of a message you can open. */
emailRouter.get('/:id/attachments/:attachmentId', async (req: Request, res: Response) => {
  const auth = requireAuth(req);
  const { id } = uuidParam.parse(req.params);
  const { id: attachmentId } = uuidParam.parse({ id: req.params.attachmentId });
  const file = await prisma.emailAttachment.findFirst({
    where: { id: attachmentId, emailId: id },
    select: {
      fileName: true,
      mimeType: true,
      content: true,
      email: { select: { status: true, toUserId: true, fromUserId: true, deletedByToAt: true, deletedByFromAt: true } },
    },
  });
  if (!file?.email) throw new NotFoundError('Attachment');
  const e = file.email;
  const asRecipient = e.status !== 'DRAFT' && e.toUserId === auth.id && e.deletedByToAt === null;
  const asSender = e.fromUserId === auth.id && e.deletedByFromAt === null;
  const asAuditor = e.status !== 'DRAFT' && auth.permissions.has(P['emails.view_all']);
  if (!asRecipient && !asSender && !asAuditor) throw new NotFoundError('Attachment');

  // Always a download, never rendered in the API's origin.
  res.attachment(file.fileName);
  res.type(file.mimeType);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.send(Buffer.from(file.content));
});

/** Autosave a draft. Only the fields sent change; `attachmentIds` replaces the set. */
emailRouter.patch('/:id', requirePermission(P['emails.send']), async (req: Request, res: Response) => {
  const auth = requireAuth(req);
  const { id } = uuidParam.parse(req.params);
  const patch = draftUpdateSchema.parse(req.body ?? {});
  return ok(res, await emailService.updateDraft(auth, id, patch), 'Draft saved');
});

/**
 * Send a draft. The body may carry last edits (same fields as PATCH), applied
 * first. The draft becomes a QUEUED message in Sent; the worker delivers it.
 */
emailRouter.post('/:id/send', requirePermission(P['emails.send']), composeLimiter, async (req: Request, res: Response) => {
  const auth = requireAuth(req);
  const { id } = uuidParam.parse(req.params);
  const patch = draftUpdateSchema.parse(req.body ?? {});
  return ok(res, await emailService.sendDraft(auth, id, patch), 'Message sent');
});

/** Only the recipient has a read state — a message in Sent is never "unread". */
emailRouter.patch('/:id/read', async (req: Request, res: Response) => {
  const auth = requireAuth(req);
  const { id } = uuidParam.parse(req.params);
  const { read } = readBody.parse(req.body);

  const email = await prisma.emailLog.findUnique({ where: { id }, select: { toUserId: true, deletedByToAt: true } });
  if (!email || email.deletedByToAt !== null) throw new NotFoundError('Email');
  if (email.toUserId !== auth.id) throw new ForbiddenError();

  const updated = await prisma.emailLog.update({
    where: { id },
    data: { readAt: read ? new Date() : null },
    select: { id: true, readAt: true },
  });
  return ok(res, updated, read ? 'Marked as read' : 'Marked as unread');
});

/**
 * Removes the message from the caller's own folders. One row is both parties'
 * copy, so this is a per-side soft delete: the other party keeps theirs, and
 * the outbound delivery record survives for the admin audit view.
 */
emailRouter.delete('/:id', async (req: Request, res: Response) => {
  const auth = requireAuth(req);
  const { id } = uuidParam.parse(req.params);

  const email = await prisma.emailLog.findUnique({
    where: { id },
    select: { status: true, toUserId: true, fromUserId: true, deletedByToAt: true, deletedByFromAt: true },
  });
  if (!email) throw new NotFoundError('Email');
  if (email.status === 'DRAFT') {
    await emailService.deleteDraft(auth, id);
    return ok(res, null, 'Draft discarded');
  }

  // `emails.view_all` is a read permission: an admin may see everyone's mail but
  // may not delete a message that is not theirs.
  const isParty = email.toUserId === auth.id || email.fromUserId === auth.id;
  if (!isParty) throw new ForbiddenError();

  const now = new Date();
  // Someone who is both sender and recipient (a note to self) loses both copies.
  const data: Prisma.EmailLogUpdateInput = {
    ...(email.toUserId === auth.id && email.deletedByToAt === null ? { deletedByToAt: now } : {}),
    ...(email.fromUserId === auth.id && email.deletedByFromAt === null ? { deletedByFromAt: now } : {}),
  };
  // Already gone from their side — deleting again is a no-op, not an error.
  if (Object.keys(data).length > 0) await prisma.emailLog.update({ where: { id }, data });
  return ok(res, null, 'Message deleted');
});
