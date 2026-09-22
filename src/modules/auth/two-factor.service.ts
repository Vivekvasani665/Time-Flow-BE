import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import QRCode from 'qrcode';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { logger } from '../../lib/logger';
import { SlidingWindowRateLimiter } from '../../cache/rate-limiter';
import { BadRequestError, ConflictError, NotFoundError, RateLimitError } from '../../common/errors';
import { decryptSecret, encryptSecret, sha256 } from '../../common/utils/crypto';
import { generateTotpSecret, totpAuthUrl, verifyTotp } from '../../common/utils/totp';
import { activityService, type ActivityOrigin } from '../activity-logs/activity.service';

export const RECOVERY_CODE_COUNT = 10;
/** No 0/o, 1/l/i — codes get read off paper and typed by hand. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/**
 * Every code check, wherever it happens, draws from one per-user budget. The
 * code space is only a million, so this — not the IP limiter — is what stops
 * guessing, including from someone holding a stolen session.
 */
const codeLimiter = new SlidingWindowRateLimiter(redis, '2fa-code', 5, 5 * 60 * 1000);

export type TwoFactorMethod = 'totp' | 'recovery';

type TwoFactorUser = { id: string; twoFactorSecret: string | null };

export const INVALID_CODE = () => new BadRequestError('That code is not valid. Check your authenticator app and try again.', 'INVALID_TWO_FACTOR_CODE');

function generateRecoveryCode(): string {
  let raw = '';
  for (let i = 0; i < 10; i++) raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

const normaliseRecoveryCode = (code: string) => code.toLowerCase().replace(/[\s-]/g, '');

/** Fresh plaintext codes plus the rows that store their hashes. */
function newRecoveryCodes(userId: string) {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  return { codes, rows: codes.map((c) => ({ userId, codeHash: sha256(normaliseRecoveryCode(c)) })) };
}

async function consumeAttempt(userId: string): Promise<void> {
  let decision;
  try {
    decision = await codeLimiter.consume(userId);
  } catch (err) {
    // Fail open, like the HTTP limiters: a Redis outage must not lock everyone out.
    logger.error({ err, limiter: '2fa-code' }, 'rate limiter unavailable; allowing request');
    return;
  }
  if (!decision.allowed) {
    throw new RateLimitError(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)), 'Too many code attempts. Please wait a few minutes and try again.');
  }
}

async function acceptTotpStep(userId: string, step: number): Promise<boolean> {
  // Atomic: a code already used (or an older one) loses here, even under a race.
  const { count } = await prisma.user.updateMany({
    where: { id: userId, OR: [{ twoFactorLastStep: null }, { twoFactorLastStep: { lt: step } }] },
    data: { twoFactorLastStep: step },
  });
  return count === 1;
}

export const twoFactorService = {
  /**
   * Checks a 6-digit authenticator code or a recovery code and consumes it.
   * Returns which kind matched, or null. Rate limited per user.
   */
  async verifyCode(user: TwoFactorUser, rawCode: string): Promise<TwoFactorMethod | null> {
    await consumeAttempt(user.id);
    const code = rawCode.replace(/\s/g, '');

    if (/^\d{6}$/.test(code)) {
      const secret = user.twoFactorSecret ? decryptSecret(user.twoFactorSecret) : null;
      if (!secret) {
        logger.error({ userId: user.id }, '2FA secret is unreadable; the user must sign in with a recovery code');
        return null;
      }
      const step = verifyTotp(secret, code);
      return step !== null && (await acceptTotpStep(user.id, step)) ? 'totp' : null;
    }

    const { count } = await prisma.twoFactorRecoveryCode.updateMany({
      where: { userId: user.id, codeHash: sha256(normaliseRecoveryCode(code)), usedAt: null },
      data: { usedAt: new Date() },
    });
    return count === 1 ? 'recovery' : null;
  },

  async status(userId: string) {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { twoFactorEnabled: true, twoFactorEnabledAt: true },
    });
    if (!user) throw new NotFoundError('User');
    const recoveryCodesRemaining = user.twoFactorEnabled
      ? await prisma.twoFactorRecoveryCode.count({ where: { userId, usedAt: null } })
      : 0;
    return { enabled: user.twoFactorEnabled, enabledAt: user.twoFactorEnabledAt, recoveryCodesRemaining };
  },

  /**
   * Starts enrolment: a new secret is parked as "pending" until the user
   * proves their app has it. Calling again simply replaces the pending secret.
   */
  async setup(userId: string) {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { email: true, twoFactorEnabled: true },
    });
    if (!user) throw new NotFoundError('User');
    if (user.twoFactorEnabled) throw new ConflictError('Two-factor authentication is already enabled', 'TWO_FACTOR_ALREADY_ENABLED');

    const secret = generateTotpSecret();
    await prisma.user.update({ where: { id: userId }, data: { twoFactorPendingSecret: encryptSecret(secret) } });

    const otpauthUrl = totpAuthUrl(secret, user.email, env.TOTP_ISSUER);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 });
    // `secret` is for manual entry when the QR code can't be scanned.
    return { secret, otpauthUrl, qrCodeDataUrl };
  },

  /** Confirms enrolment with a code from the app; returns recovery codes, shown once. */
  async enable(userId: string, rawCode: string, origin: ActivityOrigin) {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { twoFactorEnabled: true, twoFactorPendingSecret: true },
    });
    if (!user) throw new NotFoundError('User');
    if (user.twoFactorEnabled) throw new ConflictError('Two-factor authentication is already enabled', 'TWO_FACTOR_ALREADY_ENABLED');
    const secret = user.twoFactorPendingSecret ? decryptSecret(user.twoFactorPendingSecret) : null;
    if (!secret) throw new BadRequestError('Start two-factor setup first', 'TWO_FACTOR_SETUP_REQUIRED');

    await consumeAttempt(userId);
    const step = verifyTotp(secret, rawCode.replace(/\s/g, ''));
    if (step === null) throw INVALID_CODE();

    const { codes, rows } = newRecoveryCodes(userId);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          twoFactorEnabled: true,
          twoFactorSecret: user.twoFactorPendingSecret,
          twoFactorPendingSecret: null,
          twoFactorEnabledAt: new Date(),
          twoFactorLastStep: step,
        },
      }),
      prisma.twoFactorRecoveryCode.deleteMany({ where: { userId } }),
      prisma.twoFactorRecoveryCode.createMany({ data: rows }),
    ]);

    void activityService.record(origin, {
      action: 'auth.2fa_enabled',
      entity: 'auth',
      entityId: userId,
      description: 'Enabled two-factor authentication',
    });
    return { recoveryCodes: codes };
  },

  /** Turning 2FA off needs both the password and a current code. */
  async disable(userId: string, password: string, rawCode: string, origin: ActivityOrigin) {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, passwordHash: true, twoFactorEnabled: true, twoFactorSecret: true },
    });
    if (!user) throw new NotFoundError('User');
    if (!user.twoFactorEnabled) throw new BadRequestError('Two-factor authentication is not enabled', 'TWO_FACTOR_NOT_ENABLED');
    // 400, not 401: a wrong password here must not look like an expired session to the client.
    if (!(await bcrypt.compare(password, user.passwordHash))) throw new BadRequestError('Incorrect password', 'INVALID_PASSWORD');
    if (!(await this.verifyCode(user, rawCode))) throw INVALID_CODE();

    await this.clear(userId);
    void activityService.record(origin, {
      action: 'auth.2fa_disabled',
      entity: 'auth',
      entityId: userId,
      description: 'Disabled two-factor authentication',
    });
  },

  /** Replaces every recovery code; the old ones stop working immediately. */
  async regenerateRecoveryCodes(userId: string, rawCode: string, origin: ActivityOrigin) {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, twoFactorEnabled: true, twoFactorSecret: true },
    });
    if (!user) throw new NotFoundError('User');
    if (!user.twoFactorEnabled) throw new BadRequestError('Two-factor authentication is not enabled', 'TWO_FACTOR_NOT_ENABLED');
    if (!(await this.verifyCode(user, rawCode))) throw INVALID_CODE();

    const { codes, rows } = newRecoveryCodes(userId);
    await prisma.$transaction([
      prisma.twoFactorRecoveryCode.deleteMany({ where: { userId } }),
      prisma.twoFactorRecoveryCode.createMany({ data: rows }),
    ]);
    void activityService.record(origin, {
      action: 'auth.2fa_recovery_codes_regenerated',
      entity: 'auth',
      entityId: userId,
      description: 'Generated new two-factor recovery codes',
    });
    return { recoveryCodes: codes };
  },

  /** Removes 2FA entirely. Used by self-service disable and by an admin reset. */
  async clear(userId: string): Promise<void> {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          twoFactorEnabled: false,
          twoFactorSecret: null,
          twoFactorPendingSecret: null,
          twoFactorEnabledAt: null,
          twoFactorLastStep: null,
        },
      }),
      prisma.twoFactorRecoveryCode.deleteMany({ where: { userId } }),
    ]);
  },
};
