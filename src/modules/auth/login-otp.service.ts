import { createHmac, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { AppError, UnauthorizedError } from '../../common/errors';
import { fullName } from '../../common/utils/request-context';
import { sendMail } from '../../queue/mailer';
import { renderLoginOtpEmail } from '../../queue/templates';
import { activityService, type ActivityOrigin } from '../activity-logs/activity.service';

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
  expiresAt: Date;
  resendAvailableAt: Date;
  /** Relative twins of the two dates, so a client with a wrong clock still counts down correctly. */
  expiresInSeconds: number;
  resendAvailableInSeconds: number;
};

type OtpUser = { id: string; email: string; firstName: string; lastName: string };

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

/** Uniform over 000000–999999 from the OS CSPRNG. */
const generateOtp = () => randomInt(0, 1_000_000).toString().padStart(6, '0');

const ttlMs = () => env.LOGIN_OTP_TTL_MINUTES * 60 * 1000;
const cooldownMs = () => env.LOGIN_OTP_RESEND_COOLDOWN_SECONDS * 1000;

const relativeTimes = () => ({ expiresInSeconds: env.LOGIN_OTP_TTL_MINUTES * 60, resendAvailableInSeconds: env.LOGIN_OTP_RESEND_COOLDOWN_SECONDS });

/** `vivek@gmail.com` → `v****@gmail.com`. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, Math.min(local.length - 1, 6)))}@${domain}`;
}

/** Never logs or returns the code; a failure is reported without the message body. */
async function deliver(user: OtpUser, otp: string): Promise<void> {
  try {
    await sendMail(renderLoginOtpEmail(user.email, { firstName: user.firstName, code: otp, minutes: env.LOGIN_OTP_TTL_MINUTES }));
  } catch (err) {
    logger.error({ userId: user.id, reason: err instanceof Error ? err.message : String(err) }, 'login OTP email could not be sent');
    throw deliveryFailed();
  }
}

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

    try {
      await deliver(user, otp);
    } catch (err) {
      await prisma.loginOtp.deleteMany({ where: { id } });
      throw err;
    }

    void activityService.record(origin, {
      action: 'auth.login_otp_sent',
      entity: 'auth',
      entityId: user.id,
      description: `Sign-in code emailed to ${fullName(user)}`,
    });
    return {
      requiresOtp: true,
      verificationId: id,
      email: maskEmail(user.email),
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
    const row = await prisma.loginOtp.findUnique({ where: { id: verificationId } });
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

    if (!otpMatches(row.otpHash, row.id, otp)) {
      const remaining = LOGIN_OTP_MAX_ATTEMPTS - (row.attempts + 1);
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
    return row.userId;
  },

  /** Sends a new code on the same attempt; the previous code stops working immediately. */
  async resend(verificationId: string, origin: Omit<ActivityOrigin, 'actorId'>) {
    const row = await prisma.loginOtp.findUnique({
      where: { id: verificationId },
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true, status: true, deletedAt: true } } },
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

    try {
      await deliver(row.user, otp);
    } catch (err) {
      // Let the user retry straight away rather than wait out a cooldown for mail that never left.
      await prisma.loginOtp.updateMany({ where: { id: row.id }, data: { lastSentAt: row.lastSentAt } });
      throw err;
    }

    void activityService.record(
      { actorId: row.userId, ...origin },
      { action: 'auth.login_otp_sent', entity: 'auth', entityId: row.userId, description: `Sign-in code re-sent to ${fullName(row.user)}` },
    );
    return {
      verificationId: row.id,
      email: maskEmail(row.user.email),
      expiresAt,
      resendAvailableAt: new Date(now + cooldownMs()),
      ...relativeTimes(),
    };
  },
};
