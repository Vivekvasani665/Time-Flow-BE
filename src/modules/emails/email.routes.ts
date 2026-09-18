import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { skipTake } from '../../common/http/pagination';
import { buildMeta, created, ok, paginated } from '../../common/http/response';
import { producers } from '../../queue/producers';
import { getQueues } from '../../queue/queues';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../common/errors/app-error';
import { authenticate, requirePermission } from '../../common/middleware/authenticate';
import { rateLimit } from '../../common/middleware/rate-limit';
import { env } from '../../config/env';
import { requireAuth } from '../../common/utils/request-context';
import { emailSchema, uuidParam } from '../../common/utils/validation';
import { P } from '../permissions/permission-catalog';

/**
 * Mailbox. Folders are derived from who a message belongs to:
 *   inbox — you are the recipient      (toUserId; includes replies to your
 *           mail that arrived from outside, which are INBOUND rows)
 *   sent  — your action triggered it   (fromUserId)
 *   all   — everything (needs emails.view_all)
 */
const boxSchema = z.enum(['inbox', 'sent', 'all']).default('inbox');

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

/**
 * Recipient is either a team member (lands in their in-app Inbox) or any
 * address at all (goes out over SMTP only) — exactly one of the two.
 */
const composeSchema = z
  .object({
    toUserId: z.uuid({ message: 'Pick a recipient' }).optional(),
    toEmail: emailSchema.optional(),
    subject: z.string().trim().min(1, 'Subject is required').max(200),
    body: z.string().trim().min(1, 'Message is required').max(5000),
    /** Threads this message under one the sender is a party to. */
    replyToId: z.uuid().optional(),
  })
  .refine((d) => Boolean(d.toUserId) !== Boolean(d.toEmail), {
    message: 'Give either a team member or an email address',
    path: ['toUserId'],
  });

/** Recipient / sender identity shown in the mail header. */
const userPreview = { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } } as const;

/** List rows omit the body — it is only fetched when a message is opened. */
const listSelect = {
  id: true,
  to: true,
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
} satisfies Prisma.EmailLogSelect;

/**
 * Scopes a query to the requested folder, rejecting `all` without the
 * permission. Each folder hides only the copies *this* user deleted — the other
 * party still has theirs.
 */
function boxFilter(box: z.infer<typeof boxSchema>, userId: string, canViewAll: boolean): Prisma.EmailLogWhereInput {
  if (box === 'all') {
    // The audit view: it deliberately still shows mail either side has hidden.
    if (!canViewAll) throw new ForbiddenError();
    return {};
  }
  return box === 'sent'
    ? { fromUserId: userId, deletedByFromAt: null }
    : { toUserId: userId, deletedByToAt: null };
}

/** Everything the caller has not deleted, in either direction. */
const ownVisible = (userId: string): Prisma.EmailLogWhereInput => ({
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
  const scope: Prisma.EmailLogWhereInput = canViewAll ? {} : ownVisible(auth.id);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [total, queued, sent, failed, unread, last24h] = await prisma.$transaction([
    prisma.emailLog.count({ where: scope }),
    prisma.emailLog.count({ where: { ...scope, status: 'QUEUED' } }),
    prisma.emailLog.count({ where: { ...scope, status: 'SENT' } }),
    prisma.emailLog.count({ where: { ...scope, status: 'FAILED' } }),
    prisma.emailLog.count({ where: { toUserId: auth.id, readAt: null, deletedByToAt: null } }),
    prisma.emailLog.count({ where: { ...scope, createdAt: { gte: since } } }),
  ]);

  return ok(res, { total, queued, sent, failed, unread, last24h, scope: canViewAll ? 'all' : 'own' });
});

emailRouter.get('/', async (req: Request, res: Response) => {
  const auth = requireAuth(req);
  const q = listQuery.parse(req.query);
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
});

/**
 * Compose. A recipient that resolves to an active team member also lands in
 * their Inbox; any other address is SMTP-only and sends from the organisation's
 * own identity, so it needs `emails.send_external` on top of `emails.send`.
 */
emailRouter.post('/', requirePermission(P['emails.send']), composeLimiter, async (req: Request, res: Response) => {
  const auth = requireAuth(req);
  const input = composeSchema.parse(req.body);

  // Match against every account, not just active ones: an address belonging to
  // an offboarded colleague must be refused, not quietly treated as a stranger.
  const match = await prisma.user.findFirst({
    where: input.toUserId ? { id: input.toUserId } : { email: input.toEmail },
    select: { id: true, email: true, status: true, deletedAt: true },
  });
  const usable = match && !match.deletedAt && match.status === 'ACTIVE';

  // A reply may only be threaded under a message the sender is a party to —
  // otherwise any id would let someone attach mail to a stranger's thread.
  const parent = input.replyToId
    ? await prisma.emailLog.findUnique({
        where: { id: input.replyToId },
        select: { toUserId: true, fromUserId: true, direction: true, fromAddress: true },
      })
    : null;
  if (input.replyToId) {
    if (!parent) throw new NotFoundError('Message being replied to');
    if (parent.toUserId !== auth.id && parent.fromUserId !== auth.id) throw new ForbiddenError();
  }
  // Answering someone who wrote to you is not relaying mail to a stranger, so it
  // does not need `emails.send_external` — but only back to that same address.
  const answeringInbound =
    parent?.direction === 'INBOUND' &&
    parent.toUserId === auth.id &&
    Boolean(input.toEmail) &&
    input.toEmail!.toLowerCase() === parent.fromAddress.toLowerCase();

  if (input.toUserId) {
    if (!usable) throw new NotFoundError('Recipient');
  } else if (match && !usable) {
    throw new BadRequestError('That address belongs to a deactivated account.');
  } else if (!match && !answeringInbound && !auth.permissions.has(P['emails.send_external'])) {
    // Without this guard any signed-in user could relay arbitrary mail from the
    // org's sender identity, carrying its SPF/DKIM.
    throw new ForbiddenError();
  }

  const to = usable ? { id: match.id, email: match.email } : { id: null, email: input.toEmail! };

  const sender = await prisma.user.findUnique({
    where: { id: auth.id },
    select: { firstName: true, lastName: true },
  });
  if (!sender) throw new NotFoundError('Sender');

  const log = await producers.userMessage({
    from: { id: auth.id, name: `${sender.firstName} ${sender.lastName}` },
    to,
    subject: input.subject,
    body: input.body,
    replyToId: input.replyToId ?? null,
  });

  return created(res, log, 'Message sent');
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
      deletedByToAt: true,
      deletedByFromAt: true,
    },
  });
  if (!email) throw new NotFoundError('Email');

  // Deleting hides a message from its owner, so it must stop being fetchable by
  // id too — otherwise a stale link would still open it.
  const asRecipient = email.toUserId === auth.id && email.deletedByToAt === null;
  const asSender = email.fromUserId === auth.id && email.deletedByFromAt === null;
  if (!asRecipient && !asSender) {
    if (!auth.permissions.has(P['emails.view_all'])) throw new ForbiddenError();
  }

  const { deletedByToAt, deletedByFromAt, ...view } = email;
  return ok(res, view);
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
    select: { toUserId: true, fromUserId: true, deletedByToAt: true, deletedByFromAt: true },
  });
  if (!email) throw new NotFoundError('Email');

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
