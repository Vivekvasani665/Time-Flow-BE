import { createHmac, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { AppError, UnauthorizedError } from '../../common/errors';
import { fullName } from '../../common/utils/request-context';
import { renderLoginOtpEmail } from '../../queue/templates';
import { activityService, type ActivityOrigin } from '../activity-logs/activity.service';
import { channelsFor, deliverOtp, deliveryDetails, generateOtp, maskPhone, smsCodeMatches, type DeliverySummary, type OtpChannel } from './otp-delivery';

/** Wrong guesses allowed against one code before it stops working. */
export const LOGIN_OTP_MAX_ATTEMPTS = 5;
/** Codes one sign-in attempt may send (the first plus resends) before a fresh password is needed. */
export const LOGIN_OTP_MAX_SENDS = 5;
/** However many resends, a sign-in attempt cannot be kept alive longer than this. */
const LOGIN_OTP_ATTEMPT_LIFETIME_MS = 30 * 60 * 1000;

export type LoginOtpChallenge = {
  requiresOtp: true;
  verificationId: string;
  /** Where the code went, masked — the client already knows the full address. */
  email: string;
  /** The account's mobile number, masked; null when it has none (email only). */
  phone: string | null;
  expiresAt: Date;
  resendAvailableAt: Date;
  /** Relative twins of the two dates, so a client with a wrong clock still counts down correctly. */
  expiresInSeconds: number;
  resendAvailableInSeconds: number;
} & DeliverySummary;

type OtpUser = { id: string; email: string; phone: string | null; firstName: string; lastName: string };

// ── Errors the client branches on ───────────────────────────
const sessionInvalid = () =>
  new UnauthorizedError('This sign-in attempt is no longer valid. Please sign in again.', 'LOGIN_OTP_SESSION_INVALID');
const otpExpired = () => new AppError(401, 'LOGIN_OTP_EXPIRED', 'This code has expired. Request a new one.');
const tooManyAttempts = () =>
  new AppError(429, 'LOGIN_OTP_TOO_MANY_ATTEMPTS', 'Too many incorrect codes. Request a new code to try again.');
const deliveryFailed = () =>
  new AppError(503, 'EMAIL_DELIVERY_FAILED', 'We could not send your verification code. Please try again in a moment.');

/**
 * Keyed by a server secret, so a leaked database row cannot be reversed by
 * hashing all million candidates. The row id is mixed in so identical codes
 * on different rows never share a hash.
 */
let hmacKey: Buffer | null = null;
function hashOtp(verificationId: string, otp: string): string {
  hmacKey ??= scryptSync(env.JWT_ACCESS_SECRET, 'timeflow.login-otp.v1', 32);
  return createHmac('sha256', hmacKey).update(`${verificationId}:${otp}`).digest('hex');
}

function otpMatches(stored: string, verificationId: string, otp: string): boolean {
  return timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(hashOtp(verificationId, otp), 'hex'));
}


const ttlMs = () => env.LOGIN_OTP_TTL_MINUTES * 60 * 1000;
const cooldownMs = () => env.LOGIN_OTP_RESEND_COOLDOWN_SECONDS * 1000;

const relativeTimes = () => ({ expiresInSeconds: env.LOGIN_OTP_TTL_MINUTES * 60, resendAvailableInSeconds: env.LOGIN_OTP_RESEND_COOLDOWN_SECONDS });

/** `vivek@gmail.com` → `v****@gmail.com`. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, Math.min(local.length - 1, 6)))}@${domain}`;
}

/**
 * The same code by email and — when the account has a mobile number — SMS.
 * Fails only when no channel got it: EMAIL_DELIVERY_FAILED for an email-only
 * account (as before), OTP_DELIVERY_FAILED with per-channel reasons otherwise.
 */
const deliver = (user: OtpUser, otp: string, channels: readonly OtpChannel[]) =>
  deliverOtp({
    user,
    otp,
    minutes: env.LOGIN_OTP_TTL_MINUTES,
    channels,
    email: renderLoginOtpEmail(user.email, { firstName: user.firstName, code: otp, minutes: env.LOGIN_OTP_TTL_MINUTES }),
    purpose: 'login',
    noneDelivered: (delivery) =>
      channels.length === 1 && channels[0] === 'email'
        ? deliveryFailed()
        : new AppError(503, 'OTP_DELIVERY_FAILED', 'We could not send your verification code. Please try again in a moment.', deliveryDetails(delivery)),
  });

const phoneOf = (user: OtpUser) => (user.phone ? maskPhone(user.phone) : null);

export const loginOtpService = {
  /** Called once the password is verified. Replaces any earlier pending attempt for this user. */
  async start(user: OtpUser, origin: ActivityOrigin): Promise<LoginOtpChallenge> {
    const id = randomUUID();
    const otp = generateOtp();
    const now = Date.now();
    const expiresAt = new Date(now + ttlMs());

    // Signing in again supersedes the previous attempt, so only one code per user is ever live.
    await prisma.$transaction([
      prisma.loginOtp.deleteMany({ where: { userId: user.id } }),
      prisma.loginOtp.create({ data: { id, userId: user.id, otpHash: hashOtp(id, otp), expiresAt, lastSentAt: new Date(now) } }),
    ]);
    logger.info({ userId: user.id, verificationId: id, expiresAt }, '[OTP] login OTP generated and stored');

    let summary: DeliverySummary;
    try {
      summary = await deliver(user, otp, channelsFor(user));
    } catch (err) {
      await prisma.loginOtp.deleteMany({ where: { id } });
      throw err;
    }
    await prisma.loginOtp.update({ where: { id }, data: { channels: summary.channels } });

    void activityService.record(origin, {
      action: 'auth.login_otp_sent',
      entity: 'auth',
      entityId: user.id,
      description: `Sign-in code sent to ${fullName(user)}`,
      metadata: { channels: summary.channels },
    });
    return {
      requiresOtp: true,
      verificationId: id,
      email: maskEmail(user.email),
      phone: phoneOf(user),
      ...summary,
      expiresAt,
      resendAvailableAt: new Date(now + cooldownMs()),
      ...relativeTimes(),
    };
  },

  /**
   * Checks a code and consumes it. Returns the user id on success; every
   * failure throws. The attempt is counted *before* comparing, atomically,
   * so parallel guesses cannot exceed the limit.
   */
  async verify(verificationId: string, otp: string, origin: Omit<ActivityOrigin, 'actorId'>): Promise<string> {
    logger.info({ verificationId }, '[OTP] login verification started');
    const row = await prisma.loginOtp.findUnique({ where: { id: verificationId }, include: { user: { select: { phone: true } } } });
    if (!row || row.usedAt) throw sessionInvalid();
    if (row.expiresAt.getTime() <= Date.now()) throw otpExpired();
    if (row.attempts >= LOGIN_OTP_MAX_ATTEMPTS) throw tooManyAttempts();

    const claimed = await prisma.loginOtp.updateMany({
      where: {
        id: row.id,
        usedAt: null,
        otpHash: row.otpHash, // not rotated by a concurrent resend
        attempts: { lt: LOGIN_OTP_MAX_ATTEMPTS },
        expiresAt: { gt: new Date() },
      },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0) throw tooManyAttempts();

    // The emailed code, or — with Twilio Verify — the provider's own SMS code.
    const matched = otpMatches(row.otpHash, row.id, otp) || (await smsCodeMatches(row.user.phone, row.channels, otp));
    if (!matched) {
      const remaining = LOGIN_OTP_MAX_ATTEMPTS - (row.attempts + 1);
      logger.warn({ verificationId, userId: row.userId, remaining }, '[OTP] login verification failed: wrong code');
      void activityService.record(
        { actorId: row.userId, ...origin },
        { action: 'auth.login_otp_failed', entity: 'auth', entityId: row.userId, description: 'Incorrect sign-in code entered' },
      );
      if (remaining <= 0) throw tooManyAttempts();
      throw new AppError(401, 'LOGIN_OTP_INVALID', `Incorrect code. ${remaining} ${remaining === 1 ? 'attempt' : 'attempts'} left.`);
    }

    // Single use: only one request can flip usedAt.
    const used = await prisma.loginOtp.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (used.count === 0) throw sessionInvalid();
    logger.info({ verificationId, userId: row.userId }, '[OTP] login verification successful');
    return row.userId;
  },

  /** Sends a new code on the same attempt; the previous code stops working immediately. */
  async resend(verificationId: string, origin: Omit<ActivityOrigin, 'actorId'>, requested?: readonly OtpChannel[]) {
    const row = await prisma.loginOtp.findUnique({
      where: { id: verificationId },
      include: { user: { select: { id: true, email: true, phone: true, firstName: true, lastName: true, status: true, deletedAt: true } } },
    });
    if (!row || row.usedAt || row.createdAt.getTime() + LOGIN_OTP_ATTEMPT_LIFETIME_MS <= Date.now()) throw sessionInvalid();
    if (row.user.deletedAt || row.user.status !== 'ACTIVE') throw sessionInvalid();
    if (row.sendCount >= LOGIN_OTP_MAX_SENDS) {
      throw new AppError(429, 'LOGIN_OTP_RESEND_LIMIT', 'Too many codes requested. Please sign in again.');
    }

    const waitMs = row.lastSentAt.getTime() + cooldownMs() - Date.now();
    if (waitMs > 0) {
      const seconds = Math.ceil(waitMs / 1000);
      throw new AppError(429, 'LOGIN_OTP_RESEND_COOLDOWN', `Please wait ${seconds} ${seconds === 1 ? 'second' : 'seconds'} before requesting a new code.`);
    }

    const channels = channelsFor(row.user, requested);
    if (channels.length === 0) {
      throw new AppError(400, 'INVALID_PHONE_NUMBER', 'This account has no mobile number. Request the code by email instead.');
    }

    const otp = generateOtp();
    const now = Date.now();
    const expiresAt = new Date(now + ttlMs());
    // Optimistic lock on lastSentAt: of two simultaneous resends, one wins.
    const rotated = await prisma.loginOtp.updateMany({
      where: { id: row.id, usedAt: null, lastSentAt: row.lastSentAt },
      data: { otpHash: hashOtp(row.id, otp), expiresAt, attempts: 0, sendCount: { increment: 1 }, lastSentAt: new Date(now) },
    });
    if (rotated.count === 0) {
      throw new AppError(429, 'LOGIN_OTP_RESEND_COOLDOWN', 'A new code was just sent. Check your inbox.');
    }

    logger.info({ userId: row.userId, verificationId: row.id, channels }, '[OTP] login OTP regenerated and stored for resend');
    let summary: DeliverySummary;
    try {
      summary = await deliver(row.user, otp, channels);
    } catch (err) {
      // Let the user retry straight away rather than wait out a cooldown for a code that never left.
      await prisma.loginOtp.updateMany({ where: { id: row.id }, data: { lastSentAt: row.lastSentAt } });
      throw err;
    }

    void activityService.record(
      { actorId: row.userId, ...origin },
      {
        action: 'auth.login_otp_sent',
        entity: 'auth',
        entityId: row.userId,
        description: `Sign-in code re-sent to ${fullName(row.user)}`,
        metadata: { channels: summary.channels },
      },
    );
    await prisma.loginOtp.update({ where: { id: row.id }, data: { channels: summary.channels } });
    return {
      verificationId: row.id,
      email: maskEmail(row.user.email),
      phone: phoneOf(row.user),
      ...summary,
      expiresAt,
      resendAvailableAt: new Date(now + cooldownMs()),
      ...relativeTimes(),
    };
  },
};
