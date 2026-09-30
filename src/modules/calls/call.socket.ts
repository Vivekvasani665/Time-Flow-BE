import type { Socket } from 'socket.io';
import type { ZodType } from 'zod';
import { logger } from '../../lib/logger';
import type { AuthContext } from '../auth/auth.types';
import { answerSchema, callRefSchema, endCallSchema, iceCandidateSchema, initiateCallSchema, mediaStateSchema, offerSchema } from './call.schemas';
import { callService } from './call.service';

/** The chat socket's validated, re-authorised event registration (see chat.socket.ts). */
export type RegisterHandler = <T>(event: string, schema: ZodType<T>, run: (actor: AuthContext, input: T) => Promise<unknown>) => void;

/**
 * Call signaling on the existing authenticated chat socket. The caller and
 * receiver are always the socket's own user, re-checked on every event; ids in
 * payloads only ever name a call, and the service verifies the user is in it.
 * Media never passes through here — only SDP and ICE candidates.
 */
export function registerCallHandlers(socket: Socket, userId: string, handle: RegisterHandler) {
  handle('call:initiate', initiateCallSchema, (actor, input) => callService.initiate(actor, socket.id, input));
  handle('call:accept', callRefSchema, (actor, { callId }) => callService.accept(actor, socket.id, callId));
  handle('call:reject', callRefSchema, (actor, { callId }) => callService.reject(actor, callId));
  handle('call:end', endCallSchema, (actor, input) => callService.end(actor, input));
  handle('call:connected', callRefSchema, (actor, { callId }) => callService.markConnected(actor, socket.id, callId));
  handle('call:resume', callRefSchema, (actor, { callId }) => callService.resume(actor, socket.id, callId));
  handle('call:offer', offerSchema, (actor, input) => callService.relay(actor, socket.id, 'call:offer', input));
  handle('call:answer', answerSchema, (actor, input) => callService.relay(actor, socket.id, 'call:answer', input));
  handle('call:ice-candidate', iceCandidateSchema, (actor, input) => callService.relay(actor, socket.id, 'call:ice-candidate', input));
  handle('call:media-state', mediaStateSchema, (actor, input) => callService.relay(actor, socket.id, 'call:media-state', input));

  socket.on('disconnect', () => {
    callService.onSocketDisconnect(userId, socket.id).catch((err: unknown) => logger.error({ err, userId }, 'call disconnect cleanup failed'));
  });
}
