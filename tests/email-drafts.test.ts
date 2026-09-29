import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { producers } from '../src/queue/producers';
import { api, loginAs, unique, userId, type Session } from './helpers';

let superadmin: Session;
let employee: Session;
let kai: Session;
let zoe: Session;
let employeeId: string;
let kaiId: string;

beforeAll(async () => {
  [superadmin, employee, kai, zoe] = await Promise.all([
    loginAs('superadmin'),
    loginAs('employee'),
    loginAs('kai.morgan@timeflow.dev'),
    loginAs('zoe.chen@timeflow.dev'),
  ]);
  [employeeId, kaiId] = await Promise.all([userId('employee@timeflow.dev'), userId('kai.morgan@timeflow.dev')]);
});

beforeEach(() => vi.clearAllMocks());

const ids = (res: { body: { data: { id: string }[] } }) => res.body.data.map((m) => m.id);

async function saveDraft(session: Session, body: Record<string, unknown> = {}) {
  const res = await session.auth(api().post('/api/emails')).send({ draft: true, subject: unique('Draft'), ...body });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function upload(session: Session, name = 'report.pdf', content = Buffer.from('%PDF-1.4 hello')) {
  return session.auth(api().post('/api/emails/attachments')).attach('file', content, { filename: name, contentType: 'application/pdf' });
}

describe('Mailbox — drafts', () => {
  it('saves a half-written draft to Drafts only, private to its author', async () => {
    const res = await employee.auth(api().post('/api/emails')).send({ draft: true, to: ['kai.morgan@timeflow.dev'], subject: '', body: 'WIP' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ message: 'Draft saved', data: { status: 'DRAFT' } });
    const id = res.body.data.id as string;
    // Nothing is sent by saving.
    expect(producers.userMessage).not.toHaveBeenCalled();

    expect(ids(await employee.auth(api().get('/api/emails/drafts')))).toContain(id);
    expect(ids(await employee.auth(api().get('/api/emails/sent')))).not.toContain(id);
    // Not in the would-be recipient's inbox, and not even in the admin audit view.
    expect(ids(await kai.auth(api().get('/api/emails/inbox')))).not.toContain(id);
    expect(ids(await superadmin.auth(api().get('/api/emails').query({ box: 'all', limit: 100 })))).not.toContain(id);
    expect((await kai.auth(api().get(`/api/emails/${id}`))).status).toBe(404);
    expect((await superadmin.auth(api().get(`/api/emails/${id}`))).status).toBe(404);

    const own = await employee.auth(api().get(`/api/emails/${id}`));
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ status: 'DRAFT', to: 'kai.morgan@timeflow.dev', bodyText: 'WIP' });
  });

  it('counts the caller’s drafts in the stats', async () => {
    await saveDraft(zoe);
    const res = await zoe.auth(api().get('/api/emails/stats'));
    expect(res.body.data.drafts).toBeGreaterThanOrEqual(1);
  });

  it('updates only the fields given, and only for the author', async () => {
    const id = await saveDraft(employee, { to: ['kai.morgan@timeflow.dev'], body: 'first' });

    const res = await employee.auth(api().patch(`/api/emails/${id}`)).send({ subject: 'Project Update', cc: ['zoe.chen@timeflow.dev'] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ subject: 'Project Update', bodyText: 'first', to: 'kai.morgan@timeflow.dev', cc: ['zoe.chen@timeflow.dev'] });

    expect((await kai.auth(api().patch(`/api/emails/${id}`)).send({ subject: 'hijack' })).status).toBe(404);
  });

  it('sends a complete draft, carrying its cc and bcc', async () => {
    const id = await saveDraft(employee, {
      to: ['kai.morgan@timeflow.dev'],
      cc: ['zoe.chen@timeflow.dev'],
      bcc: ['manager@timeflow.dev'],
      subject: 'Standup',
      body: 'Notes attached.',
    });

    const res = await employee.auth(api().post(`/api/emails/${id}/send`)).send({});
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Message sent');
    expect(producers.userMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: id,
        from: { id: employeeId, name: 'Leo Park' },
        to: { id: kaiId, email: 'kai.morgan@timeflow.dev' },
        cc: ['zoe.chen@timeflow.dev'],
        bcc: ['manager@timeflow.dev'],
        subject: 'Standup',
        body: 'Notes attached.',
      }),
    );
  });

  it('applies last edits passed to send', async () => {
    const id = await saveDraft(employee, { body: 'Hello' });
    const res = await employee.auth(api().post(`/api/emails/${id}/send`)).send({ to: ['kai.morgan@timeflow.dev'], subject: 'Final' });
    expect(res.status).toBe(200);
    expect(producers.userMessage).toHaveBeenCalledWith(expect.objectContaining({ draftId: id, subject: 'Final', body: 'Hello' }));
  });

  it('refuses to send an incomplete draft', async () => {
    const noRecipient = await saveDraft(employee, { subject: 'x', body: 'x' });
    const noBody = await saveDraft(employee, { to: ['kai.morgan@timeflow.dev'], subject: 'x' });
    expect((await employee.auth(api().post(`/api/emails/${noRecipient}/send`)).send({})).status).toBe(400);
    expect((await employee.auth(api().post(`/api/emails/${noBody}/send`)).send({})).status).toBe(400);
    expect(producers.userMessage).not.toHaveBeenCalled();
  });

  it('checks recipients at send time, not save time', async () => {
    // Anyone may save a draft to an outside address; sending it still needs the permission.
    const id = await saveDraft(employee, { to: ['client@example.com'], subject: 'Hi', body: 'Hi' });
    expect((await employee.auth(api().post(`/api/emails/${id}/send`)).send({})).status).toBe(403);
    expect(producers.userMessage).not.toHaveBeenCalled();
  });

  it('will not send or edit a message that has already gone', async () => {
    const id = await saveDraft(employee, { to: ['kai.morgan@timeflow.dev'], subject: 'x', body: 'x' });
    await prisma.emailLog.update({ where: { id }, data: { status: 'QUEUED' } });
    expect((await employee.auth(api().post(`/api/emails/${id}/send`)).send({})).status).toBe(409);
    expect((await employee.auth(api().patch(`/api/emails/${id}`)).send({ subject: 'late' })).status).toBe(409);
  });

  it('discards a draft outright, attachments included', async () => {
    const file = await upload(employee);
    const id = await saveDraft(employee, { attachmentIds: [file.body.data.id] });

    const res = await employee.auth(api().delete(`/api/emails/${id}`));
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Draft discarded');
    expect(await prisma.emailLog.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.emailAttachment.findUnique({ where: { id: file.body.data.id } })).toBeNull();
  });
});

describe('Mailbox — multiple recipients', () => {
  it('sends one message to several addresses, owned by the first team member on To', async () => {
    const res = await superadmin.auth(api().post('/api/emails')).send({
      to: ['client@example.com', 'kai.morgan@timeflow.dev'],
      cc: ['zoe.chen@timeflow.dev', 'KAI.MORGAN@timeflow.dev'],
      subject: 'Project Update',
      body: 'Your project has been updated.',
    });
    expect(res.status).toBe(201);
    expect(producers.userMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { id: kaiId, email: 'client@example.com, kai.morgan@timeflow.dev' },
        // Kai is already on To, so the duplicate on Cc is dropped.
        cc: ['zoe.chen@timeflow.dev'],
      }),
    );
  });

  it('keeps the original single-recipient form working alongside the lists', async () => {
    const res = await employee.auth(api().post('/api/emails')).send({ toUserId: kaiId, cc: ['zoe.chen@timeflow.dev'], subject: 'Hi', body: 'Hi' });
    expect(res.status).toBe(201);
    expect(producers.userMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: { id: kaiId, email: 'kai.morgan@timeflow.dev' }, cc: ['zoe.chen@timeflow.dev'] }),
    );
  });

  it('needs emails.send_external for an outside address on any line, including bcc', async () => {
    const res = await employee.auth(api().post('/api/emails')).send({ toUserId: kaiId, bcc: ['spy@example.com'], subject: 'Hi', body: 'Hi' });
    expect(res.status).toBe(403);
  });

  it('refuses a deactivated account on cc', async () => {
    const res = await employee.auth(api().post('/api/emails')).send({ toUserId: kaiId, cc: ['nina.volkova@timeflow.dev'], subject: 'Hi', body: 'Hi' });
    expect(res.status).toBe(400);
  });

  it('shows bcc to the sender only', async () => {
    const msg = await prisma.emailLog.create({
      data: {
        to: 'kai.morgan@timeflow.dev',
        bcc: ['manager@timeflow.dev'],
        fromAddress: 'TimeFlow <no-reply@timeflow.dev>',
        subject: unique('Bcc'),
        template: 'message',
        status: 'SENT',
        toUserId: kaiId,
        fromUserId: employeeId,
      },
    });
    expect((await employee.auth(api().get(`/api/emails/${msg.id}`))).body.data.bcc).toEqual(['manager@timeflow.dev']);
    expect((await kai.auth(api().get(`/api/emails/${msg.id}`))).body.data.bcc).toEqual([]);
  });
});

describe('Mailbox — attachments', () => {
  it('uploads a file and attaches it to a sent message', async () => {
    const file = await upload(employee, 'Résumé.pdf');
    expect(file.status).toBe(201);
    expect(file.body.data).toMatchObject({ fileName: 'Résumé.pdf', mimeType: 'application/pdf', size: 14 });

    const res = await employee.auth(api().post('/api/emails')).send({ toUserId: kaiId, subject: 'Report', body: 'See attached', attachmentIds: [file.body.data.id] });
    expect(res.status).toBe(201);
    expect(producers.userMessage).toHaveBeenCalledWith(expect.objectContaining({ attachmentIds: [file.body.data.id] }));
  });

  it('refuses file types mail providers block', async () => {
    const res = await upload(employee, 'setup.exe');
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it('will not let you attach someone else’s upload', async () => {
    const theirs = await upload(kai);
    const res = await employee.auth(api().post('/api/emails')).send({ toUserId: kaiId, subject: 'x', body: 'x', attachmentIds: [theirs.body.data.id] });
    expect(res.status).toBe(404);
    expect(producers.userMessage).not.toHaveBeenCalled();
  });

  it('replaces a draft’s attachments on update and lists them on the draft', async () => {
    const [a, b] = await Promise.all([upload(employee, 'a.pdf'), upload(employee, 'b.pdf')]);
    const id = await saveDraft(employee, { attachmentIds: [a.body.data.id] });

    const res = await employee.auth(api().patch(`/api/emails/${id}`)).send({ attachmentIds: [b.body.data.id] });
    expect(res.status).toBe(200);
    expect(res.body.data.attachments.map((x: { fileName: string }) => x.fileName)).toEqual(['b.pdf']);
    // The one taken off is gone, not left orphaned.
    expect(await prisma.emailAttachment.findUnique({ where: { id: a.body.data.id } })).toBeNull();
  });

  it('lets the parties download an attachment, and nobody else', async () => {
    const file = await upload(employee, 'notes.pdf', Buffer.from('%PDF-1.4 secret'));
    const msg = await prisma.emailLog.create({
      data: {
        to: 'kai.morgan@timeflow.dev',
        fromAddress: 'TimeFlow <no-reply@timeflow.dev>',
        subject: unique('Files'),
        template: 'message',
        status: 'SENT',
        toUserId: kaiId,
        fromUserId: employeeId,
      },
    });
    await prisma.emailAttachment.update({ where: { id: file.body.data.id }, data: { emailId: msg.id } });
    const path = `/api/emails/${msg.id}/attachments/${file.body.data.id}`;

    const got = await kai.auth(api().get(path)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(got.status).toBe(200);
    expect(got.headers['content-disposition']).toMatch(/^attachment; filename="notes.pdf"/);
    expect((got.body as Buffer).toString()).toBe('%PDF-1.4 secret');

    expect((await zoe.auth(api().get(path))).status).toBe(404);
    // The detail view lists it.
    expect((await kai.auth(api().get(`/api/emails/${msg.id}`))).body.data.attachments).toEqual([
      { id: file.body.data.id, fileName: 'notes.pdf', mimeType: 'application/pdf', size: 15 },
    ]);
  });

  it('removes an unsent upload, but not one already sent', async () => {
    const loose = await upload(employee);
    expect((await employee.auth(api().delete(`/api/emails/attachments/${loose.body.data.id}`))).status).toBe(200);

    const sent = await upload(employee);
    const msg = await prisma.emailLog.create({
      data: { to: 'x@example.com', fromAddress: 'a', subject: 's', template: 'message', status: 'SENT', fromUserId: employeeId },
    });
    await prisma.emailAttachment.update({ where: { id: sent.body.data.id }, data: { emailId: msg.id } });
    expect((await employee.auth(api().delete(`/api/emails/attachments/${sent.body.data.id}`))).status).toBe(409);
    expect((await kai.auth(api().delete(`/api/emails/attachments/${sent.body.data.id}`))).status).toBe(404);
  });
});
