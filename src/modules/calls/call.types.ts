import type { CallStatus, CallType } from '@prisma/client';
import type { ChatUser } from '../chat/chat.types';

/** Statuses of a call that is still going: it blocks both people from other calls. */
export const ACTIVE_CALL_STATUSES = ['RINGING', 'ACCEPTED', 'CONNECTED'] as const satisfies readonly CallStatus[];

/** Why a call stopped; lets the client word the outcome ("No answer", "Busy", …). */
export type CallEndReason =
  | 'hangup'
  | 'rejected'
  | 'cancelled'
  | 'no_answer'
  | 'busy'
  | 'offline'
  | 'failed'
  | 'disconnected';

export type CallDto = {
  id: string;
  type: CallType;
  status: CallStatus;
  caller: ChatUser;
  receiver: ChatUser;
  startedAt: Date;
  answeredAt: Date | null;
  connectedAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
};

/** A call from the viewer's side, for history. */
export type CallHistoryItem = CallDto & { direction: 'outgoing' | 'incoming' };

/** Someone who can be called, and whether they have TimeFlow open right now. */
export type CallContact = ChatUser & { online: boolean };

/** Server → client socket events. Every payload names its call. */
export type CallServerEvents = {
  'call:incoming': { call: CallDto };
  'call:accepted': { callId: string };
  /** Another tab of the same user answered; stop ringing here. */
  'call:answered-elsewhere': { callId: string };
  'call:offer': { callId: string; description: SessionDescription };
  'call:answer': { callId: string; description: SessionDescription };
  'call:ice-candidate': { callId: string; candidate: IceCandidate };
  'call:media-state': { callId: string; state: { muted: boolean; cameraOff: boolean } };
  'call:ended': { callId: string; status: CallStatus; reason: CallEndReason; durationSeconds: number | null };
};

export type SessionDescription = { type: 'offer' | 'answer'; sdp: string };
export type IceCandidate = { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null; usernameFragment?: string | null };

export type IceServer = { urls: string[]; username?: string; credential?: string };
