import { z } from 'zod';

export const CHAT_MESSAGE_MAX_LENGTH = 2000;
export const CHAT_PAGE_SIZE = 50;

/** The reactions offered in the picker. Anything else is refused, so the set stays small and renderable. */
export const CHAT_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'] as const;

export const MESSAGE_TOO_LONG = `Your message is too long. Please keep it under ${CHAT_MESSAGE_MAX_LENGTH} characters.`;

// Control characters (other than newline and tab) and bidi overrides, which
// can hide or reorder text; zero-width characters alone don't count as content.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g;
const INVISIBLE = /[\s​-‍﻿]/g;

/**
 * Chat text is stored as plain text and rendered as text by the client — never
 * as HTML — so it is cleaned rather than HTML-escaped (escaping here would show
 * up as literal `&lt;` in every client).
 */
export const messageContent = z
  .string({ message: 'Message is required' })
  .transform((v) => v.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim())
  .pipe(
    z
      .string()
      .refine((v) => v.replace(INVISIBLE, '').length > 0, 'Message cannot be empty')
      .refine((v) => v.length <= CHAT_MESSAGE_MAX_LENGTH, MESSAGE_TOO_LONG),
  );

export const chatReaction = z.enum(CHAT_REACTIONS, { message: 'Unsupported reaction' });

export const createMessageSchema = z
  .object({
    content: messageContent,
    replyToId: z.uuid({ message: 'Invalid message id' }).nullish(),
    /** Echoed back so the sender can match the saved message to its optimistic copy. Never stored. */
    clientId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export const updateMessageSchema = z.object({ content: messageContent }).strict();

export const reactionSchema = z.object({ emoji: chatReaction }).strict();

export const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(CHAT_PAGE_SIZE),
  /** Id of the oldest message the client has; returns the page before it. */
  before: z.uuid({ message: 'Invalid cursor' }).optional(),
});

export const reactionParams = z.object({ id: z.uuid({ message: 'Invalid id' }), emoji: chatReaction });

// Socket payloads carry the message id in the body rather than the URL.
const messageId = z.uuid({ message: 'Invalid message id' });
export const socketEditSchema = updateMessageSchema.extend({ id: messageId });
export const socketDeleteSchema = z.object({ id: messageId }).strict();
export const socketReactionSchema = reactionSchema.extend({ messageId });

export type CreateMessageInput = z.infer<typeof createMessageSchema>;
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
export type ChatReaction = z.infer<typeof chatReaction>;
