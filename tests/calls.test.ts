import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { attachChatSocket, CHAT_SOCKET_PATH, type ChatSocketServer } from '../src/modules/chat/chat.socket';
import { api, app, loginAs, type Session } from './helpers';

let server: Server;
let chat: ChatSocketServer;
let url: string;
let manager: Session;
let employee: Session;
let admin: Session;
const clients: Socket[] = [];

type Ack<T = Record<string, unknown>> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; statusCode: number } };
type CallData = { id: string; status: string; type: string; caller: { id: string }; receiver: { id: string } };

beforeAll(async () => {
  server = createServer(app);
  chat = attachChatSocket(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  [manager, employee, admin] = await Promise.all([loginAs('manager'), loginAs('employee'), loginAs('admin')]);
});

afterAll(async () => {
  await chat.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  const keys = await redis.keys('rl:call*');
  if (keys.length) await redis.del(...keys);
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  // No call may outlive its test, or the next one would find these people busy.
  await prisma.call.updateMany({ where: { status: { in: ['RINGING', 'ACCEPTED', 'CONNECTED'] } }, data: { status: 'ENDED' } });
});

async function connected(session: Session): Promise<Socket> {
  const socket = connect(url, {
    path: CHAT_SOCKET_PATH,
    addTrailingSlash: false,
    transports: ['websocket'],
    reconnection: false,
    auth: { token: session.token },
  });
  clients.push(socket);
  await next(socket, 'connect');
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

/** Resolves if the event does NOT arrive within the window. */
function silent(socket: Socket, event: string, windowMs = 300): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = () => reject(new Error(`unexpected ${event}`));
    socket.once(event, onEvent);
    setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, windowMs);
  });
}

const send = <T = CallData>(socket: Socket, event: string, payload: unknown) => socket.emitWithAck(event, payload) as Promise<Ack<T>>;

/** Manager calls employee; resolves once the employee's tab is ringing. */
async function ring(type: 'VOICE' | 'VIDEO' = 'VIDEO') {
  const caller = await connected(manager);
  const receiver = await connected(employee);
  const incoming = next<{ call: CallData }>(receiver, 'call:incoming');
  const ack = await send(caller, 'call:initiate', { receiverId: employee.userId, type });
  if (!ack.ok) throw new Error(ack.error.code);
  const { call } = await incoming;
  return { caller, receiver, call };
}

async function answered() {
  const { caller, receiver, call } = await ring();
  const accepted = next<{ callId: string }>(caller, 'call:accepted');
  const ack = await send(receiver, 'call:accept', { callId: call.id });
  expect(ack.ok).toBe(true);
  await accepted;
  return { caller, receiver, call };
}

const offer = (callId: string) => ({ callId, description: { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' } });

describe('Starting a call', () => {
  it('rings the receiver with who is calling, and never trusts a caller id from the client', async () => {
    const caller = await connected(manager);
    const receiver = await connected(employee);
    const incoming = next<{ call: CallData }>(receiver, 'call:incoming');
    const ack = await send(caller, 'call:initiate', { receiverId: employee.userId, type: 'VOICE' });
    expect(ack).toMatchObject({ ok: true, data: { status: 'RINGING', type: 'VOICE' } });
    const { call } = await incoming;
    expect(call).toMatchObject({ caller: { id: manager.userId }, receiver: { id: employee.userId }, status: 'RINGING' });

    // Extra fields such as a forged callerId are rejected outright.
    const forged = await send(caller, 'call:initiate', { receiverId: employee.userId, type: 'VOICE', callerId: admin.userId });
    expect(forged).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('refuses calling yourself, unknown people and malformed requests', async () => {
    const caller = await connected(manager);
    expect(await send(caller, 'call:initiate', { receiverId: manager.userId, type: 'VOICE' })).toMatchObject({
      ok: false,
      error: { code: 'CALL_SELF_CALL', statusCode: 400 },
    });
    expect(await send(caller, 'call:initiate', { receiverId: '00000000-0000-4000-8000-000000000000', type: 'VOICE' })).toMatchObject({
      ok: false,
      error: { code: 'CALL_RECEIVER_NOT_FOUND', statusCode: 404 },
    });
    expect(await send(caller, 'call:initiate', { receiverId: employee.userId, type: 'SCREEN' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  it('records a missed call when the receiver is offline', async () => {
    const caller = await connected(manager);
    const ack = await send(caller, 'call:initiate', { receiverId: admin.userId, type: 'VIDEO' });
    expect(ack).toMatchObject({ ok: false, error: { code: 'CALL_RECEIVER_OFFLINE' } });
    const last = await prisma.call.findFirst({ where: { callerId: manager.userId, receiverId: admin.userId }, orderBy: { createdAt: 'desc' } });
    expect(last).toMatchObject({ status: 'MISSED', type: 'VIDEO', durationSeconds: 0 });
  });

  it('answers busy when the receiver is already on a call, and blocks a second call from the caller', async () => {
    const { caller } = await ring();
    const third = await connected(admin);
    expect(await send(third, 'call:initiate', { receiverId: employee.userId, type: 'VOICE' })).toMatchObject({
      ok: false,
      error: { code: 'CALL_BUSY', message: 'This user is currently on another call.' },
    });
    // The caller is "on a call" while it rings, too.
    expect(await send(third, 'call:initiate', { receiverId: manager.userId, type: 'VOICE' })).toMatchObject({ ok: false, error: { code: 'CALL_BUSY' } });
    // A duplicate request from the caller.
    expect(await send(caller, 'call:initiate', { receiverId: employee.userId, type: 'VIDEO' })).toMatchObject({
      ok: false,
      error: { code: 'CALL_ALREADY_ACTIVE' },
    });
  });

  it('settles a call left ringing by a lost timer, so nobody stays busy forever', async () => {
    await prisma.call.create({
      data: { callerId: admin.userId, receiverId: employee.userId, type: 'VOICE', startedAt: new Date(Date.now() - 10 * 60_000) },
    });
    await connected(employee);
    const caller = await connected(manager);
    expect(await send(caller, 'call:initiate', { receiverId: employee.userId, type: 'VOICE' })).toMatchObject({ ok: true });
  });
});

describe('Answering', () => {
  it('connects the answering tab, stops the ringing on the other tabs, and cannot be answered twice', async () => {
    const { caller, receiver, call } = await ring();
    const otherTab = await connected(employee);
    const accepted = next<{ callId: string }>(caller, 'call:accepted');
    const elsewhere = next<{ callId: string }>(otherTab, 'call:answered-elsewhere');
    expect(await send(receiver, 'call:accept', { callId: call.id })).toMatchObject({ ok: true, data: { status: 'ACCEPTED' } });
    expect(await accepted).toEqual({ callId: call.id });
    expect(await elsewhere).toEqual({ callId: call.id });

    expect(await send(otherTab, 'call:accept', { callId: call.id })).toMatchObject({ ok: false, error: { code: 'CALL_ALREADY_ANSWERED' } });
  });

  it("lets only the receiver answer or decline", async () => {
    const { caller, call } = await ring();
    const stranger = await connected(admin);
    expect(await send(stranger, 'call:accept', { callId: call.id })).toMatchObject({ ok: false, error: { code: 'CALL_NOT_FOUND' } });
    expect(await send(caller, 'call:accept', { callId: call.id })).toMatchObject({ ok: false, error: { code: 'CALL_NOT_FOUND' } });
    expect(await send(stranger, 'call:reject', { callId: call.id })).toMatchObject({ ok: false, error: { code: 'CALL_NOT_FOUND' } });
  });

  it('declining tells the caller and records it', async () => {
    const { caller, receiver, call } = await ring();
    const ended = next<{ status: string; reason: string }>(caller, 'call:ended');
    expect(await send(receiver, 'call:reject', { callId: call.id })).toMatchObject({ ok: true, data: { status: 'REJECTED' } });
    expect(await ended).toMatchObject({ callId: call.id, status: 'REJECTED', reason: 'rejected' });
    expect(await send(receiver, 'call:accept', { callId: call.id })).toMatchObject({ ok: false, error: { code: 'CALL_ENDED' } });
  });

  it('the caller cancelling before an answer makes it a missed call for the receiver', async () => {
    const { caller, receiver, call } = await ring();
    const ended = next<{ status: string; reason: string }>(receiver, 'call:ended');
    expect(await send(caller, 'call:end', { callId: call.id })).toMatchObject({ ok: true, data: { status: 'MISSED' } });
    expect(await ended).toMatchObject({ status: 'MISSED', reason: 'cancelled' });
  });
});

describe('Signaling', () => {
  it('relays offer, answer and ICE candidates between the two tabs in the call only', async () => {
    const { caller, receiver, call } = await answered();
    const otherTab = await connected(employee);

    const gotOffer = next<{ callId: string; description: { type: string } }>(receiver, 'call:offer');
    const quietTab = silent(otherTab, 'call:offer');
    expect(await send(caller, 'call:offer', offer(call.id))).toMatchObject({ ok: true });
    expect(await gotOffer).toMatchObject({ callId: call.id, description: { type: 'offer' } });
    await quietTab;

    const gotAnswer = next(caller, 'call:answer');
    expect(await send(receiver, 'call:answer', { callId: call.id, description: { type: 'answer', sdp: 'v=0\r\n' } })).toMatchObject({ ok: true });
    await gotAnswer;

    const candidate = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 };
    const gotCandidate = next<{ candidate: typeof candidate }>(receiver, 'call:ice-candidate');
    expect(await send(caller, 'call:ice-candidate', { callId: call.id, candidate })).toMatchObject({ ok: true });
    expect((await gotCandidate).candidate).toEqual(candidate);

    const gotState = next(caller, 'call:media-state');
    expect(await send(receiver, 'call:media-state', { callId: call.id, state: { muted: true, cameraOff: false } })).toMatchObject({ ok: true });
    expect(await gotState).toEqual({ callId: call.id, state: { muted: true, cameraOff: false } });
  });

  it('refuses signaling from someone outside the call, or from a tab that is not in it', async () => {
    const { call } = await answered();
    const stranger = await connected(admin);
    expect(await send(stranger, 'call:offer', offer(call.id))).toMatchObject({ ok: false, error: { code: 'CALL_NOT_FOUND' } });
    const otherTab = await connected(employee);
    expect(await send(otherTab, 'call:offer', offer(call.id))).toMatchObject({ ok: false, error: { code: 'CALL_UNAUTHORIZED' } });
    // Oversized SDP is refused before it goes anywhere.
    const huge = { callId: call.id, description: { type: 'offer', sdp: 'x'.repeat(20_001) } };
    expect(await send(stranger, 'call:offer', huge)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('refuses signaling before the call is answered', async () => {
    const { caller, call } = await ring();
    expect(await send(caller, 'call:offer', offer(call.id))).toMatchObject({ ok: false, error: { code: 'CALL_NOT_ACTIVE' } });
  });

  it('lets a reconnected tab resume its call, but not while the original tab is still connected', async () => {
    const { caller, receiver, call } = await answered();
    const otherTab = await connected(employee);
    expect(await send(otherTab, 'call:resume', { callId: call.id })).toMatchObject({ ok: false, error: { code: 'CALL_UNAUTHORIZED' } });

    receiver.disconnect();
    const rejoined = await connected(employee);
    expect(await send(rejoined, 'call:resume', { callId: call.id })).toMatchObject({ ok: true });
    const gotOffer = next(rejoined, 'call:offer');
    expect(await send(caller, 'call:offer', offer(call.id))).toMatchObject({ ok: true });
    await gotOffer;
  });

  it('lets a caller whose connection dropped while ringing resume, so the answer still reaches them', async () => {
    const { caller, receiver, call } = await ring();
    // A ringing receiver has no tab in the call yet, so there is nothing for them to resume.
    expect(await send(receiver, 'call:resume', { callId: call.id })).toMatchObject({ ok: false, error: { code: 'CALL_ENDED' } });

    caller.disconnect();
    const rejoined = await connected(manager);
    expect(await send(rejoined, 'call:resume', { callId: call.id })).toMatchObject({ ok: true, data: { status: 'RINGING' } });
    const accepted = next(rejoined, 'call:accepted');
    await send(receiver, 'call:accept', { callId: call.id });
    await accepted;
  });
});

describe('Ending', () => {
  it('ends a connected call for both people and saves its duration', async () => {
    const { caller, receiver, call } = await answered();
    expect(await send(caller, 'call:connected', { callId: call.id })).toMatchObject({ ok: true, data: { status: 'CONNECTED' } });
    // Pretend it has been going for 95 seconds.
    await prisma.call.update({ where: { id: call.id }, data: { connectedAt: new Date(Date.now() - 95_000) } });

    const callerEnded = next<{ status: string; durationSeconds: number }>(caller, 'call:ended');
    const receiverEnded = next<{ status: string; durationSeconds: number }>(receiver, 'call:ended');
    expect(await send(receiver, 'call:end', { callId: call.id })).toMatchObject({ ok: true, data: { status: 'ENDED' } });
    expect(await callerEnded).toMatchObject({ status: 'ENDED', reason: 'hangup', durationSeconds: 95 });
    expect((await receiverEnded).durationSeconds).toBe(95);

    // Both hanging up at once is fine.
    expect(await send(caller, 'call:end', { callId: call.id })).toMatchObject({ ok: true, data: { status: 'ENDED' } });

    const history = await manager.auth(api().get('/api/calls').query({ userId: employee.userId }));
    expect(history.status).toBe(200);
    expect(history.body.data[0]).toMatchObject({ id: call.id, direction: 'outgoing', status: 'ENDED', durationSeconds: 95, type: 'VIDEO' });
    const theirs = await employee.auth(api().get('/api/calls').query({ userId: manager.userId }));
    expect(theirs.body.data[0]).toMatchObject({ id: call.id, direction: 'incoming' });
  });

  it('marks a call that never connected as failed', async () => {
    const { caller, call } = await answered();
    expect(await send(caller, 'call:end', { callId: call.id, reason: 'failed' })).toMatchObject({ ok: true, data: { status: 'FAILED' } });
  });

  it('frees both people for new calls once it ends', async () => {
    const { caller, call } = await answered();
    await send(caller, 'call:end', { callId: call.id });
    expect(await send(caller, 'call:initiate', { receiverId: employee.userId, type: 'VOICE' })).toMatchObject({ ok: true });
  });
});

describe('Calls API', () => {
  it('requires a session', async () => {
    expect((await api().get('/api/calls/contacts')).status).toBe(401);
    expect((await api().get('/api/calls/ice-servers')).status).toBe(401);
    expect((await api().get('/api/calls').query({ userId: employee.userId })).status).toBe(401);
  });

  it('lists everyone else who can be called, with who is online', async () => {
    await connected(employee);
    const res = await manager.auth(api().get('/api/calls/contacts'));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(manager.userId);
    expect(res.body.data.find((c: { id: string }) => c.id === employee.userId)).toMatchObject({ online: true });
    expect(res.body.data[0]).not.toHaveProperty('email');
  });

  it('only shows history between you and the other person', async () => {
    const res = await admin.auth(api().get('/api/calls').query({ userId: employee.userId }));
    expect(res.body.data.every((c: CallData) => [c.caller.id, c.receiver.id].includes(admin.userId))).toBe(true);
    expect((await admin.auth(api().get('/api/calls').query({ userId: 'nope' }))).status).toBe(400);
  });

  it('hands out STUN, and short-lived TURN credentials derived from the shared secret', async () => {
    const saved = { urls: env.CALL_TURN_URLS, secret: env.CALL_TURN_SECRET };
    try {
      const plain = await manager.auth(api().get('/api/calls/ice-servers'));
      expect(plain.body.data.iceServers).toEqual([{ urls: env.CALL_STUN_URLS }]);
      expect(plain.headers['cache-control']).toContain('no-store');

      Object.assign(env, { CALL_TURN_URLS: ['turn:turn.example.com:3478'], CALL_TURN_SECRET: 'shared-secret' });
      const res = await manager.auth(api().get('/api/calls/ice-servers'));
      const turn = res.body.data.iceServers[1];
      expect(turn.urls).toEqual(['turn:turn.example.com:3478']);
      expect(turn.username).toMatch(new RegExp(`^\\d+:${manager.userId}$`));
      expect(turn.credential).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(JSON.stringify(res.body)).not.toContain('shared-secret');
    } finally {
      Object.assign(env, { CALL_TURN_URLS: saved.urls, CALL_TURN_SECRET: saved.secret });
    }
  });
});
