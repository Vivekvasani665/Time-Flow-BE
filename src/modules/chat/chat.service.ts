import { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { logger } from '../../lib/logger';
import { SlidingWindowRateLimiter } from '../../cache/rate-limiter';
import { BadRequestError, ForbiddenError, NotFoundError, RateLimitError } from '../../common/errors';
import type { AuthContext } from '../auth/auth.types';
import { can } from '../permissions/rbac.service';
import { P } from '../permissions/permission-catalog';
import { chatRealtime } from './chat.realtime';
import { chatMessageSelect, summarizeReactions, toChatMessage } from './chat.repository';
import type { ChatReaction, CreateMessageInput, ListMessagesQuery } from './chat.schemas';
import type { ChatMessageDto, ChatMessagePage } from './chat.types';

export const CHAT_RATE_LIMIT_MESSAGE = "You're sending messages too quickly. Please wait a moment and try again.";
const OWN_MESSAGES_ONLY = 'You can only edit or delete your own messages.';
/** The sidebar shows "99+" past this, so there is no point counting further. */
const UNREAD_CAP = 100;

const messageLimiter = new SlidingWindowRateLimiter(redis, 'chat', env.RATE_LIMIT_CHAT_MAX, env.RATE_LIMIT_CHAT_WINDOW_SECONDS * 1000);
/** Edits, deletes and reactions: looser than sending, but still bounded since the socket skips the HTTP limiter. */
const actionLimiter = new SlidingWindowRateLimiter(redis, 'chat-actions', 30, 10_000);

async function consume(limiter: SlidingWindowRateLimiter, userId: string): Promise<void> {
  let decision;
  try {
    decision = await limiter.consume(userId);
  } catch (err) {
    // Fail open, like the HTTP limiter: a Redis outage must not take chat down.
    logger.error({ err }, 'chat rate limiter unavailable; allowing request');
    return;
  }
  if (!decision.allowed) throw new RateLimitError(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)), CHAT_RATE_LIMIT_MESSAGE);
}

async function findLive(id: string) {
  const message = await prisma.chatMessage.findUnique({ where: { id }, select: { id: true, senderId: true, deletedAt: true } });
  if (!message || message.deletedAt) throw new NotFoundError('Message');
  return message;
}

async function loadMessage(id: string): Promise<ChatMessageDto> {
  return toChatMessage(await prisma.chatMessage.findUniqueOrThrow({ where: { id }, select: chatMessageSelect }));
}

async function broadcastReactions(messageId: string) {
  const rows = await prisma.chatMessageReaction.findMany({
    where: { messageId },
    select: { emoji: true, userId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const payload = { messageId, reactions: summarizeReactions(rows) };
  chatRealtime.toRoom('chat:reaction:updated', payload);
  return payload;
}

export const chatService = {
  /** Newest first; the client reverses for display. */
  async list(query: ListMessagesQuery): Promise<ChatMessagePage> {
    let where: Prisma.ChatMessageWhereInput = {};
    if (query.before) {
      const cursor = await prisma.chatMessage.findUnique({ where: { id: query.before }, select: { id: true, createdAt: true } });
      if (!cursor) throw new BadRequestError('The message to load before no longer exists', 'INVALID_CURSOR');
      where = {
        OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
      };
    }
    const records = await prisma.chatMessage.findMany({
      where,
      select: chatMessageSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const hasMore = records.length > query.limit;
    const items = records.slice(0, query.limit).map(toChatMessage);
    return { items, hasMore, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
  },

  async replies(id: string): Promise<ChatMessageDto[]> {
    const parent = await prisma.chatMessage.findUnique({ where: { id }, select: { id: true } });
    if (!parent) throw new NotFoundError('Message');
    const records = await prisma.chatMessage.findMany({
      where: { replyToId: id },
      select: chatMessageSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 200,
    });
    return records.map(toChatMessage);
  },

  async create(actor: AuthContext, input: CreateMessageInput): Promise<ChatMessageDto & { clientId?: string }> {
    await consume(messageLimiter, actor.id);
    if (input.replyToId) {
      const parent = await prisma.chatMessage.findUnique({ where: { id: input.replyToId }, select: { deletedAt: true } });
      if (!parent || parent.deletedAt) {
        throw new BadRequestError('The message you are replying to was deleted', 'VALIDATION_ERROR', [
          { path: 'replyToId', message: 'Message not found' },
        ]);
      }
    }
    const record = await prisma.chatMessage.create({
      data: { senderId: actor.id, content: input.content, replyToId: input.replyToId ?? null },
      select: chatMessageSelect,
    });
    const message = { ...toChatMessage(record), ...(input.clientId ? { clientId: input.clientId } : {}) };
    chatRealtime.toRoom('chat:message:new', message);
    return message;
  },

  async update(actor: AuthContext, id: string, content: string): Promise<ChatMessageDto> {
    await consume(actionLimiter, actor.id);
    const existing = await findLive(id);
    if (existing.senderId !== actor.id) throw new ForbiddenError(OWN_MESSAGES_ONLY);
    await prisma.chatMessage.update({ where: { id }, data: { content, editedAt: new Date() } });
    const message = await loadMessage(id);
    chatRealtime.toRoom('chat:message:updated', message);
    return message;
  },

  /** Soft delete. The author, or anyone with `chat.moderate`. */
  async remove(actor: AuthContext, id: string): Promise<ChatMessageDto> {
    await consume(actionLimiter, actor.id);
    const existing = await findLive(id);
    if (existing.senderId !== actor.id && !can(actor, P['chat.moderate'])) throw new ForbiddenError(OWN_MESSAGES_ONLY);
    await prisma.$transaction([
      prisma.chatMessage.update({ where: { id }, data: { deletedAt: new Date() } }),
      prisma.chatMessageReaction.deleteMany({ where: { messageId: id } }),
    ]);
    const message = await loadMessage(id);
    chatRealtime.toRoom('chat:message:deleted', message);
    return message;
  },

  /** Idempotent: reacting twice with the same emoji leaves one reaction. */
  async addReaction(actor: AuthContext, messageId: string, emoji: ChatReaction) {
    await consume(actionLimiter, actor.id);
    await findLive(messageId);
    try {
      await prisma.chatMessageReaction.create({ data: { messageId, userId: actor.id, emoji } });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
    return broadcastReactions(messageId);
  },

  async removeReaction(actor: AuthContext, messageId: string, emoji: ChatReaction) {
    await consume(actionLimiter, actor.id);
    await findLive(messageId);
    await prisma.chatMessageReaction.deleteMany({ where: { messageId, userId: actor.id, emoji } });
    return broadcastReactions(messageId);
  },

  /** Messages from others since the caller last opened the chat, capped at {@link UNREAD_CAP}. */
  async unreadCount(actor: AuthContext): Promise<{ count: number; lastReadAt: Date | null }> {
    const state = await prisma.chatReadState.findUnique({ where: { userId: actor.id }, select: { lastReadAt: true } });
    const count = await prisma.chatMessage.count({
      where: { deletedAt: null, senderId: { not: actor.id }, ...(state ? { createdAt: { gt: state.lastReadAt } } : {}) },
      take: UNREAD_CAP,
    });
    return { count, lastReadAt: state?.lastReadAt ?? null };
  },

  async markRead(actor: AuthContext): Promise<{ lastReadAt: Date }> {
    const lastReadAt = new Date();
    await prisma.chatReadState.upsert({
      where: { userId: actor.id },
      create: { userId: actor.id, lastReadAt },
      update: { lastReadAt },
    });
    // Clears the badge in the user's other tabs too.
    chatRealtime.toUser(actor.id, 'chat:read', { lastReadAt });
    return { lastReadAt };
  },
};
