import type { Prisma } from '@prisma/client';
import { chatUserSelect } from '../chat/chat.repository';
import type { CallDto, CallHistoryItem } from './call.types';

export const callSelect = {
  id: true,
  type: true,
  status: true,
  callerId: true,
  receiverId: true,
  callerSocketId: true,
  receiverSocketId: true,
  startedAt: true,
  answeredAt: true,
  connectedAt: true,
  endedAt: true,
  durationSeconds: true,
  caller: { select: chatUserSelect },
  receiver: { select: chatUserSelect },
} satisfies Prisma.CallSelect;

export type CallRecord = Prisma.CallGetPayload<{ select: typeof callSelect }>;

/** Socket ids are routing details and never leave the server. */
export function toCallDto(r: CallRecord): CallDto {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    caller: r.caller,
    receiver: r.receiver,
    startedAt: r.startedAt,
    answeredAt: r.answeredAt,
    connectedAt: r.connectedAt,
    endedAt: r.endedAt,
    durationSeconds: r.durationSeconds,
  };
}

export function toHistoryItem(r: CallRecord, viewerId: string): CallHistoryItem {
  return { ...toCallDto(r), direction: r.callerId === viewerId ? 'outgoing' : 'incoming' };
}

/** Calls the user is part of that have not finished. */
export const activeCallWhere = (userId: string): Prisma.CallWhereInput => ({
  status: { in: ['RINGING', 'ACCEPTED', 'CONNECTED'] },
  OR: [{ callerId: userId }, { receiverId: userId }],
});
