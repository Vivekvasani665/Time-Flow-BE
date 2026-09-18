import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedMail } from 'mailparser';
import { prisma } from '../src/lib/prisma';
import { logger } from '../src/lib/logger';
import { producers } from '../src/queue/producers';
import { buildMessageId } from '../src/queue/mailer';
import { closeQueues, getQueues } from '../src/queue/queues';
import { closeProducerConnection } from '../src/queue/connection';
import {
  baseSubject,
  extractMessageIds,
  findParent,
  importReply,
  normalizeMessageId,
  resolveImapAccount,
  syncInbox,
} from '../src/queue/inbound/inbox-sync';
import { api, loginAs, unique, userId, type Session } from './helpers';

let employee: Session;
let employeeId: string;

beforeAll(async () => {
  employee = await loginAs('employee');
  employeeId = await userId('employee@timeflow.dev');
});

beforeEach(() => vi.clearAllMocks());

afterAll(async () => {
  await closeQueues();
  await closeProducerConnection();
});

const ACCOUNT = 'team@gmail.com';

/** An outbound message the employee sent to someone outside the team. */
async function seedOutbound(over: Partial<{ to: string; subject: string; fromUserId: string | null }> = {}) {
  const id = randomUUID();
  return prisma.emailLog.create({
    data: {
      id,
      to: over.to ?? `${unique('client')}@example.com`,
      fromAddress: `TimeFlow <${ACCOUNT}>`,
      subject: over.subject ?? unique('Proposal'),
      template: 'message',
      status: 'SENT',
      fromUserId: over.fromUserId === undefined ? employeeId : over.fromUserId,
      messageId: buildMessageId(id, ACCOUNT),
    },
    select: { id: true, to: true, subject: true, messageId: true, direction: true, fromUserId: true, toUserId: true },
  });
}

function parsedReply(over: Partial<{ messageId: string; inReplyTo: string; from: string; name: string; subject: string }> = {}): ParsedMail {
  return {
    messageId: over.messageId ?? `<${unique('reply')}@mail.example.com>`,
    inReplyTo: over.inReplyTo,
    subject: over.subject ?? 'Re: Proposal',
    from: { value: [{ address: over.from ?? 'client@example.com', name: over.name ?? 'Casey Client' }], html: '', text: '' },
    text: 'Sounds good.\n\n> original',
    html: '<p>Sounds good.</p>',
    date: new Date('2026-09-17T10:00:00Z'),
    attachments: [],
    headers: new Map(),
    headerLines: [],
  } as unknown as ParsedMail;
}

describe('inbound — header helpers', () => {
  it('normalises Message-IDs to the bracketed form', () => {
    expect(normalizeMessageId('abc@x.com')).toBe('<abc@x.com>');
    expect(normalizeMessageId(' <abc@x.com> ')).toBe('<abc@x.com>');
    expect(normalizeMessageId('')).toBeNull();
    expect(normalizeMessageId(undefined)).toBeNull();
  });

  it('extracts every id from References / In-Reply-To values', () => {
    expect(extractMessageIds('<a@x> <b@y>\r\n <c@z>')).toEqual(['<a@x>', '<b@y>', '<c@z>']);
    expect(extractMessageIds(['<a@x>', '<b@y>'])).toEqual(['<a@x>', '<b@y>']);
    expect(extractMessageIds(undefined)).toEqual([]);
  });

  it('strips reply and forward prefixes when comparing subjects', () => {
    expect(baseSubject('Re: Fwd: RE:  Hello There')).toBe('hello there');
    expect(baseSubject('AW: Status')).toBe('status');
  });

  it('builds a Message-ID on the sender domain', () => {
    expect(buildMessageId('abc', 'TimeFlow <team@gmail.com>')).toBe('<abc@gmail.com>');
    expect(buildMessageId('abc', 'no-address')).toBe('<abc@timeflow.local>');
  });
});

describe('inbound — matching a reply to its original', () => {
  it('matches on In-Reply-To / References', async () => {
    const original = await seedOutbound();
    const parent = await findParent({ referencedIds: ['<unrelated@x>', original.messageId!], fromAddress: null, subject: null });
    expect(parent?.id).toBe(original.id);
  });

  it('falls back to a Re: from the recipient about the same subject', async () => {
    const original = await seedOutbound({ subject: unique('Quote request') });
    const parent = await findParent({ referencedIds: [], fromAddress: original.to.toUpperCase(), subject: `RE: ${original.subject}` });
    expect(parent?.id).toBe(original.id);
  });

  it('ignores mail that answers nothing TimeFlow sent', async () => {
    const original = await seedOutbound();
    expect(await findParent({ referencedIds: ['<nope@x>'], fromAddress: 'someone@else.com', subject: 'Re: Lunch?' })).toBeNull();
    // Same sender, but not a reply.
    expect(await findParent({ referencedIds: [], fromAddress: original.to, subject: original.subject })).toBeNull();
  });
});

describe('inbound — importing a reply', () => {
  it("lands in the original sender's inbox, threaded, and notifies them", async () => {
    const original = await seedOutbound();
    const parsed = parsedReply({ from: original.to, inReplyTo: original.messageId! });

    const result = await importReply({ parsed, parent: original, account: ACCOUNT, fallbackId: '<fallback@x>' });
    expect(result).toMatchObject({ ownerId: employeeId });

    const row = await prisma.emailLog.findUniqueOrThrow({ where: { id: result!.id } });
    expect(row).toMatchObject({
      direction: 'INBOUND',
      template: 'inbound',
      status: 'SENT',
      to: ACCOUNT,
      fromAddress: original.to,
      fromName: 'Casey Client',
      toUserId: employeeId,
      fromUserId: null,
      replyToId: original.id,
      messageId: parsed.messageId,
      inReplyTo: original.messageId,
      bodyText: 'Sounds good.\n\n> original',
      readAt: null,
    });

    expect(producers.activity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'email.received',
        notify: [expect.objectContaining({ userId: employeeId, type: 'email.received', link: `/emails?selected=${row.id}` })],
      }),
    );
  });

  it('imports each message once', async () => {
    const original = await seedOutbound();
    const parsed = parsedReply({ inReplyTo: original.messageId! });
    expect(await importReply({ parsed, parent: original, account: ACCOUNT, fallbackId: '<f1@x>' })).not.toBeNull();
    expect(await importReply({ parsed, parent: original, account: ACCOUNT, fallbackId: '<f1@x>' })).toBeNull();
    expect(await prisma.emailLog.count({ where: { messageId: parsed.messageId } })).toBe(1);
  });

  it('uses the fallback id when the message has none', async () => {
    const original = await seedOutbound();
    const fallbackId = `<${unique('imap')}@timeflow.local>`;
    const parsed = { ...parsedReply(), messageId: undefined } as ParsedMail;
    const result = await importReply({ parsed, parent: original, account: ACCOUNT, fallbackId });
    expect((await prisma.emailLog.findUniqueOrThrow({ where: { id: result!.id } })).messageId).toBe(fallbackId);
  });

  it('keeps replies to system mail out of every personal inbox', async () => {
    const original = await seedOutbound({ fromUserId: null });
    const result = await importReply({ parsed: parsedReply(), parent: original, account: ACCOUNT, fallbackId: '<f2@x>' });
    expect(result).toMatchObject({ ownerId: null });
    expect(producers.activity).not.toHaveBeenCalled();
  });

  it('never touches a real mailbox from tests', async () => {
    // .env.test pins the log transport and switches the poller off.
    expect(await resolveImapAccount()).toBeNull();
    expect(await syncInbox(logger)).toEqual({ skipped: 'disabled' });
  });
});

describe('inbound — mailbox API', () => {
  async function seedInbound() {
    const original = await seedOutbound();
    const result = await importReply({
      parsed: parsedReply({ from: original.to, inReplyTo: original.messageId! }),
      parent: original,
      account: ACCOUNT,
      fallbackId: '<unused@x>',
    });
    return { original, replyId: result!.id };
  }

  it('shows the reply in Inbox with who it is from', async () => {
    const { original, replyId } = await seedInbound();
    const res = await employee.auth(api().get('/api/emails').query({ box: 'inbox', search: original.to }));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({ id: replyId, direction: 'INBOUND', fromAddress: original.to, fromName: 'Casey Client', fromUser: null }),
    ]);
  });

  it('lets the recipient answer back without emails.send_external', async () => {
    const { original, replyId } = await seedInbound();
    const res = await employee
      .auth(api().post('/api/emails'))
      .send({ toEmail: original.to, subject: 'Re: Proposal', body: 'Great, thanks.', replyToId: replyId });
    expect(res.status).toBe(201);
    expect(producers.userMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: { id: null, email: original.to }, replyToId: replyId }),
    );
  });

  it('does not let that reply be redirected to another outside address', async () => {
    const { replyId } = await seedInbound();
    const res = await employee
      .auth(api().post('/api/emails'))
      .send({ toEmail: 'someone-else@example.com', subject: 'Re: Proposal', body: 'Hi', replyToId: replyId });
    expect(res.status).toBe(403);
    expect(producers.userMessage).not.toHaveBeenCalled();
  });

  it('queues an immediate inbox check on request, collapsing repeats', async () => {
    const queue = getQueues().inbox;
    await queue.remove('inbox-sync-manual');
    const first = await employee.auth(api().post('/api/emails/sync'));
    const second = await employee.auth(api().post('/api/emails/sync'));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await queue.getJob('inbox-sync-manual')).toMatchObject({ data: { reason: 'manual' } });
    await queue.remove('inbox-sync-manual');
  });
});
