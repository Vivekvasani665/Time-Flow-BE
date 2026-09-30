import type { Server } from 'socket.io';
import type { ChatUser } from './chat.types';

export const GLOBAL_CHAT_ROOM = 'global-chat';
/** Every socket also joins a room of its own user, to reach all of that user's tabs. */
export const userRoom = (userId: string) => `user:${userId}`;

export type ChatSocketData = {
  user: ChatUser;
  tokenVersion: number;
  /** Access-token expiry, ms since epoch. The socket is dropped at this point and must reconnect with a fresh session. */
  expiresAt: number;
};

let io: Server | null = null;

/**
 * The bridge from services to connected clients. Services emit through here
 * whether the change came in over REST or the socket, so both paths broadcast
 * exactly once. A no-op until a Socket.IO server is bound (e.g. in API tests).
 * With the Redis adapter, every emit reaches clients on every API replica.
 */
export const chatRealtime = {
  bind(server: Server): void {
    io = server;
  },

  unbind(): void {
    io = null;
  },

  toRoom(event: string, payload: unknown): void {
    io?.to(GLOBAL_CHAT_ROOM).emit(event, payload);
  },

  toUser(userId: string, event: string, payload: unknown): void {
    io?.to(userRoom(userId)).emit(event, payload);
  },

  /** Every tab of a user except one (e.g. the tab that answered a call). */
  toUserExcept(userId: string, socketId: string, event: string, payload: unknown): void {
    io?.to(userRoom(userId)).except(socketId).emit(event, payload);
  },

  /** One connection (one browser tab), on whichever replica holds it. */
  toSocket(socketId: string, event: string, payload: unknown): void {
    io?.to(socketId).emit(event, payload);
  },

  /** Whether a connection is still open, on any replica. */
  async isSocketConnected(socketId: string): Promise<boolean> {
    if (!io) return false;
    return (await io.in(socketId).fetchSockets()).length > 0;
  },

  /** Whether a user has at least one open connection, on any replica. */
  async isUserOnline(userId: string): Promise<boolean> {
    if (!io) return false;
    return (await io.in(userRoom(userId)).fetchSockets()).length > 0;
  },

  /** Distinct users with at least one open connection, across all replicas. */
  async onlineUsers(): Promise<ChatUser[]> {
    if (!io) return [];
    const sockets = await io.in(GLOBAL_CHAT_ROOM).fetchSockets();
    const users = new Map<string, ChatUser>();
    for (const s of sockets) {
      const data = s.data as Partial<ChatSocketData>;
      if (data.user) users.set(data.user.id, data.user);
    }
    return [...users.values()].sort((a, b) => a.firstName.localeCompare(b.firstName) || a.lastName.localeCompare(b.lastName));
  },
};
