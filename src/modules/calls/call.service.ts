import { createHmac } from 'node:crypto';
import { Prisma, type CallStatus } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { SlidingWindowRateLimiter } from '../../cache/rate-limiter';
import { AppError, RateLimitError } from '../../common/errors';
import { fullName } from '../../common/utils/request-context';
import { activityService } from '../activity-logs/activity.service';
import type { AuthContext } from '../auth/auth.types';
import { chatRealtime } from '../chat/chat.realtime';
import { chatUserSelect } from '../chat/chat.repository';
import { activeCallWhere, callSelect, toCallDto, toHistoryItem, type CallRecord } from './call.repository';
import type { CallHistoryQuery, EndCallInput, InitiateCallInput } from './call.schemas';
import {
  ACTIVE_CALL_STATUSES,
  type CallContact,
  type CallDto,
  type CallEndReason,
  type CallHistoryItem,
  type CallServerEvents,
  type IceServer,
} from './call.types';

const callError = {
  selfCall: () => new AppError(400, 'CALL_SELF_CALL', "You can't call yourself."),
  receiverNotFound: () => new AppError(404, 'CALL_RECEIVER_NOT_FOUND', "This person can't be called. Their account may be inactive."),
  notFound: () => new AppError(404, 'CALL_NOT_FOUND', 'This call no longer exists.'),
  alreadyActive: () => new AppError(409, 'CALL_ALREADY_ACTIVE', "You're already on a call. End it before starting another."),
  alreadyAnswered: () => new AppError(409, 'CALL_ALREADY_ANSWERED', 'This call was already answered.'),
  ended: () => new AppError(409, 'CALL_ENDED', 'This call has already ended.'),
  busy: () => new AppError(409, 'CALL_BUSY', 'This user is currently on another call.'),
  offline: (name: string) => new AppError(409, 'CALL_RECEIVER_OFFLINE', `${name} isn't online right now. They'll see that you called.`),
  notActive: () => new AppError(409, 'CALL_NOT_ACTIVE', 'This call is not connected.'),
  otherTab: () => new AppError(403, 'CALL_UNAUTHORIZED', 'This call is open in another tab or window.'),
};

const ringTimers = new Map<string, NodeJS.Timeout>();
const graceTimers = new Map<string, NodeJS.Timeout>();
const limiter = new SlidingWindowRateLimiter(redis, 'call', env.RATE_LIMIT_CALL_MAX, 60_000);

function clearTimer(timers: Map<string, NodeJS.Timeout>, key: string) {
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
}

function schedule(timers: Map<string, NodeJS.Timeout>, key: string, ms: number, run: () => Promise<unknown>) {
  clearTimer(timers, key);
  const timer = setTimeout(() => {
    timers.delete(key);
    run().catch((err: unknown) => logger.error({ err, key }, 'call timer failed'));
  }, ms);
  // Never keep the process alive (or a test run open) just for a call timer.
  timer.unref();
  timers.set(key, timer);
}

function emit<E extends keyof CallServerEvents>(target: { user: string } | { socket: string }, event: E, payload: CallServerEvents[E]) {
  if ('user' in target) chatRealtime.toUser(target.user, event, payload);
  else chatRealtime.toSocket(target.socket, event, payload);
}

const isActive = (status: CallStatus) => (ACTIVE_CALL_STATUSES as readonly CallStatus[]).includes(status);
const isParticipant = (call: CallRecord, userId: string) => call.callerId === userId || call.receiverId === userId;
/** The tab each side is in the call from. */
const boundSocket = (call: CallRecord, userId: string) => (call.callerId === userId ? call.callerSocketId : call.receiverSocketId);
const otherSocket = (call: CallRecord, userId: string) => (call.callerId === userId ? call.receiverSocketId : call.callerSocketId);

async function load(callId: string): Promise<CallRecord | null> {
  return prisma.call.findUnique({ where: { id: callId }, select: callSelect });
}

/** Loads a call the user takes part in; anyone else learns nothing about it. */
async function loadOwn(callId: string, userId: string): Promise<CallRecord> {
  const call = await load(callId);
  if (!call || !isParticipant(call, userId)) throw callError.notFound();
  return call;
}

/** Serialises call set-up for these people across requests and replicas: locks their user rows in a fixed order. */
async function lockUsers(tx: Prisma.TransactionClient, userIds: string[]) {
  const ids = [...new Set(userIds)].sort();
  await tx.$queryRaw`SELECT id FROM users WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
}

/**
 * Moves a still-active call to a final status, once: the conditional update
 * means a timer, a hang-up and a disconnect racing each other finish it a
 * single time. Both people are told, on every tab.
 */
async function finish(callId: string, from: readonly CallStatus[], status: CallStatus, reason: CallEndReason): Promise<CallRecord | null> {
  const endedAt = new Date();
  const current = await prisma.call.findUnique({ where: { id: callId }, select: { connectedAt: true } });
  if (!current) return null;
  const durationSeconds = current.connectedAt ? Math.max(0, Math.round((endedAt.getTime() - current.connectedAt.getTime()) / 1000)) : 0;
  const { count } = await prisma.call.updateMany({
    where: { id: callId, status: { in: [...from] } },
    data: { status, endedAt, durationSeconds, callerSocketId: null, receiverSocketId: null },
  });
  if (count === 0) return null;

  clearTimer(ringTimers, callId);
  for (const key of graceTimers.keys()) if (key.startsWith(`${callId}:`)) clearTimer(graceTimers, key);

  const call = (await load(callId))!;
  const payload = { callId, status, reason, durationSeconds };
  emit({ user: call.callerId }, 'call:ended', payload);
  emit({ user: call.receiverId }, 'call:ended', payload);
  if (status === 'MISSED') notifyMissed(call);
  logger.info({ callId, status, reason, durationSeconds }, 'call finished');
  return call;
}

/** A bell notification for the person who missed the call (not for a call they declined). */
function notifyMissed(call: CallRecord) {
  const what = call.type === 'VIDEO' ? 'video call' : 'voice call';
  void activityService.record(
    { actorId: call.callerId, ip: null, userAgent: null },
    {
      action: 'call.missed',
      entity: 'call',
      entityId: call.id,
      description: `${fullName(call.receiver)} missed a ${what} from ${fullName(call.caller)}`,
      metadata: { type: call.type },
      notify: [
        {
          userId: call.receiverId,
          type: 'call.missed',
          title: `Missed ${what} from ${fullName(call.caller)}`,
          link: `/chat?c=dm-${call.callerId}`,
        },
      ],
    },
  );
}

/**
 * Settles calls left behind by a crashed server or a lost timer, so they
 * don't make someone look busy forever: a call rings for a bounded time, and
 * an answered call needs its participants' tabs to still be open.
 */
async function settleStaleCalls(userIds: string[]) {
  const calls = await prisma.call.findMany({ where: { OR: userIds.map(activeCallWhere) }, select: callSelect });
  const ringLimit = Date.now() - (env.CALL_RING_TIMEOUT_SECONDS + 5) * 1000;
  for (const call of calls) {
    if (call.status === 'RINGING') {
      const callerGone = call.callerSocketId ? !(await chatRealtime.isSocketConnected(call.callerSocketId)) : true;
      if (call.startedAt.getTime() < ringLimit || callerGone) await finish(call.id, ['RINGING'], 'MISSED', 'no_answer');
      continue;
    }
    const alive = await Promise.all(
      [call.callerSocketId, call.receiverSocketId].map((id) => (id ? chatRealtime.isSocketConnected(id) : Promise.resolve(false))),
    );
    // Both tabs gone and no grace timer pending here: nobody is on this call any more.
    const pending = [...graceTimers.keys()].some((k) => k.startsWith(`${call.id}:`));
    if (!alive.some(Boolean) && !pending) {
      await finish(call.id, ['ACCEPTED', 'CONNECTED'], call.status === 'CONNECTED' ? 'ENDED' : 'FAILED', 'disconnected');
    }
  }
}

async function assertWithinBudget(userId: string) {
  let decision;
  try {
    decision = await limiter.consume(userId);
  } catch (err) {
    logger.error({ err }, 'call rate limiter unavailable; allowing request');
    return;
  }
  if (!decision.allowed) {
    throw new RateLimitError(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)), "You've started a lot of calls in a short time. Please wait a minute.");
  }
}

/** coturn `use-auth-secret`: username "<expiry>:<user>", password = base64(HMAC-SHA1(secret, username)). */
function turnCredentials(userId: string): { username: string; credential: string } | null {
  if (env.CALL_TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + env.CALL_TURN_TTL_SECONDS}:${userId}`;
    return { username, credential: createHmac('sha1', env.CALL_TURN_SECRET).update(username).digest('base64') };
  }
  if (env.CALL_TURN_USERNAME && env.CALL_TURN_CREDENTIAL) return { username: env.CALL_TURN_USERNAME, credential: env.CALL_TURN_CREDENTIAL };
  return null;
}

export const callService = {
  /**
   * Starts a call. The caller is always the signed-in user (never an id from
   * the client); the receiver must be another active user who is free and
   * online. A busy or offline receiver still gets a missed-call record.
   */
  async initiate(actor: AuthContext, socketId: string, input: InitiateCallInput): Promise<CallDto> {
    if (input.receiverId === actor.id) throw callError.selfCall();
    const receiver = await prisma.user.findFirst({
      where: { id: input.receiverId, deletedAt: null, status: 'ACTIVE' },
      select: chatUserSelect,
    });
    if (!receiver) throw callError.receiverNotFound();
    await assertWithinBudget(actor.id);

    await settleStaleCalls([actor.id, receiver.id]);
    const online = await chatRealtime.isUserOnline(receiver.id);

    const outcome = await prisma.$transaction(async (tx) => {
      await lockUsers(tx, [actor.id, receiver.id]);
      if (await tx.call.count({ where: activeCallWhere(actor.id) })) throw callError.alreadyActive();
      const busy = (await tx.call.count({ where: activeCallWhere(receiver.id) })) > 0;
      if (busy || !online) {
        const now = new Date();
        const missed = await tx.call.create({
          data: { callerId: actor.id, receiverId: receiver.id, type: input.type, status: 'MISSED', endedAt: now, durationSeconds: 0 },
          select: callSelect,
        });
        return { kind: busy ? ('busy' as const) : ('offline' as const), call: missed };
      }
      const call = await tx.call.create({
        data: { callerId: actor.id, receiverId: receiver.id, type: input.type, callerSocketId: socketId },
        select: callSelect,
      });
      return { kind: 'ringing' as const, call };
    });

    if (outcome.kind !== 'ringing') {
      notifyMissed(outcome.call);
      throw outcome.kind === 'busy' ? callError.busy() : callError.offline(receiver.firstName);
    }

    const call = toCallDto(outcome.call);
    emit({ user: receiver.id }, 'call:incoming', { call });
    schedule(ringTimers, call.id, env.CALL_RING_TIMEOUT_SECONDS * 1000, () => finish(call.id, ['RINGING'], 'MISSED', 'no_answer'));
    return call;
  },

  /** Answers from one tab; the others stop ringing. Answering twice, or a call that is over, is refused. */
  async accept(actor: AuthContext, socketId: string, callId: string): Promise<CallDto> {
    await settleStaleCalls([actor.id]);
    const call = await prisma.$transaction(async (tx) => {
      await lockUsers(tx, [actor.id]);
      const current = await tx.call.findUnique({ where: { id: callId }, select: callSelect });
      if (!current || current.receiverId !== actor.id) throw callError.notFound();
      if (current.status === 'ACCEPTED' || current.status === 'CONNECTED') throw callError.alreadyAnswered();
      if (current.status !== 'RINGING') throw callError.ended();
      if (await tx.call.count({ where: { AND: [activeCallWhere(actor.id), { id: { not: callId } }] } })) throw callError.alreadyActive();
      return tx.call.update({
        where: { id: callId },
        data: { status: 'ACCEPTED', answeredAt: new Date(), receiverSocketId: socketId },
        select: callSelect,
      });
    });

    clearTimer(ringTimers, callId);
    if (call.callerSocketId) emit({ socket: call.callerSocketId }, 'call:accepted', { callId });
    chatRealtime.toUserExcept(actor.id, socketId, 'call:answered-elsewhere', { callId });
    return toCallDto(call);
  },

  async reject(actor: AuthContext, callId: string): Promise<CallDto> {
    const call = await loadOwn(callId, actor.id);
    if (call.receiverId !== actor.id) throw callError.notFound();
    if (call.status !== 'RINGING') throw isActive(call.status) ? callError.alreadyAnswered() : callError.ended();
    const done = await finish(callId, ['RINGING'], 'REJECTED', 'rejected');
    return toCallDto(done ?? (await load(callId))!);
  },

  /**
   * Hangs up. Before an answer, the caller cancelling makes it a missed call
   * and the receiver ending it declines it. Ending a call that is already over
   * is not an error: both sides may hang up at once.
   */
  async end(actor: AuthContext, input: EndCallInput): Promise<CallDto> {
    const call = await loadOwn(input.callId, actor.id);
    if (!isActive(call.status)) return toCallDto(call);

    let done: CallRecord | null;
    if (call.status === 'RINGING') {
      done =
        call.callerId === actor.id
          ? await finish(call.id, ['RINGING'], 'MISSED', 'cancelled')
          : await finish(call.id, ['RINGING'], 'REJECTED', 'rejected');
    } else if (call.status === 'ACCEPTED' && input.reason === 'failed') {
      done = await finish(call.id, ['ACCEPTED'], 'FAILED', 'failed');
    } else {
      done = await finish(call.id, ['ACCEPTED', 'CONNECTED'], 'ENDED', input.reason === 'failed' ? 'failed' : 'hangup');
    }
    return toCallDto(done ?? (await load(call.id))!);
  },

  /** The media connection is up: the call's duration counts from here. */
  async markConnected(actor: AuthContext, socketId: string, callId: string): Promise<CallDto> {
    const call = await loadOwn(callId, actor.id);
    if (boundSocket(call, actor.id) !== socketId) throw callError.otherTab();
    if (call.status === 'ACCEPTED') {
      await prisma.call.updateMany({ where: { id: callId, status: 'ACCEPTED' }, data: { status: 'CONNECTED', connectedAt: new Date() } });
    } else if (call.status !== 'CONNECTED') {
      throw callError.ended();
    }
    return toCallDto((await load(callId))!);
  },

  /**
   * Passes an offer, answer, ICE candidate or mute/camera state to the other side of the call,
   * and only from the tab that is in it to the tab that is in it. The payload
   * is opaque to the server and has already been validated for shape and size.
   */
  async relay<E extends 'call:offer' | 'call:answer' | 'call:ice-candidate' | 'call:media-state'>(
    actor: AuthContext,
    socketId: string,
    event: E,
    payload: CallServerEvents[E],
  ): Promise<void> {
    const call = await loadOwn(payload.callId, actor.id);
    if (call.status !== 'ACCEPTED' && call.status !== 'CONNECTED') throw callError.notActive();
    if (boundSocket(call, actor.id) !== socketId) throw callError.otherTab();
    const target = otherSocket(call, actor.id);
    if (!target) throw callError.notActive();
    emit({ socket: target }, event, payload);
  },

  /**
   * A tab reconnected (new socket id) while in a call, or while its outgoing
   * call rings: route the call to it again. Refused while the call's original
   * tab is still connected. (A ringing receiver has no tab bound yet.)
   */
  async resume(actor: AuthContext, socketId: string, callId: string): Promise<CallDto> {
    const call = await loadOwn(callId, actor.id);
    if (!isActive(call.status) || (call.status === 'RINGING' && call.callerId !== actor.id)) throw callError.ended();
    const bound = boundSocket(call, actor.id);
    if (bound && bound !== socketId && (await chatRealtime.isSocketConnected(bound))) throw callError.otherTab();
    const field = call.callerId === actor.id ? 'callerSocketId' : 'receiverSocketId';
    await prisma.call.updateMany({ where: { id: callId, status: { in: [...ACTIVE_CALL_STATUSES] } }, data: { [field]: socketId } });
    clearTimer(graceTimers, `${callId}:${actor.id}`);
    return toCallDto((await load(callId))!);
  },

  /**
   * A tab closed or lost its connection. Its calls wait a grace period for it
   * to reconnect (a network blip, the session cookie refreshing) and end if it
   * doesn't. A tab closing normally hangs up first, so this is the fallback.
   */
  async onSocketDisconnect(userId: string, socketId: string): Promise<void> {
    const calls = await prisma.call.findMany({
      where: { status: { in: [...ACTIVE_CALL_STATUSES] }, OR: [{ callerSocketId: socketId }, { receiverSocketId: socketId }] },
      select: { id: true },
    });
    for (const { id } of calls) {
      schedule(graceTimers, `${id}:${userId}`, env.CALL_RECONNECT_GRACE_SECONDS * 1000, async () => {
        const call = await load(id);
        if (!call || !isActive(call.status) || boundSocket(call, userId) !== socketId) return;
        if (await chatRealtime.isSocketConnected(socketId)) return;
        if (call.status === 'RINGING') await finish(id, ['RINGING'], 'MISSED', 'cancelled');
        else await finish(id, ['ACCEPTED', 'CONNECTED'], call.status === 'CONNECTED' ? 'ENDED' : 'FAILED', 'disconnected');
      });
    }
  },

  /** Finished calls between the user and one other person, newest first. */
  async history(actor: AuthContext, query: CallHistoryQuery): Promise<CallHistoryItem[]> {
    const calls = await prisma.call.findMany({
      where: {
        status: { notIn: [...ACTIVE_CALL_STATUSES] },
        OR: [
          { callerId: actor.id, receiverId: query.userId },
          { callerId: query.userId, receiverId: actor.id },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      select: callSelect,
    });
    return calls.map((c) => toHistoryItem(c, actor.id));
  },

  /** Everyone the user can call: every other active member, as in the team-wide chat. */
  async contacts(actor: AuthContext): Promise<CallContact[]> {
    const [users, online] = await Promise.all([
      prisma.user.findMany({
        where: { id: { not: actor.id }, deletedAt: null, status: 'ACTIVE' },
        select: chatUserSelect,
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
        take: 500,
      }),
      chatRealtime.onlineUsers().catch(() => []),
    ]);
    const onlineIds = new Set(online.map((u) => u.id));
    return users.map((u) => ({ ...u, online: onlineIds.has(u.id) }));
  },

  /** STUN/TURN servers for the browser. TURN credentials are per user and short-lived when a shared secret is set. */
  iceServers(actor: AuthContext): { iceServers: IceServer[] } {
    const servers: IceServer[] = [];
    if (env.CALL_STUN_URLS.length) servers.push({ urls: env.CALL_STUN_URLS });
    const turn = turnCredentials(actor.id);
    if (env.CALL_TURN_URLS.length && turn) servers.push({ urls: env.CALL_TURN_URLS, ...turn });
    return { iceServers: servers };
  },
};
