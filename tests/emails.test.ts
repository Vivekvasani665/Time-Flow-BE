import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { producers } from '../src/queue/producers';
import { api, loginAs, unique, userId, type Session } from './helpers';

let superadmin: Session;
let employee: Session;
let kai: Session;
let kaiId: string;
let employeeId: string;

beforeAll(async () => {
  [superadmin, employee, kai] = await Promise.all([
    loginAs('superadmin'),
    loginAs('employee'),
    loginAs('kai.morgan@timeflow.dev'),
  ]);
  [employeeId, kaiId] = await Promise.all([userId('employee@timeflow.dev'), userId('kai.morgan@timeflow.dev')]);
});

beforeEach(() => vi.clearAllMocks());

/**
 * Writes an outbox row directly. The producers are mocked in tests/setup.ts, so
 * mailbox reads are exercised against rows rather than a live queue.
 */
async function seedMessage(over: Partial<{ toUserId: string | null; fromUserId: string | null; subject: string; readAt: Date | null }> = {}) {
  return prisma.emailLog.create({
    data: {
      to: 'kai.morgan@timeflow.dev',
      fromAddress: 'TimeFlow <no-reply@timeflow.dev>',
      subject: over.subject ?? unique('Subject'),
      template: 'message',
      bodyHtml: '<p>hello</p>',
      bodyText: 'hello',
      status: 'SENT',
      toUserId: over.toUserId === undefined ? kaiId : over.toUserId,
      fromUserId: over.fromUserId === undefined ? employeeId : over.fromUserId,
      readAt: over.readAt ?? null,
    },
    select: { id: true, subject: true },
  });
}

describe('Mailbox — sending', () => {
  it('queues a message to a team member and records the sender as the author', async () => {
    const res = await employee.auth(api().post('/api/emails')).send({ toUserId: kaiId, subject: 'Standup notes', body: 'Shipping today.' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, message: 'Message sent' });
    expect(producers.userMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        from: { id: employeeId, name: 'Leo Park' },
        to: { id: kaiId, email: 'kai.morgan@timeflow.dev' },
        subject: 'Standup notes',
        body: 'Shipping today.',
        replyToId: null,
      }),
    );
  });

  it('rejects a missing subject or body', async () => {
    const noSubject = await employee.auth(api().post('/api/emails')).send({ toUserId: kaiId, subject: '  ', body: 'x' });
    const noBody = await employee.auth(api().post('/api/emails')).send({ toUserId: kaiId, subject: 'x', body: '' });
    expect(noSubject.status).toBe(400);
    expect(noBody.status).toBe(400);
    expect(producers.userMessage).not.toHaveBeenCalled();
  });

  it('rejects an unknown recipient', async () => {
    const res = await employee.auth(api().post('/api/emails')).send({
      toUserId: '00000000-0000-4000-8999-000000000999',
      subject: 'Hello',
      body: 'Anyone there?',
    });
    expect(res.status).toBe(404);
  });

  it('refuses an address belonging to a deactivated account', async () => {
    const res = await employee.auth(api().post('/api/emails')).send({ toEmail: 'nina.volkova@timeflow.dev', subject: 'Hi', body: 'Hi' });
    expect(res.status).toBe(400);
  });

  it('needs emails.send_external to mail an address outside the team', async () => {
    const outside = { toEmail: `${unique('stranger')}@example.com`, subject: 'Hi', body: 'Hi' };
    expect((await employee.auth(api().post('/api/emails')).send(outside)).status).toBe(403);
    expect((await superadmin.auth(api().post('/api/emails')).send(outside)).status).toBe(201);
  });

  it('holds composing to a per-user budget', async () => {
    // Guards the one mailbox route that emits real mail from the org identity.
    // The header proves the compose budget is in force, not the global API one.
    const { env } = await import('../src/config/env');
    const res = await employee.auth(api().post('/api/emails')).send({ toUserId: kaiId, subject: 'Hi', body: 'Hi' });
    expect(res.headers['ratelimit-limit']).toBe(String(env.RATE_LIMIT_EMAIL_MAX));
    expect(env.RATE_LIMIT_EMAIL_MAX).not.toBe(env.RATE_LIMIT_API_MAX);
  });

  it('requires authentication', async () => {
    expect((await api().post('/api/emails').send({ toUserId: kaiId, subject: 'x', body: 'x' })).status).toBe(401);
    expect((await api().get('/api/emails')).status).toBe(401);
  });
});

describe('Mailbox — replies', () => {
  it('threads a reply under a message the sender is a party to', async () => {
    const original = await seedMessage();
    const res = await kai.auth(api().post('/api/emails')).send({
      toUserId: employeeId,
      subject: `Re: ${original.subject}`,
      body: 'Got it.',
      replyToId: original.id,
    });

    expect(res.status).toBe(201);
    expect(producers.userMessage).toHaveBeenCalledWith(expect.objectContaining({ replyToId: original.id }));
  });

  it('refuses to thread a reply under someone else’s message', async () => {
    const stranger = await seedMessage({ toUserId: null, fromUserId: null });
    const res = await kai.auth(api().post('/api/emails')).send({
      toUserId: employeeId,
      subject: 'Re: nothing',
      body: 'Sneaking in',
      replyToId: stranger.id,
    });
    expect(res.status).toBe(403);
    expect(producers.userMessage).not.toHaveBeenCalled();
  });
});

describe('Mailbox — folders', () => {
  it('shows a message in the recipient’s inbox and the sender’s sent folder', async () => {
    const msg = await seedMessage();

    const inbox = await kai.auth(api().get('/api/emails').query({ box: 'inbox', search: msg.subject }));
    expect(inbox.status).toBe(200);
    expect(inbox.body.data.map((m: { id: string }) => m.id)).toContain(msg.id);
    expect(inbox.body.meta).toMatchObject({ page: 1, total: 1 });

    const sent = await employee.auth(api().get('/api/emails').query({ box: 'sent', search: msg.subject }));
    expect(sent.body.data.map((m: { id: string }) => m.id)).toContain(msg.id);

    // The other direction: it is in neither of the counterpart's folders.
    const wrongBox = await kai.auth(api().get('/api/emails').query({ box: 'sent', search: msg.subject }));
    expect(wrongBox.body.data).toHaveLength(0);
  });

  it('filters unread and paginates', async () => {
    const subject = unique('Unread');
    await seedMessage({ subject });
    await seedMessage({ subject: `${subject} read`, readAt: new Date() });

    const unread = await kai.auth(api().get('/api/emails').query({ box: 'inbox', search: subject, unreadOnly: 'true' }));
    expect(unread.body.data).toHaveLength(1);

    const page = await kai.auth(api().get('/api/emails').query({ box: 'inbox', search: subject, limit: 1, page: 2 }));
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta).toMatchObject({ page: 2, limit: 1, total: 2, totalPages: 2 });
  });

  it('refuses box=all without emails.view_all', async () => {
    expect((await kai.auth(api().get('/api/emails').query({ box: 'all' }))).status).toBe(403);
    expect((await superadmin.auth(api().get('/api/emails').query({ box: 'all' }))).status).toBe(200);
  });

  it('counts only the caller’s own unread mail in stats', async () => {
    const before = await kai.auth(api().get('/api/emails/stats'));
    await seedMessage();
    const after = await kai.auth(api().get('/api/emails/stats'));
    expect(after.body.data.unread).toBe(before.body.data.unread + 1);
    expect(after.body.data.scope).toBe('own');
  });
});

describe('Mailbox — reading', () => {
  it('returns the body to either party and marks it read', async () => {
    const msg = await seedMessage();

    const detail = await kai.auth(api().get(`/api/emails/${msg.id}`));
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ id: msg.id, bodyText: 'hello', readAt: null });
    expect((await employee.auth(api().get(`/api/emails/${msg.id}`))).status).toBe(200);

    const read = await kai.auth(api().patch(`/api/emails/${msg.id}/read`)).send({ read: true });
    expect(read.status).toBe(200);
    expect(read.body.data.readAt).not.toBeNull();

    const unread = await kai.auth(api().patch(`/api/emails/${msg.id}/read`)).send({ read: false });
    expect(unread.body.data.readAt).toBeNull();
  });

  it('keeps one user out of another user’s mail', async () => {
    const msg = await seedMessage({ toUserId: employeeId, fromUserId: null });

    expect((await kai.auth(api().get(`/api/emails/${msg.id}`))).status).toBe(403);
    expect((await kai.auth(api().patch(`/api/emails/${msg.id}/read`)).send({ read: true })).status).toBe(403);
    // ...but an administrator with emails.view_all may read it.
    expect((await superadmin.auth(api().get(`/api/emails/${msg.id}`))).status).toBe(200);
  });

  it('only the recipient has a read state', async () => {
    const msg = await seedMessage();
    expect((await employee.auth(api().patch(`/api/emails/${msg.id}/read`)).send({ read: true })).status).toBe(403);
  });
});

describe('Mailbox — deleting', () => {
  it('removes the message from one side only', async () => {
    const msg = await seedMessage();

    const del = await kai.auth(api().delete(`/api/emails/${msg.id}`));
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ success: true, message: 'Message deleted' });

    // Gone from the recipient's inbox, and no longer fetchable by id...
    const inbox = await kai.auth(api().get('/api/emails').query({ box: 'inbox', search: msg.subject }));
    expect(inbox.body.data).toHaveLength(0);
    expect((await kai.auth(api().get(`/api/emails/${msg.id}`))).status).toBe(403);

    // ...while the sender still has their copy, and the row itself survives.
    const sent = await employee.auth(api().get('/api/emails').query({ box: 'sent', search: msg.subject }));
    expect(sent.body.data).toHaveLength(1);
    expect(await prisma.emailLog.findUnique({ where: { id: msg.id }, select: { deletedByToAt: true } })).toMatchObject({
      deletedByToAt: expect.any(Date),
    });
  });

  it('is idempotent for a message already deleted from that side', async () => {
    const msg = await seedMessage();
    expect((await kai.auth(api().delete(`/api/emails/${msg.id}`))).status).toBe(200);
    expect((await kai.auth(api().delete(`/api/emails/${msg.id}`))).status).toBe(200);
  });

  it('will not let a bystander — or an admin — delete someone else’s message', async () => {
    const msg = await seedMessage({ toUserId: employeeId, fromUserId: null });
    expect((await kai.auth(api().delete(`/api/emails/${msg.id}`))).status).toBe(403);
    // emails.view_all is a read permission; it does not extend to deleting.
    expect((await superadmin.auth(api().delete(`/api/emails/${msg.id}`))).status).toBe(403);
    expect(await prisma.emailLog.findUnique({ where: { id: msg.id }, select: { deletedByToAt: true } })).toMatchObject({ deletedByToAt: null });
  });
});
