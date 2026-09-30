import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { redis } from '../src/lib/redis';
import { api, loginAs, type Session } from './helpers';

let superadmin: Session;
let manager: Session;
let employee: Session;

beforeAll(async () => {
  [superadmin, manager, employee] = await Promise.all([loginAs('superadmin'), loginAs('manager'), loginAs('employee')]);
});

// Each test starts with a full send budget.
beforeEach(async () => {
  const keys = await redis.keys('rl:chat*');
  if (keys.length) await redis.del(...keys);
});

const send = (who: Session, body: Record<string, unknown>) => who.auth(api().post('/api/chat/messages')).send(body);

describe('Chat access', () => {
  it('requires a signed-in user', async () => {
    expect((await api().get('/api/chat/messages')).status).toBe(401);
    expect((await api().post('/api/chat/messages').send({ content: 'hi' })).status).toBe(401);
  });

  it('is open to every signed-in user, whatever their role', async () => {
    const res = await employee.auth(api().get('/api/chat/messages'));
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ limit: 50 });
  });
});

describe('Chat messages', () => {
  it('creates a message as the signed-in user', async () => {
    const res = await send(employee, { content: '  Good morning everyone! 👋  ' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      content: 'Good morning everyone! 👋',
      sender: { id: employee.userId },
      replyTo: null,
      reactions: [],
      editedAt: null,
      deletedAt: null,
    });
    expect(res.body.data.sender).not.toHaveProperty('email');
  });

  it('refuses a sender chosen by the client', async () => {
    const res = await send(employee, { content: 'I am the manager', senderId: manager.userId });
    expect(res.status).toBe(400);
  });

  it('rejects empty, whitespace-only and oversized messages', async () => {
    for (const content of ['', '   \n\t ', '​​']) {
      const res = await send(employee, { content });
      expect(res.status).toBe(400);
      expect(res.body.details[0].message).toBe('Message cannot be empty');
    }
    const long = await send(employee, { content: 'x'.repeat(2001) });
    expect(long.status).toBe(400);
    expect(long.body.details[0].message).toMatch(/under 2000 characters/);
    expect((await send(employee, { content: 'x'.repeat(2000) })).status).toBe(201);
  });

  it('stores text as text: strips control characters and keeps markup verbatim for the client to escape', async () => {
    const res = await send(employee, { content: 'a\u0000b‮c <script>alert(1)</script>' });
    expect(res.status).toBe(201);
    expect(res.body.data.content).toBe('abc <script>alert(1)</script>');
  });

  it('edits only your own message', async () => {
    const { body } = await send(manager, { content: 'Typo hre' });
    const id = body.data.id;

    const other = await employee.auth(api().patch(`/api/chat/messages/${id}`)).send({ content: 'Hijacked' });
    expect(other.status).toBe(403);
    expect(other.body.message).toBe('You can only edit or delete your own messages.');

    const own = await manager.auth(api().patch(`/api/chat/messages/${id}`)).send({ content: 'Typo here' });
    expect(own.status).toBe(200);
    expect(own.body.data.content).toBe('Typo here');
    expect(own.body.data.editedAt).not.toBeNull();
  });

  it('deletes only your own message, softly', async () => {
    const { body } = await send(manager, { content: 'Delete me' });
    const id = body.data.id;

    expect((await employee.auth(api().delete(`/api/chat/messages/${id}`))).status).toBe(403);

    const res = await manager.auth(api().delete(`/api/chat/messages/${id}`));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id, content: '', deletedAt: expect.any(String) });

    // Still in the timeline as a tombstone, without its content.
    const list = await manager.auth(api().get('/api/chat/messages'));
    const tombstone = list.body.data.find((m: { id: string }) => m.id === id);
    expect(tombstone).toMatchObject({ content: '', deletedAt: expect.any(String) });

    expect((await manager.auth(api().patch(`/api/chat/messages/${id}`)).send({ content: 'Back' })).status).toBe(404);
    expect((await manager.auth(api().delete(`/api/chat/messages/${id}`))).status).toBe(404);
  });

  it('lets a moderator delete anyone’s message', async () => {
    const { body } = await send(employee, { content: 'Off-topic' });
    const res = await superadmin.auth(api().delete(`/api/chat/messages/${body.data.id}`));
    expect(res.status).toBe(200);
  });

  it('replies carry a preview of the original, which follows its deletion', async () => {
    const parent = await send(manager, { content: 'Has the new task been completed?' });
    const reply = await send(employee, { content: 'Yes, I completed it.', replyToId: parent.body.data.id });
    expect(reply.status).toBe(201);
    expect(reply.body.data.replyTo).toMatchObject({
      id: parent.body.data.id,
      content: 'Has the new task been completed?',
      deleted: false,
      sender: { id: manager.userId },
    });

    const replies = await employee.auth(api().get(`/api/chat/messages/${parent.body.data.id}/replies`));
    expect(replies.body.data.map((m: { id: string }) => m.id)).toEqual([reply.body.data.id]);

    await manager.auth(api().delete(`/api/chat/messages/${parent.body.data.id}`)).expect(200);
    const again = await employee.auth(api().get(`/api/chat/messages/${parent.body.data.id}/replies`));
    expect(again.body.data[0].replyTo).toMatchObject({ content: '', deleted: true });

    const toDeleted = await send(employee, { content: 'Late reply', replyToId: parent.body.data.id });
    expect(toDeleted.status).toBe(400);
  });

  it('pages newest-first by cursor without overlap', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await send(superadmin, { content: `page ${i}` })).body.data.id);

    const first = await superadmin.auth(api().get('/api/chat/messages')).query({ limit: 2 });
    expect(first.body.data.map((m: { id: string }) => m.id)).toEqual([ids[4], ids[3]]);
    expect(first.body.meta).toMatchObject({ hasMore: true, nextCursor: ids[3] });

    const second = await superadmin.auth(api().get('/api/chat/messages')).query({ limit: 2, before: first.body.meta.nextCursor });
    expect(second.body.data.map((m: { id: string }) => m.id)).toEqual([ids[2], ids[1]]);
  });
});

describe('Chat reactions', () => {
  it('adds, dedupes and removes reactions', async () => {
    const { body } = await send(manager, { content: 'React to me' });
    const id = body.data.id;

    await employee.auth(api().post(`/api/chat/messages/${id}/reactions`)).send({ emoji: '❤️' }).expect(200);
    const dup = await employee.auth(api().post(`/api/chat/messages/${id}/reactions`)).send({ emoji: '❤️' });
    expect(dup.status).toBe(200);
    expect(dup.body.data.reactions).toEqual([{ emoji: '❤️', count: 1, userIds: [employee.userId] }]);

    const both = await manager.auth(api().post(`/api/chat/messages/${id}/reactions`)).send({ emoji: '❤️' });
    expect(both.body.data.reactions[0]).toMatchObject({ count: 2 });

    const removed = await employee.auth(api().delete(`/api/chat/messages/${id}/reactions/${encodeURIComponent('❤️')}`));
    expect(removed.status).toBe(200);
    expect(removed.body.data.reactions).toEqual([{ emoji: '❤️', count: 1, userIds: [manager.userId] }]);
  });

  it('only accepts the supported reactions', async () => {
    const { body } = await send(manager, { content: 'Picky' });
    const res = await employee.auth(api().post(`/api/chat/messages/${body.data.id}/reactions`)).send({ emoji: '<b>' });
    expect(res.status).toBe(400);
  });
});

describe('Chat unread count', () => {
  it('counts others’ messages since the chat was last opened', async () => {
    await employee.auth(api().post('/api/chat/read')).expect(200);
    expect((await employee.auth(api().get('/api/chat/unread'))).body.data.count).toBe(0);

    await send(manager, { content: 'Ping 1' });
    await send(manager, { content: 'Ping 2' });
    await send(employee, { content: 'My own message does not count' });
    expect((await employee.auth(api().get('/api/chat/unread'))).body.data.count).toBe(2);

    await employee.auth(api().post('/api/chat/read')).expect(200);
    expect((await employee.auth(api().get('/api/chat/unread'))).body.data.count).toBe(0);
  });
});

describe('Chat rate limiting', () => {
  it('rejects more than 10 messages in 10 seconds', async () => {
    for (let i = 0; i < 10; i++) expect((await send(employee, { content: `burst ${i}` })).status).toBe(201);
    const res = await send(employee, { content: 'one too many' });
    expect(res.status).toBe(429);
    expect(res.body.message).toBe("You're sending messages too quickly. Please wait a moment and try again.");
  });
});
