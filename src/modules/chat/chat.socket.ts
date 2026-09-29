import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server, type DefaultEventsMap, type Socket } from 'socket.io';
import type { ZodType } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { createRedisConnection } from '../../lib/redis';
import { UnauthorizedError } from '../../common/errors';
import { normalizeError } from '../../common/middleware/error-handler';
import { ACCESS_COOKIE, tokenService } from '../auth/token.service';
import type { AuthContext } from '../auth/auth.types';
import { rbacService } from '../permissions/rbac.service';
import { chatRealtime, GLOBAL_CHAT_ROOM, userRoom, type ChatSocketData } from './chat.realtime';
import { chatUserSelect } from './chat.repository';
import { createMessageSchema, socketDeleteSchema, socketEditSchema, socketReactionSchema } from './chat.schemas';
import { chatService } from './chat.service';
import type { ChatAck, ChatSocketError } from './chat.types';

/**
 * Served under /api so the frontend's existing `/api/*` proxy carries it, and
 * the browser sends the httpOnly auth cookie as a first-party request.
 */
export const CHAT_SOCKET_PATH = '/api/socket.io';

const SESSION_EXPIRED: ChatSocketError = {
  code: 'SESSION_EXPIRED',
  statusCode: 401,
  message: 'Your session has expired. Please sign in again.',
};
/** Typing indicators are cosmetic; one per second per socket is plenty. */
const TYPING_MIN_INTERVAL_MS = 1_000;

type ChatServer = Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, ChatSocketData>;
type ChatSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, ChatSocketData>;
type Ack = (response: ChatAck) => void;

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of header?.split(';') ?? []) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim()) || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Same sources as the HTTP middleware: a bearer token (non-browser clients) or the auth cookie. */
function extractToken(socket: ChatSocket): string | null {
  const auth: unknown = socket.handshake.auth?.token;
  if (typeof auth === 'string' && auth) return auth.replace(/^Bearer\s+/i, '');
  return readCookie(socket.handshake.headers.cookie, ACCESS_COOKIE);
}

function toSocketError(err: unknown): ChatSocketError {
  const e = normalizeError(err);
  return {
    code: e.code,
    message: e.message,
    statusCode: e.statusCode,
    ...(e.details ? { details: e.details } : {}),
    ...('retryAfterSeconds' in e && typeof e.retryAfterSeconds === 'number' ? { retryAfter: e.retryAfterSeconds } : {}),
  };
}

/**
 * Re-checks the caller before every action, exactly as `authenticate` does per
 * HTTP request: a deactivated account or a changed password stops working
 * immediately, not when the socket happens to reconnect.
 */
async function currentActor(socket: ChatSocket): Promise<AuthContext> {
  const { user, tokenVersion, expiresAt } = socket.data;
  const context = Date.now() < expiresAt ? await rbacService.buildAuthContext(user.id) : null;
  if (!context || context.tokenVersion !== tokenVersion || context.status !== 'ACTIVE') {
    socket.emit('chat:error', SESSION_EXPIRED);
    socket.disconnect(true);
    throw new UnauthorizedError(SESSION_EXPIRED.message, SESSION_EXPIRED.code);
  }
  return context;
}

/** Registers an event whose payload is validated, whose caller is re-authorised, and whose outcome goes back in the ack. */
function handle<T>(socket: ChatSocket, event: string, schema: ZodType<T>, run: (actor: AuthContext, input: T) => Promise<unknown>) {
  socket.on(event, async (payload: unknown, ack?: unknown) => {
    const reply = typeof ack === 'function' ? (ack as Ack) : undefined;
    try {
      const actor = await currentActor(socket);
      const data = await run(actor, schema.parse(payload ?? {}));
      reply?.({ ok: true, data });
    } catch (err) {
      const error = toSocketError(err);
      if (error.statusCode >= 500) logger.error({ err, event, userId: socket.data.user?.id }, 'chat socket handler failed');
      if (reply) reply({ ok: false, error });
      else socket.emit('chat:error', { event, ...error });
    }
  });
}

function registerHandlers(io: ChatServer, socket: ChatSocket) {
  const { user } = socket.data;
  let lastTypingAt = 0;

  socket.on('chat:join', async (_payload: unknown, ack?: unknown) => {
    await socket.join(GLOBAL_CHAT_ROOM);
    const online = await chatRealtime.onlineUsers().catch(() => []);
    if (typeof ack === 'function') (ack as Ack)({ ok: true, data: { room: GLOBAL_CHAT_ROOM, online } });
  });

  handle(socket, 'chat:message', createMessageSchema, async (actor, input) => {
    const message = await chatService.create(actor, input);
    socket.to(GLOBAL_CHAT_ROOM).emit('chat:typing', { user, isTyping: false });
    return message;
  });
  handle(socket, 'chat:message:edit', socketEditSchema, (actor, { id, content }) => chatService.update(actor, id, content));
  handle(socket, 'chat:message:delete', socketDeleteSchema, (actor, { id }) => chatService.remove(actor, id));
  handle(socket, 'chat:reaction:add', socketReactionSchema, (actor, { messageId, emoji }) => chatService.addReaction(actor, messageId, emoji));
  handle(socket, 'chat:reaction:remove', socketReactionSchema, (actor, { messageId, emoji }) =>
    chatService.removeReaction(actor, messageId, emoji),
  );

  // Typing carries no data and is never stored, so it skips re-authorisation;
  // the socket was authenticated at connect and is dropped when the token lapses.
  socket.on('chat:typing:start', () => {
    const now = Date.now();
    if (now - lastTypingAt < TYPING_MIN_INTERVAL_MS) return;
    lastTypingAt = now;
    socket.to(GLOBAL_CHAT_ROOM).emit('chat:typing', { user, isTyping: true });
  });
  socket.on('chat:typing:stop', () => {
    lastTypingAt = 0;
    socket.to(GLOBAL_CHAT_ROOM).emit('chat:typing', { user, isTyping: false });
  });

  // Drop the socket when its access token lapses; the client refreshes the session and reconnects.
  const expiry = setTimeout(
    () => {
      socket.emit('chat:error', SESSION_EXPIRED);
      socket.disconnect(true);
    },
    Math.max(socket.data.expiresAt - Date.now(), 0),
  );

  socket.on('disconnect', async () => {
    clearTimeout(expiry);
    socket.to(GLOBAL_CHAT_ROOM).emit('chat:typing', { user, isTyping: false });
    try {
      const remaining = await io.in(userRoom(user.id)).fetchSockets();
      if (remaining.length === 0) io.to(GLOBAL_CHAT_ROOM).emit('chat:user:offline', { userId: user.id });
    } catch (err) {
      logger.warn({ err }, 'chat presence update failed');
    }
  });
}

export type ChatSocketServer = { io: ChatServer; close: () => Promise<void> };

/**
 * Attaches Socket.IO to the API's own HTTP server — no second server or port.
 * The Redis adapter relays broadcasts between API replicas; with more than one
 * replica, the load balancer needs sticky sessions for the polling transport.
 */
export function attachChatSocket(httpServer: HttpServer): ChatSocketServer {
  const io: ChatServer = new Server(httpServer, {
    path: CHAT_SOCKET_PATH,
    // Next.js strips trailing slashes before proxying, so the path must match without one.
    addTrailingSlash: false,
    serveClient: false,
    cors: { origin: env.CORS_ORIGINS, credentials: true },
    // A message is at most 2000 characters; nothing legitimate comes close to this.
    maxHttpBufferSize: 32 * 1024,
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  const pub = createRedisConnection('chat-pub');
  const sub = createRedisConnection('chat-sub');
  io.adapter(createAdapter(pub, sub, { key: 'timeflow:socket.io' }));

  io.use(async (socket, next) => {
    try {
      const token = extractToken(socket);
      const payload = token ? tokenService.verifyAccessToken(token) : null;
      const context = payload ? await rbacService.buildAuthContext(payload.sub) : null;
      if (!payload || !context || context.tokenVersion !== payload.tv || context.status !== 'ACTIVE') {
        return next(Object.assign(new Error('UNAUTHENTICATED'), { data: SESSION_EXPIRED }));
      }
      const user = await prisma.user.findUnique({ where: { id: context.id }, select: chatUserSelect });
      if (!user) return next(Object.assign(new Error('UNAUTHENTICATED'), { data: SESSION_EXPIRED }));
      socket.data = { user, tokenVersion: payload.tv, expiresAt: payload.exp * 1000 };
      return next();
    } catch (err) {
      logger.error({ err }, 'chat socket authentication failed');
      return next(new Error('INTERNAL_ERROR'));
    }
  });

  io.on('connection', async (socket) => {
    const { user } = socket.data;
    // Listeners first: anything the client emits right after connecting must not be lost to the awaits below.
    registerHandlers(io, socket);
    try {
      await socket.join([GLOBAL_CHAT_ROOM, userRoom(user.id)]);
      const sockets = await io.in(userRoom(user.id)).fetchSockets();
      if (sockets.length === 1) socket.to(GLOBAL_CHAT_ROOM).emit('chat:user:online', { user });
    } catch (err) {
      logger.warn({ err }, 'chat presence update failed');
    }
  });

  chatRealtime.bind(io);

  return {
    io,
    async close() {
      chatRealtime.unbind();
      io.local.disconnectSockets(true);
      io.engine.close();
      await Promise.allSettled([pub.quit(), sub.quit()]);
    },
  };
}
