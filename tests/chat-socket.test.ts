import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { redis } from '../src/lib/redis';
import { attachChatSocket, CHAT_SOCKET_PATH, type ChatSocketServer } from '../src/modules/chat/chat.socket';
import { api, app, loginAs, type Session } from './helpers';

let server: Server;
let chat: ChatSocketServer;
let url: string;
let manager: Session;
let employee: Session;
const clients: Socket[] = [];

beforeAll(async () => {
  server = createServer(app);
  chat = attachChatSocket(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  [manager, employee] = await Promise.all([loginAs('manager'), loginAs('employee')]);
});

afterAll(async () => {
  await chat.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  const keys = await redis.keys('rl:chat*');
  if (keys.length) await redis.del(...keys);
});

afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect();
});

type Auth = { token?: string; cookie?: string };

function client({ token, cookie }: Auth = {}): Socket {
  const socket = connect(url, {
    path: CHAT_SOCKET_PATH,
    addTrailingSlash: false,
    transports: ['websocket'],
    reconnection: false,
    auth: token ? { token } : {},
    extraHeaders: cookie ? { cookie } : {},
  });
  clients.push(socket);
  return socket;
}

function next<T = unknown>(socket: Socket, event: string, timeoutMs = 3_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function connected(auth: Auth): Promise<Socket> {
  const socket = client(auth);
  await next(socket, 'connect');
  return socket;
}

describe('Chat socket authentication', () => {
  it('rejects a connection without a session', async () => {
    const err = await next<Error>(client(), 'connect_error');
    expect(err.message).toBe('UNAUTHENTICATED');
  });

  it('rejects a forged token', async () => {
    const err = await next<Error>(client({ token: 'not-a-jwt' }), 'connect_error');
    expect(err.message).toBe('UNAUTHENTICATED');
  });

  it('accepts the auth cookie, as a browser sends it, and joins global-chat', async () => {
    const socket = await connected({ cookie: `tf_access=${manager.token}` });
    const ack = await socket.emitWithAck('chat:join', {});
    expect(ack.ok).toBe(true);
    expect(ack.data.room).toBe('global-chat');
    expect(ack.data.online.map((u: { id: string }) => u.id)).toContain(manager.userId);
  });
});

describe('Chat socket messaging', () => {
  it('saves a message and broadcasts it to everyone, echoing the clientId', async () => {
    const sender = await connected({ token: employee.token });
    const receiver = await connected({ token: manager.token });

    const incoming = next<{ id: string; content: string; clientId?: string; sender: { id: string } }>(receiver, 'chat:message:new');
    const ack = await sender.emitWithAck('chat:message', { content: 'Hello everyone 👋', clientId: 'tmp-1' });
    expect(ack.ok).toBe(true);

    const message = await incoming;
    expect(message).toMatchObject({ id: ack.data.id, content: 'Hello everyone 👋', clientId: 'tmp-1', sender: { id: employee.userId } });
  });

  it('answers invalid input in the acknowledgement', async () => {
    const socket = await connected({ token: employee.token });
    const ack = await socket.emitWithAck('chat:message', { content: '   ' });
    expect(ack).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', statusCode: 400 } });
  });

  it('refuses to edit someone else’s message', async () => {
    const socket = await connected({ token: employee.token });
    const { body } = await manager.auth(api().post('/api/chat/messages')).send({ content: 'Mine' });
    const ack = await socket.emitWithAck('chat:message:edit', { id: body.data.id, content: 'Yours now' });
    expect(ack).toMatchObject({ ok: false, error: { statusCode: 403, message: 'You can only edit or delete your own messages.' } });
  });

  it('broadcasts messages sent over REST too', async () => {
    const socket = await connected({ token: employee.token });
    const incoming = next<{ content: string }>(socket, 'chat:message:new');
    await manager.auth(api().post('/api/chat/messages')).send({ content: 'Via REST' }).expect(201);
    expect((await incoming).content).toBe('Via REST');
  });

  it('broadcasts edits, deletes and reactions', async () => {
    const author = await connected({ token: manager.token });
    const watcher = await connected({ token: employee.token });
    const { data: created } = await author.emitWithAck('chat:message', { content: 'Draft' });

    const updated = next<{ content: string }>(watcher, 'chat:message:updated');
    await author.emitWithAck('chat:message:edit', { id: created.id, content: 'Final' });
    expect((await updated).content).toBe('Final');

    const reacted = next<{ messageId: string; reactions: unknown[] }>(watcher, 'chat:reaction:updated');
    await watcher.emitWithAck('chat:reaction:add', { messageId: created.id, emoji: '🎉' });
    expect(await reacted).toEqual({ messageId: created.id, reactions: [{ emoji: '🎉', count: 1, userIds: [employee.userId] }] });

    const deleted = next<{ id: string; deletedAt: string | null }>(watcher, 'chat:message:deleted');
    await author.emitWithAck('chat:message:delete', { id: created.id });
    expect(await deleted).toMatchObject({ id: created.id, deletedAt: expect.any(String) });
  });

  it('rate limits socket messages', async () => {
    const socket = await connected({ token: employee.token });
    for (let i = 0; i < 10; i++) expect((await socket.emitWithAck('chat:message', { content: `burst ${i}` })).ok).toBe(true);
    const ack = await socket.emitWithAck('chat:message', { content: 'too many' });
    expect(ack).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', statusCode: 429 } });
  });
});

describe('Chat socket presence and typing', () => {
  it('relays typing to others, not back to the typist', async () => {
    const typist = await connected({ token: employee.token });
    const other = await connected({ token: manager.token });
    let echoed = false;
    typist.on('chat:typing', () => (echoed = true));

    const typing = next<{ user: { id: string }; isTyping: boolean }>(other, 'chat:typing');
    typist.emit('chat:typing:start');
    expect(await typing).toMatchObject({ user: { id: employee.userId }, isTyping: true });

    const stopped = next<{ isTyping: boolean }>(other, 'chat:typing');
    typist.emit('chat:typing:stop');
    expect((await stopped).isTyping).toBe(false);
    expect(echoed).toBe(false);
  });

  it('announces users coming online and going offline', async () => {
    const watcher = await connected({ token: manager.token });

    const online = next<{ user: { id: string } }>(watcher, 'chat:user:online');
    const visitor = await connected({ token: employee.token });
    expect((await online).user.id).toBe(employee.userId);

    const offline = next<{ userId: string }>(watcher, 'chat:user:offline');
    visitor.disconnect();
    expect((await offline).userId).toBe(employee.userId);
  });

  it('reconnects and rejoins after a disconnect', async () => {
    const socket = await connected({ token: employee.token });
    socket.disconnect();
    socket.connect();
    await next(socket, 'connect');
    const ack = await socket.emitWithAck('chat:join', {});
    expect(ack.ok).toBe(true);

    const incoming = next<{ content: string }>(socket, 'chat:message:new');
    await manager.auth(api().post('/api/chat/messages')).send({ content: 'After reconnect' }).expect(201);
    expect((await incoming).content).toBe('After reconnect');
  });
});
