import path from 'node:path';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../common/errors/app-error';
import type { AuthContext } from '../auth/auth.types';
import { emailSchema } from '../../common/utils/validation';
import { producers } from '../../queue/producers';
import { P } from '../permissions/permission-catalog';

/** Per file. Gmail's 25 MB cap is on the encoded message, and base64 adds a third. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 18 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
const MAX_RECIPIENTS = 50;
/** An upload never attached to a message is swept after this long. */
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

/** Extensions Gmail refuses outright — accepting them would only fail at send. */
const BLOCKED_EXTENSIONS = new Set([
  '.ade', '.adp', '.apk', '.appx', '.bat', '.cab', '.chm', '.cmd', '.com', '.cpl', '.dll', '.dmg', '.exe', '.hta', '.ins',
  '.isp', '.iso', '.jar', '.js', '.jse', '.lib', '.lnk', '.mde', '.msc', '.msi', '.msix', '.msp', '.mst', '.nsh', '.pif',
  '.ps1', '.scr', '.sct', '.shb', '.sys', '.vb', '.vbe', '.vbs', '.vxd', '.wsc', '.wsf', '.wsh',
]);

const addressList = z.array(emailSchema).max(MAX_RECIPIENTS, `At most ${MAX_RECIPIENTS} recipients`);

/**
 * Everything a message can carry. Recipients come either the original way — one
 * `toUserId` (a team member) or one `toEmail` — or as `to` / `cc` / `bcc`
 * address lists; the forms combine. Nothing is required here, because a draft
 * may be saved half-written: `requireSendable` applies the rules for sending.
 */
export const messageFields = z.object({
  toUserId: z.uuid({ message: 'Pick a recipient' }).optional(),
  toEmail: emailSchema.optional(),
  to: addressList.optional(),
  cc: addressList.optional(),
  bcc: addressList.optional(),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().max(20_000).optional(),
  /** Threads this message under one the sender is a party to. */
  replyToId: z.uuid().optional(),
  /** Ids from POST /api/emails/attachments. On a draft update this replaces the list. */
  attachmentIds: z.array(z.uuid()).max(MAX_ATTACHMENTS, `At most ${MAX_ATTACHMENTS} attachments`).optional(),
});

export const composeSchema = messageFields
  .extend({
    /** Save to Drafts instead of sending. */
    draft: z.boolean().default(false),
  })
  .refine((d) => !(d.toUserId && d.toEmail), {
    message: 'Give either a team member or an email address',
    path: ['toUserId'],
  });

export const draftUpdateSchema = messageFields.omit({ toUserId: true, toEmail: true, replyToId: true });

export type MessageFields = z.infer<typeof messageFields>;

type Recipients = {
  to: string[];
  cc: string[];
  bcc: string[];
  /** The team member whose Inbox holds this message: the first To address that is one. */
  toUserId: string | null;
};

/** Lower-cased, de-duplicated across the lines — To beats Cc beats Bcc. */
function dedupe(to: string[], cc: string[], bcc: string[]) {
  const seen = new Set<string>();
  const take = (list: string[]) =>
    list.filter((a) => {
      const key = a.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { to: take(to), cc: take(cc), bcc: take(bcc) };
}

const splitTo = (to: string) => to.split(',').map((a) => a.trim()).filter(Boolean);

function requireSendable(input: { subject: string; body: string; hasRecipient: boolean }) {
  const issues = [
    ...(!input.hasRecipient ? [{ path: 'to', message: 'Add at least one recipient' }] : []),
    ...(input.subject ? [] : [{ path: 'subject', message: 'Subject is required' }]),
    ...(input.body ? [] : [{ path: 'body', message: 'Message is required' }]),
  ];
  if (issues.length) throw new BadRequestError(issues[0]!.message, 'VALIDATION_ERROR', issues);
}

async function assertReplyParent(auth: AuthContext, replyToId: string | null | undefined) {
  if (!replyToId) return null;
  // A reply may only be threaded under a message the sender is a party to —
  // otherwise any id would let someone attach mail to a stranger's thread.
  const parent = await prisma.emailLog.findUnique({
    where: { id: replyToId },
    select: { toUserId: true, fromUserId: true, direction: true, fromAddress: true, status: true },
  });
  if (!parent || parent.status === 'DRAFT') throw new NotFoundError('Message being replied to');
  if (parent.toUserId !== auth.id && parent.fromUserId !== auth.id) throw new ForbiddenError();
  return parent;
}

/**
 * Decides who may be mailed. An address belonging to an active team member is
 * always allowed; one belonging to a deactivated account never is; any other
 * address leaves the organisation, so it needs `emails.send_external` — unless
 * it is simply answering the outside sender of a message you received.
 */
async function resolveRecipients(
  auth: AuthContext,
  input: { toUserId?: string | undefined; to: string[]; cc: string[]; bcc: string[] },
  parent: Awaited<ReturnType<typeof assertReplyParent>>,
): Promise<Recipients> {
  const to = [...input.to];
  if (input.toUserId) {
    const user = await prisma.user.findUnique({ where: { id: input.toUserId }, select: { email: true, status: true, deletedAt: true } });
    if (!user || user.deletedAt || user.status !== 'ACTIVE') throw new NotFoundError('Recipient');
    to.unshift(user.email);
  }
  const lines = dedupe(to, input.cc, input.bcc);
  const all = [...lines.to, ...lines.cc, ...lines.bcc];
  if (all.length > MAX_RECIPIENTS) throw new BadRequestError(`At most ${MAX_RECIPIENTS} recipients`);

  // Match against every account, not just active ones: an address belonging to
  // an offboarded colleague must be refused, not quietly treated as a stranger.
  const accounts = all.length
    ? await prisma.user.findMany({ where: { email: { in: all } }, select: { id: true, email: true, status: true, deletedAt: true } })
    : [];
  const members = new Map<string, string>();
  const known = new Set<string>();
  for (const a of accounts) {
    known.add(a.email);
    if (!a.deletedAt && a.status === 'ACTIVE') members.set(a.email, a.id);
  }
  const deactivated = all.find((a) => known.has(a) && !members.has(a));
  if (deactivated) throw new BadRequestError(`${deactivated} belongs to a deactivated account.`);

  const external = all.filter((a) => !known.has(a));
  if (external.length && !auth.permissions.has(P['emails.send_external'])) {
    // Answering someone who wrote to you is not relaying mail to a stranger —
    // but only back to that same address.
    const answeringInbound =
      parent?.direction === 'INBOUND' &&
      parent.toUserId === auth.id &&
      external.every((a) => a === parent.fromAddress.toLowerCase());
    // Without this guard any signed-in user could relay arbitrary mail from the
    // org's sender identity, carrying its SPF/DKIM.
    if (!answeringInbound) throw new ForbiddenError();
  }

  const owner = lines.to.find((a) => members.has(a));
  return { ...lines, toUserId: owner ? members.get(owner)! : null };
}

/**
 * Checks the uploads belong to the caller and are free to use — never
 * attached, or already on this same draft — and that together they fit.
 */
async function assertAttachments(auth: AuthContext, ids: string[], draftId: string | null) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await prisma.emailAttachment.findMany({
    where: { id: { in: unique }, uploadedById: auth.id, OR: [{ emailId: null }, ...(draftId ? [{ emailId: draftId }] : [])] },
    select: { id: true, size: true },
  });
  if (rows.length !== unique.length) throw new NotFoundError('Attachment');
  const total = rows.reduce((sum, r) => sum + r.size, 0);
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', `Attachments may total at most ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024} MB`);
  }
  return unique;
}

async function senderName(userId: string) {
  const sender = await prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
  if (!sender) throw new NotFoundError('Sender');
  return `${sender.firstName} ${sender.lastName}`;
}

/** Loads one of the caller's drafts, or fails as though it did not exist. */
async function ownDraft(auth: AuthContext, id: string) {
  const draft = await prisma.emailLog.findUnique({
    where: { id },
    select: { id: true, fromUserId: true, status: true, to: true, cc: true, bcc: true, subject: true, bodyText: true, replyToId: true },
  });
  // Someone else's draft is not theirs to know about, so it is a 404, not a 403.
  if (!draft || draft.fromUserId !== auth.id) throw new NotFoundError('Draft');
  if (draft.status !== 'DRAFT') throw new ConflictError('This message has already been sent');
  return draft;
}

export const emailService = {
  /** Sends at once, or saves to Drafts when `draft` is set. */
  async compose(auth: AuthContext, input: z.infer<typeof composeSchema>) {
    const to = [...(input.toEmail ? [input.toEmail] : []), ...(input.to ?? [])];
    const cc = input.cc ?? [];
    const bcc = input.bcc ?? [];
    const subject = input.subject ?? '';
    const body = input.body ?? '';

    if (input.draft) {
      await assertReplyParent(auth, input.replyToId);
      // A draft's recipients are checked when it is sent; here only the shape.
      let toLine = to;
      if (input.toUserId) {
        const user = await prisma.user.findUnique({ where: { id: input.toUserId }, select: { email: true } });
        if (!user) throw new NotFoundError('Recipient');
        toLine = [user.email, ...to];
      }
      const lines = dedupe(toLine, cc, bcc);
      const attachmentIds = await assertAttachments(auth, input.attachmentIds ?? [], null);
      return prisma.$transaction(async (tx) => {
        const draft = await tx.emailLog.create({
          data: {
            status: 'DRAFT',
            template: 'message',
            fromAddress: '',
            fromUserId: auth.id,
            to: lines.to.join(', '),
            cc: lines.cc,
            bcc: lines.bcc,
            subject,
            // What the author typed; rendered into the mail template on send.
            bodyText: body,
            replyToId: input.replyToId ?? null,
          },
          select: { id: true },
        });
        if (attachmentIds.length) await tx.emailAttachment.updateMany({ where: { id: { in: attachmentIds } }, data: { emailId: draft.id } });
        return { ...draft, status: 'DRAFT' as const };
      });
    }

    requireSendable({ subject, body, hasRecipient: Boolean(input.toUserId) || to.length > 0 });
    const parent = await assertReplyParent(auth, input.replyToId);
    const recipients = await resolveRecipients(auth, { toUserId: input.toUserId, to, cc, bcc }, parent);
    const attachmentIds = await assertAttachments(auth, input.attachmentIds ?? [], null);

    return producers.userMessage({
      from: { id: auth.id, name: await senderName(auth.id) },
      to: { id: recipients.toUserId, email: recipients.to.join(', ') },
      ...(recipients.cc.length ? { cc: recipients.cc } : {}),
      ...(recipients.bcc.length ? { bcc: recipients.bcc } : {}),
      ...(attachmentIds.length ? { attachmentIds } : {}),
      subject,
      body,
      replyToId: input.replyToId ?? null,
    });
  },

  /** Autosave. Only the fields given change; `attachmentIds` replaces the set. */
  async updateDraft(auth: AuthContext, id: string, patch: z.infer<typeof draftUpdateSchema>) {
    await ownDraft(auth, id);
    const attachmentIds = patch.attachmentIds ? await assertAttachments(auth, patch.attachmentIds, id) : null;

    return prisma.$transaction(async (tx) => {
      const current = await tx.emailLog.findUniqueOrThrow({ where: { id }, select: { to: true, cc: true, bcc: true } });
      const lines = dedupe(patch.to ?? splitTo(current.to), patch.cc ?? current.cc, patch.bcc ?? current.bcc);
      // Guarded on DRAFT: a Send that won the race must not be overwritten.
      const { count } = await tx.emailLog.updateMany({
        where: { id, status: 'DRAFT' },
        data: {
          to: lines.to.join(', '),
          cc: lines.cc,
          bcc: lines.bcc,
          ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
          ...(patch.body !== undefined ? { bodyText: patch.body } : {}),
        },
      });
      if (count === 0) throw new ConflictError('This message has already been sent');
      if (attachmentIds) {
        // Files taken off the draft are deleted, not orphaned.
        await tx.emailAttachment.deleteMany({ where: { emailId: id, id: { notIn: attachmentIds } } });
        await tx.emailAttachment.updateMany({ where: { id: { in: attachmentIds } }, data: { emailId: id } });
      }
      return tx.emailLog.findUniqueOrThrow({
        where: { id },
        select: {
          id: true,
          status: true,
          to: true,
          cc: true,
          bcc: true,
          subject: true,
          bodyText: true,
          updatedAt: true,
          attachments: { select: { id: true, fileName: true, mimeType: true, size: true } },
        },
      });
    });
  },

  /** Applies any last edits, checks the draft is complete, then queues it. */
  async sendDraft(auth: AuthContext, id: string, patch: z.infer<typeof draftUpdateSchema>) {
    if (Object.keys(patch).length > 0) await this.updateDraft(auth, id, patch);
    const draft = await ownDraft(auth, id);
    const to = splitTo(draft.to);
    requireSendable({ subject: draft.subject, body: draft.bodyText ?? '', hasRecipient: to.length > 0 });
    const parent = await assertReplyParent(auth, draft.replyToId);
    const recipients = await resolveRecipients(auth, { to, cc: draft.cc, bcc: draft.bcc }, parent);
    const attached = await prisma.emailAttachment.aggregate({ where: { emailId: id }, _sum: { size: true } });
    if ((attached._sum.size ?? 0) > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', `Attachments may total at most ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024} MB`);
    }

    return producers.userMessage({
      draftId: id,
      from: { id: auth.id, name: await senderName(auth.id) },
      to: { id: recipients.toUserId, email: recipients.to.join(', ') },
      ...(recipients.cc.length ? { cc: recipients.cc } : {}),
      ...(recipients.bcc.length ? { bcc: recipients.bcc } : {}),
      subject: draft.subject,
      body: draft.bodyText ?? '',
      replyToId: draft.replyToId,
    });
  },

  /** A draft was never mail, so deleting it removes it outright, files included. */
  async deleteDraft(auth: AuthContext, id: string) {
    await ownDraft(auth, id);
    await prisma.emailLog.deleteMany({ where: { id, status: 'DRAFT' } });
  },

  /**
   * Stores an upload, unattached, for the caller to reference from a draft or
   * a send. Abandoned uploads (compose window closed) are swept on the way in.
   */
  async storeAttachment(auth: AuthContext, file: { originalname: string; mimetype: string; size: number; buffer: Buffer }) {
    const fileName = sanitizeFileName(file.originalname);
    if (BLOCKED_EXTENSIONS.has(path.extname(fileName).toLowerCase())) {
      throw new AppError(400, 'UNSUPPORTED_FILE_TYPE', 'This file type cannot be sent by email');
    }
    if (file.size === 0) throw new BadRequestError('The file is empty');

    await prisma.emailAttachment.deleteMany({
      where: { uploadedById: auth.id, emailId: null, createdAt: { lt: new Date(Date.now() - ORPHAN_TTL_MS) } },
    });
    return prisma.emailAttachment.create({
      data: {
        uploadedById: auth.id,
        fileName,
        // Client-controlled, so it is only kept when it at least looks like a MIME type.
        mimeType: /^[\w.+-]+\/[\w.+-]+$/.test(file.mimetype) ? file.mimetype.toLowerCase() : 'application/octet-stream',
        size: file.size,
        content: new Uint8Array(file.buffer),
      },
      select: { id: true, fileName: true, mimeType: true, size: true, createdAt: true },
    });
  },

  /** Removes an upload that has not been sent — unattached, or on your own draft. */
  async removeAttachment(auth: AuthContext, attachmentId: string) {
    const row = await prisma.emailAttachment.findUnique({
      where: { id: attachmentId },
      select: { uploadedById: true, email: { select: { status: true } } },
    });
    if (!row || row.uploadedById !== auth.id) throw new NotFoundError('Attachment');
    if (row.email && row.email.status !== 'DRAFT') throw new ConflictError('An attachment on a sent message cannot be removed');
    await prisma.emailAttachment.delete({ where: { id: attachmentId } });
  },
};

/** Keeps the name readable but never usable as a path or a header injection. */
function sanitizeFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').trim();
  return (clean || 'attachment').slice(-255);
}
