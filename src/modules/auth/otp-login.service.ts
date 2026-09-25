import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { logger } from '../../lib/logger';
import { AppError, ForbiddenError } from '../../common/errors';
import { randomToken, sha256 } from '../../common/utils/crypto';
import { fullName } from '../../common/utils/request-context';
import { renderLoginOtpEmail } from '../../queue/templates';
import { activityService } from '../activity-logs/activity.service';
import { maskEmail } from './login-otp.service';
import {
  channelsFor,
  deliverOtp,
  deliveryDetails,
  generateOtp,
  maskPhone,
  smsCodeMatches,
  type DeliverySummary,
  type OtpChannel,
} from './otp-delivery';

/**
 * Passwordless sign-in: email or mobile number → one code by email + SMS →
 * token + code → session. Nothing touches the database until the code is
 * right; the pending attempt lives in Redis:
 *
 *   otp:login:<sha256(token)>  hash { userId, tv, otpHash, expiresAt, attempts, sendCount, lastSentAt, createdAt, channels }
 *   otp:login:user:<userId>    sha256(token) of that user's live attempt (one per user)
 *
 * Only a SHA-256 of the token is used as the key, so a Redis dump cannot be
 * replayed, and the code itself is kept only as an HMAC.
 */

/** Wrong guesses allowed per code. */
export const OTP_LOGIN_MAX_ATTEMPTS = 5;
/** Codes one token may send (the first plus resends). */
export const OTP_LOGIN_MAX_SENDS = 5;
/** However many resends, a token dies this long after it was issued. */
const OTP_LOGIN_LIFETIME_SECONDS = 30 * 60;

/** KEYS[1] token key; ARGV: expected lastSentAt, new otpHash, new expiresAt, now. */
const ROTATE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'lastSentAt') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'otpHash', ARGV[2], 'expiresAt', ARGV[3], 'attempts', 0, 'lastSentAt', ARGV[4], 'channels', '')
redis.call('HINCRBY', KEYS[1], 'sendCount', 1)
return 1`;

const tokenKey = (tokenHash: string) => `otp:login:${tokenHash}`;
const userKey = (userId: string) => `otp:login:user:${userId}`;

type ClientInfo = { ip: string | null; userAgent: string | null };

export type OtpLoginChallenge = {
  /** Sent back with the code. Opaque; valid until the code is used or the attempt dies. */
  token: string;
  email: string;
  phone: string | null;
  expiresAt: Date;
  resendAvailableAt: Date;
  expiresInSeconds: number;
  resendAvailableInSeconds: number;
} & DeliverySummary;

type OtpUser = { id: string; email: string; phone: string | null; firstName: string; lastName: string; tokenVersion: number };

const userSelect = { id: true, email: true, phone: true, firstName: true, lastName: true, tokenVersion: true, status: true } as const;

// ── Errors the client branches on ───────────────────────────
const tokenInvalid = () => new AppError(401, 'OTP_TOKEN_INVALID', 'This sign-in code is no longer valid. Request a new code.');
const otpExpired = () => new AppError(401, 'OTP_EXPIRED', 'This code has expired. Request a new one.');
const maxAttempts = () => new AppError(429, 'OTP_MAX_ATTEMPTS', 'Too many incorrect codes. Request a new code to try again.');

let hmacKey: Buffer | null = null;
function hashOtp(tokenHash: string, otp: string): string {
  hmacKey ??= scryptSync(env.JWT_ACCESS_SECRET, 'timeflow.otp-login.v1', 32);
  return createHmac('sha256', hmacKey).update(`${tokenHash}:${otp}`).digest('hex');
}

const ttlMs = () => env.LOGIN_OTP_TTL_MINUTES * 60 * 1000;
const cooldownMs = () => env.LOGIN_OTP_RESEND_COOLDOWN_SECONDS * 1000;

/** The account behind an email address or a mobile number (digits compared, like the unique index). */
async function findUser(input: { email?: string; phone?: string }) {
  if (input.email) return prisma.user.findFirst({ where: { email: input.email, deletedAt: null }, select: userSelect });
  const digits = (input.phone ?? '').replace(/\D/g, '');
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM users
    WHERE deleted_at IS NULL AND phone IS NOT NULL AND regexp_replace(phone, '[^0-9]', '', 'g') = ${digits}
    LIMIT 1`;
  return rows[0] ? prisma.user.findUnique({ where: { id: rows[0].id }, select: userSelect }) : null;
}

function assertCanSignIn(user: { status: string } | null): asserts user {
  if (!user) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'No account found for this email or mobile number.');
  if (user.status === 'PENDING') {
    throw new ForbiddenError('Your account is not verified yet. Finish signing up first.', 'ACCOUNT_NOT_VERIFIED');
  }
  if (user.status !== 'ACTIVE') throw new ForbiddenError('Your account is inactive. Contact an administrator.', 'ACCOUNT_INACTIVE');
}

const deliver = (user: OtpUser, otp: string, channels: readonly OtpChannel[]) =>
  deliverOtp({
    user,
    otp,
    minutes: env.LOGIN_OTP_TTL_MINUTES,
    channels,
    email: renderLoginOtpEmail(user.email, { firstName: user.firstName, code: otp, minutes: env.LOGIN_OTP_TTL_MINUTES }),
    purpose: 'login',
    noneDelivered: (delivery) =>
      new AppError(503, 'OTP_DELIVERY_FAILED', 'We could not send your verification code. Please try again in a moment.', deliveryDetails(delivery)),
  });

function challenge(token: string, user: OtpUser, summary: DeliverySummary, now: number): OtpLoginChallenge {
  return {
    token,
    email: maskEmail(user.email),
    phone: user.phone ? maskPhone(user.phone) : null,
    ...summary,
    expiresAt: new Date(now + ttlMs()),
    resendAvailableAt: new Date(now + cooldownMs()),
    expiresInSeconds: env.LOGIN_OTP_TTL_MINUTES * 60,
    resendAvailableInSeconds: env.LOGIN_OTP_RESEND_COOLDOWN_SECONDS,
  };
}

export const otpLoginService = {
  /** POST /send-otp — issues a token and sends one code by email and SMS. */
  async send(input: { email?: string; phone?: string }, client: ClientInfo): Promise<OtpLoginChallenge> {
    const user = await findUser(input);
    assertCanSignIn(user);

    // One live attempt per user, and no new code inside the cooldown.
    const previous = await redis.get(userKey(user.id));
    if (previous) {
      const lastSentAt = Number(await redis.hget(tokenKey(previous), 'lastSentAt'));
      const waitMs = lastSentAt + cooldownMs() - Date.now();
      if (waitMs > 0) {
        const seconds = Math.ceil(waitMs / 1000);
        throw new AppError(429, 'OTP_RATE_LIMITED', `Please wait ${seconds} ${seconds === 1 ? 'second' : 'seconds'} before requesting a new code.`);
      }
    }

    const token = randomToken(32);
    const tokenHash = sha256(token);
    const otp = generateOtp();
    const now = Date.now();
    await redis
      .multi()
      .del(...(previous ? [tokenKey(previous)] : []), tokenKey(tokenHash))
      .hset(tokenKey(tokenHash), {
        userId: user.id,
        tv: user.tokenVersion,
        otpHash: hashOtp(tokenHash, otp),
        expiresAt: now + ttlMs(),
        attempts: 0,
        sendCount: 1,
        lastSentAt: now,
        createdAt: now,
        channels: '',
      })
      .expire(tokenKey(tokenHash), OTP_LOGIN_LIFETIME_SECONDS)
      .set(userKey(user.id), tokenHash, 'EX', OTP_LOGIN_LIFETIME_SECONDS)
      .exec();
    logger.info({ userId: user.id, expiresInSeconds: env.LOGIN_OTP_TTL_MINUTES * 60 }, '[OTP] token login OTP generated and stored');

    let summary: DeliverySummary;
    try {
      summary = await deliver(user, otp, channelsFor(user));
    } catch (err) {
      await redis.del(tokenKey(tokenHash), userKey(user.id));
      throw err;
    }
    await redis.hset(tokenKey(tokenHash), 'channels', summary.channels.join(','));

    void activityService.record(
      { actorId: user.id, ...client },
      { action: 'auth.otp_login_sent', entity: 'auth', entityId: user.id, description: `Sign-in code sent to ${fullName(user)}`, metadata: { channels: summary.channels } },
    );
    return challenge(token, user, summary, now);
  },

  /**
   * POST /verify-otp — checks token + code. Returns the user id and the token
   * version it was issued under; the caller turns that into a session. The
   * attempt is counted before comparing (atomic HINCRBY), and a correct code
   * deletes the token, so it works exactly once.
   */
  async verify(token: string, otp: string, client: ClientInfo): Promise<{ userId: string; tokenVersion: number }> {
    const tokenHash = sha256(token);
    const key = tokenKey(tokenHash);
    logger.info({}, '[OTP] token login verification started');

    const row = await redis.hgetall(key);
    if (!row.userId) throw tokenInvalid();
    if (Number(row.expiresAt) <= Date.now()) throw otpExpired();

    const attempts = await redis.hincrby(key, 'attempts', 1);
    if (attempts > OTP_LOGIN_MAX_ATTEMPTS) throw maxAttempts();

    const user = await prisma.user.findFirst({ where: { id: row.userId, deletedAt: null }, select: userSelect });
    // Deactivated, deleted or password changed since the code was sent.
    if (!user || user.status !== 'ACTIVE' || user.tokenVersion !== Number(row.tv)) {
      await redis.del(key, userKey(row.userId));
      throw tokenInvalid();
    }

    const channels = row.channels ? row.channels.split(',') : [];
    const matched =
      timingSafeEqual(Buffer.from(row.otpHash, 'hex'), Buffer.from(hashOtp(tokenHash, otp), 'hex')) ||
      (await smsCodeMatches(user.phone, channels, otp));
    if (!matched) {
      const remaining = OTP_LOGIN_MAX_ATTEMPTS - attempts;
      logger.warn({ userId: user.id, remaining }, '[OTP] token login verification failed: wrong code');
      void activityService.record(
        { actorId: user.id, ...client },
        { action: 'auth.login_otp_failed', entity: 'auth', entityId: user.id, description: 'Incorrect sign-in code entered' },
      );
      if (remaining <= 0) throw maxAttempts();
      throw new AppError(400, 'INVALID_OTP', `Incorrect code. ${remaining} ${remaining === 1 ? 'attempt' : 'attempts'} left.`);
    }

    // Single use: of two requests with the right code, only one deletes the key.
    const deleted = await redis.del(key);
    if (deleted === 0) throw tokenInvalid();
    await redis.del(userKey(user.id));
    logger.info({ userId: user.id }, '[OTP] token login verification successful');
    return { userId: user.id, tokenVersion: user.tokenVersion };
  },

  /** POST /resend-otp — a new code on the same token; the previous code stops working. */
  async resend(token: string, requested: readonly OtpChannel[] | undefined, client: ClientInfo): Promise<OtpLoginChallenge> {
    const tokenHash = sha256(token);
    const key = tokenKey(tokenHash);
    const row = await redis.hgetall(key);
    if (!row.userId) throw tokenInvalid();
    if (Number(row.sendCount) >= OTP_LOGIN_MAX_SENDS) {
      throw new AppError(429, 'OTP_RATE_LIMITED', 'Too many codes requested. Start signing in again.');
    }
    const waitMs = Number(row.lastSentAt) + cooldownMs() - Date.now();
    if (waitMs > 0) {
      const seconds = Math.ceil(waitMs / 1000);
      throw new AppError(429, 'OTP_RATE_LIMITED', `Please wait ${seconds} ${seconds === 1 ? 'second' : 'seconds'} before requesting a new code.`);
    }

    const user = await prisma.user.findFirst({ where: { id: row.userId, deletedAt: null }, select: userSelect });
    if (!user || user.status !== 'ACTIVE' || user.tokenVersion !== Number(row.tv)) throw tokenInvalid();
    const channels = channelsFor(user, requested);
    if (channels.length === 0) throw new AppError(400, 'INVALID_PHONE_NUMBER', 'This account has no mobile number. Request the code by email instead.');

    const otp = generateOtp();
    const now = Date.now();
    // Compare-and-set on lastSentAt, atomically in Redis: of two simultaneous resends, one wins.
    const rotated = await redis.eval(
      ROTATE_SCRIPT,
      1,
      key,
      row.lastSentAt,
      hashOtp(tokenHash, otp),
      String(now + ttlMs()),
      String(now),
    );
    if (rotated !== 1) throw new AppError(429, 'OTP_RATE_LIMITED', 'A new code was just sent. Check your email and phone.');
    logger.info({ userId: user.id, channels }, '[OTP] token login OTP regenerated and stored for resend');

    let summary: DeliverySummary;
    try {
      summary = await deliver(user, otp, channels);
    } catch (err) {
      // Let the user retry straight away rather than wait out a cooldown for a code that never left.
      await redis.hset(key, 'lastSentAt', row.lastSentAt);
      throw err;
    }
    await redis.hset(key, 'channels', summary.channels.join(','));

    void activityService.record(
      { actorId: user.id, ...client },
      { action: 'auth.otp_login_sent', entity: 'auth', entityId: user.id, description: `Sign-in code re-sent to ${fullName(user)}`, metadata: { channels: summary.channels } },
    );
    return challenge(token, user, summary, now);
  },
};
