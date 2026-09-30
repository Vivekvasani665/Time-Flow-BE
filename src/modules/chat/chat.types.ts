/** A chat participant as other users see them. No email or role: this goes to everyone in the room. */
export type ChatUser = {
  id: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
};

export type ChatReactionSummary = {
  emoji: string;
  count: number;
  /** Who reacted; the client derives "reacted by me" from this, so one payload serves every viewer. */
  userIds: string[];
};

export type ChatReplyPreview = {
  id: string;
  /** Empty when the original was deleted. */
  content: string;
  deleted: boolean;
  sender: Omit<ChatUser, 'avatarUrl'>;
};

export type ChatMessageDto = {
  id: string;
  /** Empty for a deleted message; the client shows "This message was deleted." */
  content: string;
  sender: ChatUser;
  replyTo: ChatReplyPreview | null;
  reactions: ChatReactionSummary[];
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ChatMessagePage = {
  items: ChatMessageDto[];
  hasMore: boolean;
  /** Pass as `before` to load the previous page; null when there is none. */
  nextCursor: string | null;
};

/** Error shape returned in socket acknowledgements and `chat:error`. */
export type ChatSocketError = {
  code: string;
  message: string;
  statusCode: number;
  details?: { path: string; message: string }[];
  retryAfter?: number;
};

export type ChatAck<T = unknown> = { ok: true; data: T } | { ok: false; error: ChatSocketError };
