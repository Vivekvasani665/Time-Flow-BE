import { z } from 'zod';

const callId = z.uuid({ message: 'Invalid call' });

export const initiateCallSchema = z
  .object({
    receiverId: z.uuid({ message: 'Invalid person to call' }),
    type: z.enum(['VOICE', 'VIDEO']),
  })
  .strict();

export const callRefSchema = z.object({ callId }).strict();

export const endCallSchema = z
  .object({
    callId,
    /** "failed" when the media connection could not be made or dropped. */
    reason: z.enum(['hangup', 'failed']).default('hangup'),
  })
  .strict();

// SDP for one audio + one video track is a few KB; this leaves room for many codecs and candidates.
const sdp = z.string().min(1).max(20_000);

export const offerSchema = z.object({ callId, description: z.object({ type: z.literal('offer'), sdp }).strict() }).strict();
export const answerSchema = z.object({ callId, description: z.object({ type: z.literal('answer'), sdp }).strict() }).strict();

export const iceCandidateSchema = z
  .object({
    callId,
    candidate: z
      .object({
        candidate: z.string().max(1000),
        sdpMid: z.string().max(64).nullable(),
        sdpMLineIndex: z.number().int().min(0).max(64).nullable(),
        usernameFragment: z.string().max(256).nullable().optional(),
      })
      .strict(),
  })
  .strict();

/** Tells the other side this person muted or turned their camera off, so their tile can say so. */
export const mediaStateSchema = z
  .object({ callId, state: z.object({ muted: z.boolean(), cameraOff: z.boolean() }).strict() })
  .strict();

export const callHistoryQuerySchema = z.object({
  /** The other person. */
  userId: z.uuid({ message: 'Invalid user' }),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type InitiateCallInput = z.infer<typeof initiateCallSchema>;
export type EndCallInput = z.infer<typeof endCallSchema>;
export type CallHistoryQuery = z.infer<typeof callHistoryQuerySchema>;
