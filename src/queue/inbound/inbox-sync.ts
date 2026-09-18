import { createHash } from 'node:crypto';
import { Prisma, type EmailDirection } from '@prisma/client';
import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import type { Logger } from '../../lib/logger';
import { mailSettingsService } from '../../modules/emails/mail-settings.service';
import { activityService } from '../../modules/activity-logs/activity.service';
import { resolveEnvTransport } from '../mailer';

/**
 * Inbound mail. TimeFlow sends from one account (Gmail today); when someone
 * answers, the reply lands in that account's inbox. This reads the inbox over
 * IMAP and imports only messages whose In-Reply-To / References point at a
 * Message-ID TimeFlow sent — the account's other mail is never downloaded.
 */

const MAILBOX = 'INBOX';
/** First run for an account: how far back to look for replies. */
const INITIAL_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
/** Envelopes inspected per poll; the rest are picked up on the next one. */
const MAX_PER_RUN = 500;
/** Subject-based fallback only considers recent outbound mail. */
const SUBJECT_MATCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Bodies above this are kept as plain text only. */
const MAX_HTML_BYTES = 1024 * 1024;

/** SMTP host → the IMAP host of the same provider. */
const IMAP_HOSTS: Record<string, string> = { 'smtp.gmail.com': 'imap.gmail.com' };

export type ImapAccount = { host: string; port: number; user: string; pass: string };

export type SyncResult =
  | { skipped: 'disabled' | 'no-imap-account' }
  | { account: string; scanned: number; imported: number; lastUid: number };

type ParentRow = {
  id: string;
  direction: EmailDirection;
  fromUserId: string | null;
  toUserId: string | null;
  messageId: string | null;
};

const parentSelect = { id: true, direction: true, fromUserId: true, toUserId: true, messageId: true } as const;

/** The same account TimeFlow sends from: app settings first, then the environment. */
export async function resolveImapAccount(): Promise<ImapAccount | null> {
  const configured = await mailSettingsService.getTransportConfig().catch(() => null);
  if (configured) {
    const host = IMAP_HOSTS[configured.host];
    return host ? { host, port: 993, user: configured.auth.user, pass: configured.auth.pass } : null;
  }

  const resolved = resolveEnvTransport();
  const opts = resolved.options as { host?: string; auth?: { user: string; pass: string } };
  const host = opts.host ? IMAP_HOSTS[opts.host] : undefined;
  if (!host || !opts.auth) return null;
  return { host, port: 993, user: opts.auth.user, pass: opts.auth.pass };
}

/** `<id>` form, which is how both nodemailer and mailparser report Message-IDs. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const bare = trimmed.replace(/^<|>$/g, '');
  return bare ? `<${bare}>`.slice(0, 512) : null;
}

/** Every Message-ID a header value mentions, in order. */
export function extractMessageIds(value: string | string[] | null | undefined): string[] {
  const text = Array.isArray(value) ? value.join(' ') : (value ?? '');
  return (text.match(/<[^<>\s]+>/g) ?? []).map((id) => id.slice(0, 512));
}

/** "Re: Fwd: RE: Hello" → "hello", so a reply's subject can be compared to the original's. */
export function baseSubject(subject: string): string {
  return subject
    .replace(/^\s*((re|fwd?|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();
}

/**
 * Finds the TimeFlow message a reply answers. Headers first — they are exact.
 * If a client dropped them, fall back to "a Re: from the address we recently
 * wrote to, about the same subject".
 */
export async function findParent(input: {
  referencedIds: string[];
  fromAddress: string | null;
  subject: string | null;
}): Promise<ParentRow | null> {
  if (input.referencedIds.length > 0) {
    const byHeader = await prisma.emailLog.findFirst({
      where: { messageId: { in: input.referencedIds } },
      select: parentSelect,
      orderBy: { createdAt: 'desc' },
    });
    if (byHeader) return byHeader;
  }

  if (!input.fromAddress || !input.subject || !/^\s*re\s*:/i.test(input.subject)) return null;
  const wanted = baseSubject(input.subject);
  if (!wanted) return null;
  const candidates = await prisma.emailLog.findMany({
    where: {
      direction: 'OUTBOUND',
      status: 'SENT',
      to: { equals: input.fromAddress, mode: 'insensitive' },
      createdAt: { gte: new Date(Date.now() - SUBJECT_MATCH_WINDOW_MS) },
    },
    select: { ...parentSelect, subject: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const match = candidates.find((c) => baseSubject(c.subject) === wanted);
  if (!match) return null;
  const { subject: _subject, ...parent } = match;
  return parent;
}

/**
 * Stores one reply and tells its owner. Returns null when it was already
 * imported — by an earlier poll or, concurrently, by another worker.
 */
export async function importReply(input: {
  parsed: ParsedMail;
  parent: ParentRow;
  account: string;
  /** Used only when the message carries no Message-ID of its own. */
  fallbackId: string;
}): Promise<{ id: string; ownerId: string | null } | null> {
  const { parsed, parent, account } = input;
  const messageId = normalizeMessageId(parsed.messageId) ?? input.fallbackId;

  if (await prisma.emailLog.findUnique({ where: { messageId }, select: { id: true } })) return null;

  const sender = parsed.from?.value[0];
  const fromAddress = (sender?.address ?? 'unknown').toLowerCase().slice(0, 254);
  const fromName = sender?.name?.trim().slice(0, 120) || null;
  const subject = (parsed.subject?.trim() || '(no subject)').slice(0, 200);
  const html = typeof parsed.html === 'string' && Buffer.byteLength(parsed.html) <= MAX_HTML_BYTES ? parsed.html : null;

  // A reply belongs to whoever wrote the message it answers. Replies to
  // transactional mail have no such person, so they live only in All Mail.
  const ownerId = parent.direction === 'OUTBOUND' ? parent.fromUserId : parent.toUserId;

  let row: { id: string };
  try {
    row = await prisma.emailLog.create({
      data: {
        direction: 'INBOUND',
        template: 'inbound',
        status: 'SENT',
        to: account.slice(0, 254),
        fromAddress,
        fromName,
        subject,
        bodyText: parsed.text ?? null,
        bodyHtml: html,
        toUserId: ownerId,
        replyToId: parent.id,
        messageId,
        inReplyTo: normalizeMessageId(parsed.inReplyTo),
        sentAt: parsed.date ?? new Date(),
      },
      select: { id: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  }

  if (ownerId) {
    await activityService.record(
      { actorId: null, ip: null, userAgent: null },
      {
        action: 'email.received',
        entity: 'email',
        entityId: row.id,
        description: `Reply received from ${fromAddress}: ${subject}`,
        metadata: { from: fromAddress, replyToId: parent.id },
        notify: [
          {
            userId: ownerId,
            type: 'email.received',
            title: `New reply from ${fromName ?? fromAddress}`,
            body: subject,
            link: `/emails?selected=${row.id}`,
          },
        ],
      },
    );
  }
  return { id: row.id, ownerId };
}

/** Stable stand-in id for a message that arrived without a Message-ID header. */
function fallbackMessageId(account: string, uidValidity: bigint, uid: number): string {
  const hash = createHash('sha256').update(`${account}:${uidValidity}:${uid}`).digest('hex').slice(0, 32);
  return `<imap-${hash}@timeflow.local>`;
}

function referencedIdsOf(msg: FetchMessageObject): string[] {
  const headers = msg.headers?.toString('utf8') ?? '';
  // Header folding puts long References values on continuation lines.
  const references = /^references:\s*((?:.*(?:\r?\n[ \t].*)*))/im.exec(headers)?.[1] ?? '';
  const ids = [...extractMessageIds(msg.envelope?.inReplyTo), ...extractMessageIds(references)];
  return [...new Set(ids)];
}

/** One poll: read new inbox messages, import the ones that answer TimeFlow mail. */
export async function syncInbox(log: Logger, account?: ImapAccount | null): Promise<SyncResult> {
  if (!env.INBOUND_SYNC_ENABLED) return { skipped: 'disabled' };
  const target = account === undefined ? await resolveImapAccount() : account;
  if (!target) return { skipped: 'no-imap-account' };

  const client = new ImapFlow({
    host: target.host,
    port: target.port,
    secure: true,
    auth: { user: target.user, pass: target.pass },
    logger: false,
  });
  // ImapFlow emits 'error' on socket trouble; unhandled, that would crash the worker.
  client.on('error', (err: Error) => log.warn({ err: err.message }, 'IMAP connection error'));

  await client.connect();
  try {
    const lock = await client.getMailboxLock(MAILBOX);
    try {
      const box = client.mailbox;
      if (!box) throw new Error(`Could not open ${MAILBOX}`);

      const stateId = `${target.user.toLowerCase()}:${MAILBOX}`.slice(0, 320);
      const state = await prisma.mailboxSyncState.findUnique({ where: { id: stateId } });
      const fresh = !state || state.uidValidity !== box.uidValidity;

      let uids: number[] = [];
      if (fresh) {
        uids = (await client.search({ since: new Date(Date.now() - INITIAL_LOOKBACK_MS) }, { uid: true })) || [];
      } else if (box.uidNext > state.lastUid + 1) {
        uids = (await client.search({ uid: `${state.lastUid + 1}:*` }, { uid: true })) || [];
      }
      // `N:*` always matches the newest message, even when its UID is below N.
      const floor = fresh ? 0 : state.lastUid;
      const batch = uids.filter((uid) => uid > floor).sort((a, b) => a - b).slice(0, MAX_PER_RUN);

      let lastUid = floor;
      let imported = 0;
      if (batch.length > 0) {
        // Envelopes and threading headers only — bodies are fetched for replies alone.
        const envelopes = await client.fetchAll(batch, { uid: true, envelope: true, headers: ['references'] }, { uid: true });
        for (const msg of envelopes.sort((a, b) => a.uid - b.uid)) {
          try {
            const from = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? null;
            const parent = await findParent({
              referencedIds: referencedIdsOf(msg),
              fromAddress: from,
              subject: msg.envelope?.subject ?? null,
            });
            if (parent) {
              const full = await client.fetchOne(String(msg.uid), { source: true }, { uid: true });
              if (full && full.source) {
                const parsed = await simpleParser(full.source);
                const result = await importReply({
                  parsed,
                  parent,
                  account: target.user,
                  fallbackId: fallbackMessageId(target.user, box.uidValidity, msg.uid),
                });
                if (result) {
                  imported += 1;
                  log.info({ emailLogId: result.id, from, replyToId: parent.id }, 'reply imported');
                }
              }
            }
          } catch (err) {
            // One unreadable message must not wedge the mailbox; it is skipped.
            log.error({ err, uid: msg.uid }, 'could not import inbound message; skipping it');
          }
          lastUid = Math.max(lastUid, msg.uid);
        }
      }
      // A first run with nothing recent still records where "now" is.
      if (fresh && batch.length === 0) lastUid = box.uidNext - 1;

      if (fresh) {
        await prisma.mailboxSyncState.upsert({
          where: { id: stateId },
          create: { id: stateId, uidValidity: box.uidValidity, lastUid },
          update: { uidValidity: box.uidValidity, lastUid },
        });
      } else if (lastUid > state.lastUid) {
        // Conditional, so two workers polling at once can never move it backwards.
        await prisma.mailboxSyncState.updateMany({
          where: { id: stateId, uidValidity: box.uidValidity, lastUid: { lt: lastUid } },
          data: { lastUid },
        });
      }

      return { account: target.user, scanned: batch.length, imported, lastUid };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}
