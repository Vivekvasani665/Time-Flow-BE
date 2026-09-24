import { createHmac, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { AppError } from '../../common/errors';
import { fullName } from '../../common/utils/request-context';
import { sendMail } from '../../queue/mailer';
import { sendSms } from '../../queue/sms';
import { renderSignupOtpEmail } from '../../queue/templates';
import { activityService, type ActivityOrigin } from '../activity-logs/activity.service';
import { maskEmail } from './login-otp.service';

/** Wrong guesses allowed against one code before it stops working. */
export const SIGNUP_OTP_MAX_ATTEMPTS = 5;
/** Codes one signup may send (the first plus resends) before the user has to sign up again. */
export const SIGNUP_OTP_MAX_SENDS = 5;
/** However many resends, a signup cannot be kept waiting for its code longer than this. */
const SIGNUP_OTP_LIFETIME_MS = 30 * 60 * 1000;

export type OtpChannel = 'email' | 'sms';
export const OTP_CHANNELS: readonly OtpChannel[] = ['email', 'sms'];

export type SignupOtpChallenge = {
  requiresVerification: true;
  verificationId: string;
  /** Where the code went, masked — the client already knows the full values. */
  email: string;
  phone: string;
  /** Channels the current code actually reached. */
  channels: OtpChannel[];
  expiresAt: Date;
  resendAvailableAt: Date;
  /** Relative twins of the two dates, so a client with a wrong clock still counts down correctly. */
  expiresInSeconds: number;
  resendAvailableInSeconds: number;
};

type OtpUser = { id: string; email: string; phone: string | null; firstName: string; lastName: string };

// ── Errors the client branches on ───────────────────────────
const sessionInvalid = () =>
  new AppError(401, 'SIGNUP_OTP_SESSION_INVALID', 'This verification is no longer valid. Please sign up again.');
const otpExpired = () => new AppError(401, 'SIGNUP_OTP_EXPIRED', 'This code has expired. Request a new one.');
const tooManyAttempts = () =>
  new AppError(429, 'SIGNUP_OTP_TOO_MANY_ATTEMPTS', 'Too many incorrect codes. Request a new code to try again.');
const deliveryFailed = () =>
  new AppError(503, 'OTP_DELIVERY_FAILED', 'We could not send your verification code. Please try again in a moment.');

/** Keyed by a server secret, with the row id mixed in — see login-otp.service for why. */
let hmacKey: Buffer | null = null;
function hashOtp(verificationId: string, otp: string): string {
  hmacKey ??= scryptSync(env.JWT_ACCESS_SECRET, 'timeflow.signup-otp.v1', 32);
  return createHmac('sha256', hmacKey).update(`${verificationId}:${otp}`).digest('hex');
}

function otpMatches(stored: string, verificationId: string, otp: string): boolean {
  return timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(hashOtp(verificationId, otp), 'hex'));
}

/** Uniform over 000000–999999 from the OS CSPRNG. */
const generateOtp = () => randomInt(0, 1_000_000).toString().padStart(6, '0');

const ttlMs = () => env.SIGNUP_OTP_TTL_MINUTES * 60 * 1000;
const cooldownMs = () => env.SIGNUP_OTP_RESEND_COOLDOWN_SECONDS * 1000;
const relativeTimes = () => ({ expiresInSeconds: env.SIGNUP_OTP_TTL_MINUTES * 60, resendAvailableInSeconds: env.SIGNUP_OTP_RESEND_COOLDOWN_SECONDS });

/** `+919876543210` → `+91******3210`. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 6) return `+${'*'.repeat(digits.length)}`;
  return `+${digits.slice(0, 2)}${'*'.repeat(digits.length - 6)}${digits.slice(-4)}`;
}

/**
 * Sends the code on each requested channel. Returns the channels that got it;
 * throws only when none did. Never logs or returns the code.
 */
async function deliver(user: OtpUser, otp: string, channels: readonly OtpChannel[]): Promise<OtpChannel[]> {
  const minutes = env.SIGNUP_OTP_TTL_MINUTES;
  const send = (channel: OtpChannel) => {
    if (channel === 'email') return sendMail(renderSignupOtpEmail(user.email, { firstName: user.firstName, code: otp, minutes }));
    if (!user.phone) return Promise.reject(new Error('user has no mobile number'));
    return sendSms({
      to: user.phone,
      body: `Your TimeFlow verification code is ${otp}. It will expire in ${minutes} minutes. Do not share it with anyone.`,
      vars: { otp, minutes },
    });
  };

  const results = await Promise.allSettled(channels.map(send));
  const delivered: OtpChannel[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') delivered.push(channels[i]);
    else logger.error({ userId: user.id, channel: channels[i], reason: r.reason instanceof Error ? r.reason.message : String(r.reason) }, 'signup OTP could not be sent');
  });
  if (delivered.length === 0) throw deliveryFailed();
  return delivered;
}

export const signupOtpService = {
  /** Called right after the PENDING user is created. */
  async start(user: OtpUser, origin: ActivityOrigin): Promise<SignupOtpChallenge> {
    const id = randomUUID();
    const otp = generateOtp();
    const now = Date.now();
    const expiresAt = new Date(now + ttlMs());

    await prisma.signupOtp.create({ data: { id, userId: user.id, otpHash: hashOtp(id, otp), expiresAt, lastSentAt: new Date(now) } });
    const channels = await deliver(user, otp, OTP_CHANNELS);
    await prisma.signupOtp.update({ where: { id }, data: { channels } });

    void activityService.record(origin, {
      action: 'auth.signup_otp_sent',
      entity: 'auth',
      entityId: user.id,
      description: `Verification code sent to ${fullName(user)}`,
      metadata: { channels },
    });
    return {
      requiresVerification: true,
      verificationId: id,
      email: maskEmail(user.email),
      phone: user.phone ? maskPhone(user.phone) : '',
      channels,
      expiresAt,
      resendAvailableAt: new Date(now + cooldownMs()),
      ...relativeTimes(),
    };
  },

  /**
   * Checks a code and, on success, activates the account. Returns the user id;
   * every failure throws. The attempt is counted *before* comparing,
   * atomically, so parallel guesses cannot exceed the limit.
   */
  async verify(verificationId: string, otp: string, origin: Omit<ActivityOrigin, 'actorId'>): Promise<string> {
    const row = await prisma.signupOtp.findUnique({
      where: { id: verificationId },
      include: { user: { select: { status: true, deletedAt: true, firstName: true, lastName: true, email: true } } },
    });
    if (!row || row.verifiedAt || row.user.deletedAt || row.user.status !== 'PENDING') throw sessionInvalid();
    if (row.expiresAt.getTime() <= Date.now()) throw otpExpired();
    if (row.attempts >= SIGNUP_OTP_MAX_ATTEMPTS) throw tooManyAttempts();

    const claimed = await prisma.signupOtp.updateMany({
      where: {
        id: row.id,
        verifiedAt: null,
        otpHash: row.otpHash, // not rotated by a concurrent resend
        attempts: { lt: SIGNUP_OTP_MAX_ATTEMPTS },
        expiresAt: { gt: new Date() },
      },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0) throw tooManyAttempts();

    if (!otpMatches(row.otpHash, row.id, otp)) {
      const remaining = SIGNUP_OTP_MAX_ATTEMPTS - (row.attempts + 1);
      if (remaining <= 0) throw tooManyAttempts();
      throw new AppError(400, 'SIGNUP_OTP_INVALID', `Incorrect code. ${remaining} ${remaining === 1 ? 'attempt' : 'attempts'} left.`);
    }

    // Single use, and only a still-PENDING user is activated.
    const activated = await prisma.$transaction(async (tx) => {
      const used = await tx.signupOtp.updateMany({ where: { id: row.id, verifiedAt: null }, data: { verifiedAt: new Date() } });
      if (used.count === 0) return false;
      const user = await tx.user.updateMany({ where: { id: row.userId, status: 'PENDING', deletedAt: null }, data: { status: 'ACTIVE' } });
      return user.count === 1;
    });
    if (!activated) throw sessionInvalid();

    void activityService.record(
      { actorId: row.userId, ...origin },
      {
        action: 'user.verified',
        entity: 'user',
        entityId: row.userId,
        description: `${fullName(row.user)} verified their account`,
        metadata: { email: row.user.email, channels: row.channels },
      },
    );
    return row.userId;
  },

  /** Sends a new code on the chosen channel(s); the previous code stops working immediately. */
  async resend(verificationId: string, channels: readonly OtpChannel[], origin: Omit<ActivityOrigin, 'actorId'>) {
    const row = await prisma.signupOtp.findUnique({
      where: { id: verificationId },
      include: { user: { select: { id: true, email: true, phone: true, firstName: true, lastName: true, status: true, deletedAt: true } } },
    });
    if (!row || row.verifiedAt || row.createdAt.getTime() + SIGNUP_OTP_LIFETIME_MS <= Date.now()) throw sessionInvalid();
    if (row.user.deletedAt || row.user.status !== 'PENDING') throw sessionInvalid();
    if (row.sendCount >= SIGNUP_OTP_MAX_SENDS) {
      throw new AppError(429, 'SIGNUP_OTP_RESEND_LIMIT', 'Too many codes requested. Please sign up again.');
    }

    const waitMs = row.lastSentAt.getTime() + cooldownMs() - Date.now();
    if (waitMs > 0) {
      const seconds = Math.ceil(waitMs / 1000);
      throw new AppError(429, 'SIGNUP_OTP_RESEND_COOLDOWN', `Please wait ${seconds} ${seconds === 1 ? 'second' : 'seconds'} before requesting a new code.`);
    }

    const otp = generateOtp();
    const now = Date.now();
    const expiresAt = new Date(now + ttlMs());
    // Optimistic lock on lastSentAt: of two simultaneous resends, one wins.
    const rotated = await prisma.signupOtp.updateMany({
      where: { id: row.id, verifiedAt: null, lastSentAt: row.lastSentAt },
      data: { otpHash: hashOtp(row.id, otp), expiresAt, attempts: 0, sendCount: { increment: 1 }, lastSentAt: new Date(now), channels: [] },
    });
    if (rotated.count === 0) {
      throw new AppError(429, 'SIGNUP_OTP_RESEND_COOLDOWN', 'A new code was just sent. Please check your email and phone.');
    }

    let delivered: OtpChannel[];
    try {
      delivered = await deliver(row.user, otp, channels);
    } catch (err) {
      // Let the user retry straight away rather than wait out a cooldown for a code that never left.
      await prisma.signupOtp.updateMany({ where: { id: row.id }, data: { lastSentAt: row.lastSentAt } });
      throw err;
    }
    await prisma.signupOtp.update({ where: { id: row.id }, data: { channels: delivered } });

    void activityService.record(
      { actorId: row.userId, ...origin },
      {
        action: 'auth.signup_otp_sent',
        entity: 'auth',
        entityId: row.userId,
        description: `Verification code re-sent to ${fullName(row.user)}`,
        metadata: { channels: delivered },
      },
    );
    return {
      verificationId: row.id,
      email: maskEmail(row.user.email),
      phone: row.user.phone ? maskPhone(row.user.phone) : '',
      channels: delivered,
      expiresAt,
      resendAvailableAt: new Date(now + cooldownMs()),
      ...relativeTimes(),
    };
  },
};
