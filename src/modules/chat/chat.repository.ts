import type { Prisma } from '@prisma/client';
import type { ChatMessageDto, ChatReactionSummary } from './chat.types';

export const chatUserSelect = { id: true, firstName: true, lastName: true, avatarUrl: true } satisfies Prisma.UserSelect;

export const chatMessageSelect = {
  id: true,
  content: true,
  senderId: true,
  editedAt: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
  sender: { select: chatUserSelect },
  replyTo: {
    select: { id: true, content: true, deletedAt: true, sender: { select: { id: true, firstName: true, lastName: true } } },
  },
  reactions: { select: { emoji: true, userId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.ChatMessageSelect;

export type ChatMessageRecord = Prisma.ChatMessageGetPayload<{ select: typeof chatMessageSelect }>;

/** Groups reaction rows by emoji, in the order each emoji was first used. */
export function summarizeReactions(rows: { emoji: string; userId: string }[]): ChatReactionSummary[] {
  const byEmoji = new Map<string, string[]>();
  for (const { emoji, userId } of rows) {
    const users = byEmoji.get(emoji) ?? [];
    users.push(userId);
    byEmoji.set(emoji, users);
  }
  return [...byEmoji].map(([emoji, userIds]) => ({ emoji, count: userIds.length, userIds }));
}

/** A deleted message keeps its place in the timeline, but none of its content or reactions. */
export function toChatMessage(record: ChatMessageRecord): ChatMessageDto {
  const deleted = record.deletedAt !== null;
  const reply = record.replyTo;
  return {
    id: record.id,
    content: deleted ? '' : record.content,
    sender: record.sender,
    replyTo:
      deleted || !reply
        ? null
        : { id: reply.id, content: reply.deletedAt ? '' : reply.content, deleted: reply.deletedAt !== null, sender: reply.sender },
    reactions: deleted ? [] : summarizeReactions(record.reactions),
    editedAt: record.editedAt,
    deletedAt: record.deletedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
