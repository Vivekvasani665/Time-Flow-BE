import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import QRCode from 'qrcode';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { logger } from '../../lib/logger';
import { SlidingWindowRateLimiter } from '../../cache/rate-limiter';
import { BadRequestError, ConflictError, NotFoundError, RateLimitError } from '../../common/errors';
import { decryptSecret, encryptSecret, sha256 } from '../../common/utils/crypto';
import { generateTotpSecret, totpAuthUrl, verifyTotp } from '../../common/utils/totp';
import { activityService, type ActivityOrigin } from '../activity-logs/activity.service';
import { PASSKEY_FAILED, passkeyService, stepUpAuthKey } from './passkey.service';

export const RECOVERY_CODE_COUNT = 10;
/** No 0/o, 1/l/i — codes get read off paper and typed by hand. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/**
 * Every code check, wherever it happens, draws from one per-user budget. The
 * code space is only a million, so this — not the IP limiter — is what stops
 * guessing, including from someone holding a stolen session.
 */
const codeLimiter = new SlidingWindowRateLimiter(redis, '2fa-code', 5, 5 * 60 * 1000);
/** Password re-checks in Settings: their own budget, so they never eat into code attempts. */
const passwordLimiter = new SlidingWindowRateLimiter(redis, '2fa-password', 10, 15 * 60 * 1000);

export type TwoFactorMethod = 'totp' | 'recovery' | 'passkey';

/** Second-factor proof for sensitive changes: an authenticator/recovery code or a passkey. */
export type TwoFactorProof = { code?: string; passkey?: AuthenticationResponseJSON };

type TwoFactorUser = { id: string; twoFactorSecret: string | null };

export const INVALID_CODE = () => new BadRequestError('That code is not valid. Check your authenticator app and try again.', 'INVALID_TWO_FACTOR_CODE');
const INVALID_PASSWORD = () => new BadRequestError('Incorrect password', 'INVALID_PASSWORD');
const NOT_ENABLED = () => new BadRequestError('Two-factor authentication is not enabled', 'TWO_FACTOR_NOT_ENABLED');

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

async function consume(limiter: SlidingWindowRateLimiter, name: string, userId: string, message: string): Promise<void> {
  let decision;
  try {
    decision = await limiter.consume(userId);
  } catch (err) {
    // Fail open, like the HTTP limiters: a Redis outage must not lock everyone out.
    logger.error({ err, limiter: name }, 'rate limiter unavailable; allowing request');
    return;
  }
  if (!decision.allowed) throw new RateLimitError(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)), message);
}

export const consumeAttempt = (userId: string) =>
  consume(codeLimiter, '2fa-code', userId, 'Too many code attempts. Please wait a few minutes and try again.');

async function acceptTotpStep(userId: string, step: number): Promise<boolean> {
  // Atomic: a code already used (or an older one) loses here, even under a race.
  const { count } = await prisma.user.updateMany({
    where: { id: userId, OR: [{ twoFactorLastStep: null }, { twoFactorLastStep: { lt: step } }] },
    data: { twoFactorLastStep: step },
  });
  return count === 1;
}

/**
 * Re-checks the password before adding or removing a sign-in method, so a
 * borrowed or stolen session alone cannot. Rate limited per user.
 */
async function requirePassword(userId: string, password: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true, email: true, firstName: true, lastName: true, passwordHash: true, twoFactorEnabled: true, twoFactorSecret: true, twoFactorPendingSecret: true },
  });
  if (!user) throw new NotFoundError('User');
  await consume(passwordLimiter, '2fa-password', userId, 'Too many password attempts. Please wait a few minutes and try again.');
  // 400, not 401: a wrong password here must not look like an expired session to the client.
  if (!(await bcrypt.compare(password, user.passwordHash))) throw INVALID_PASSWORD();
  return user;
}

/** What the QR screen needs. Built from a stored secret, so the same QR comes back each time. */
async function setupPayload(secret: string, email: string) {
  const otpauthUrl = totpAuthUrl(secret, email, env.TOTP_ISSUER);
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 });
  // `secret` is for manual entry when the QR code can't be scanned.
  return { secret, otpauthUrl, qrCodeDataUrl };
}

/** Rows that switch 2FA on, with a fresh set of recovery codes. */
function turnOnOps(userId: string, extra: { twoFactorSecret?: string | null; twoFactorLastStep?: number } = {}) {
  const { codes, rows } = newRecoveryCodes(userId);
  return {
    codes,
    ops: [
      prisma.user.update({
        where: { id: userId },
        data: { twoFactorEnabled: true, twoFactorEnabledAt: new Date(), ...extra },
      }),
      prisma.twoFactorRecoveryCode.deleteMany({ where: { userId } }),
      prisma.twoFactorRecoveryCode.createMany({ data: rows }),
    ],
  };
}

export const twoFactorService = {
  /**
   * Checks a 6-digit authenticator code or a recovery code and consumes it.
   * Returns which kind matched, or null. Rate limited per user.
   */
  async verifyCode(user: TwoFactorUser, rawCode: string): Promise<'totp' | 'recovery' | null> {
    await consumeAttempt(user.id);
    const code = rawCode.replace(/\s/g, '');

    if (/^\d{6}$/.test(code)) {
      // Passkey-only accounts have no authenticator secret; a 6-digit code simply cannot match.
      if (!user.twoFactorSecret) return null;
      const secret = decryptSecret(user.twoFactorSecret);
      if (!secret) {
        logger.error({ userId: user.id }, '2FA secret is unreadable; the user must sign in with a recovery code or passkey');
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

  /** A code, or a passkey signed over the challenge parked under `passkeyKey`. */
  async verifyProof(user: TwoFactorUser, proof: TwoFactorProof, passkeyKey: string): Promise<TwoFactorMethod | null> {
    if (proof.passkey) {
      await consumeAttempt(user.id);
      return (await passkeyService.verifyAuthentication(user.id, passkeyKey, proof.passkey)) ? 'passkey' : null;
    }
    return proof.code ? this.verifyCode(user, proof.code) : null;
  },

  /** Which second factors this account can sign in with right now. */
  async methods(user: { id: string; twoFactorSecret: string | null }): Promise<TwoFactorMethod[]> {
    const methods: TwoFactorMethod[] = [];
    if (user.twoFactorSecret) methods.push('totp');
    if ((await passkeyService.count(user.id)) > 0) methods.push('passkey');
    methods.push('recovery');
    return methods;
  },

  async status(userId: string) {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { twoFactorEnabled: true, twoFactorEnabledAt: true, twoFactorSecret: true, twoFactorPendingSecret: true },
    });
    if (!user) throw new NotFoundError('User');
    const [recoveryCodesRemaining, passkeys] = await Promise.all([
      user.twoFactorEnabled ? prisma.twoFactorRecoveryCode.count({ where: { userId, usedAt: null } }) : 0,
      passkeyService.list(userId),
    ]);
    return {
      enabled: user.twoFactorEnabled,
      enabledAt: user.twoFactorEnabledAt,
      recoveryCodesRemaining,
      totp: {
        enabled: user.twoFactorSecret !== null,
        // Started but not confirmed: finished in Settings or at the next sign-in.
        pending: user.twoFactorSecret === null && user.twoFactorPendingSecret !== null,
      },
      passkeys,
    };
  },

  /**
   * Starts authenticator-app enrolment. The secret is parked as "pending" until
   * a code proves the app has it. Calling again returns the SAME secret (and
   * QR code) — a new one would silently break an app that already scanned it.
   */
  async setup(userId: string, password: string, origin: ActivityOrigin) {
    const user = await requirePassword(userId, password);
    if (user.twoFactorSecret) throw new ConflictError('Your authenticator app is already set up', 'TWO_FACTOR_ALREADY_ENABLED');

    let secret = user.twoFactorPendingSecret ? decryptSecret(user.twoFactorPendingSecret) : null;
    if (!secret) {
      secret = generateTotpSecret();
      await prisma.user.update({ where: { id: userId }, data: { twoFactorPendingSecret: encryptSecret(secret) } });
      void activityService.record(origin, {
        action: 'auth.2fa_setup_started',
        entity: 'auth',
        entityId: userId,
        description: 'Started setting up an authenticator app',
      });
    }
    return setupPayload(secret, user.email);
  },

  /** The pending setup to finish at sign-in, when 2FA is not on yet. Null otherwise. */
  async pendingSetup(user: { email: string; twoFactorEnabled: boolean; twoFactorPendingSecret: string | null }) {
    if (user.twoFactorEnabled || !user.twoFactorPendingSecret) return null;
    const secret = decryptSecret(user.twoFactorPendingSecret);
    return secret ? setupPayload(secret, user.email) : null;
  },

  /** Abandons an unconfirmed authenticator setup, so sign-in stops asking for it. */
  async cancelSetup(userId: string) {
    await prisma.user.updateMany({ where: { id: userId, twoFactorSecret: null }, data: { twoFactorPendingSecret: null } });
  },

  /**
   * Confirms authenticator enrolment with a code from the app. Returns recovery
   * codes (shown once) when this turns 2FA on; null when a passkey already had.
   */
  async enable(userId: string, rawCode: string, origin: ActivityOrigin): Promise<{ recoveryCodes: string[] | null }> {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { twoFactorEnabled: true, twoFactorSecret: true, twoFactorPendingSecret: true },
    });
    if (!user) throw new NotFoundError('User');
    if (user.twoFactorSecret) throw new ConflictError('Your authenticator app is already set up', 'TWO_FACTOR_ALREADY_ENABLED');
    const secret = user.twoFactorPendingSecret ? decryptSecret(user.twoFactorPendingSecret) : null;
    if (!secret) throw new BadRequestError('Start two-factor setup first', 'TWO_FACTOR_SETUP_REQUIRED');

    await consumeAttempt(userId);
    const step = verifyTotp(secret, rawCode.replace(/\s/g, ''));
    if (step === null) throw INVALID_CODE();

    const totp = { twoFactorSecret: user.twoFactorPendingSecret, twoFactorPendingSecret: null, twoFactorLastStep: step };
    let recoveryCodes: string[] | null = null;
    if (user.twoFactorEnabled) {
      await prisma.user.update({ where: { id: userId }, data: totp });
    } else {
      const { codes, ops } = turnOnOps(userId, totp);
      await prisma.$transaction(ops);
      recoveryCodes = codes;
    }

    void activityService.record(origin, {
      action: 'auth.2fa_enabled',
      entity: 'auth',
      entityId: userId,
      description: 'Set up an authenticator app for two-factor authentication',
      metadata: { method: 'totp' },
    });
    return { recoveryCodes };
  },

  /** Options for `navigator.credentials.create()`. Needs the password. */
  async passkeyRegistrationOptions(userId: string, password: string) {
    const user = await requirePassword(userId, password);
    return passkeyService.registrationOptions(user);
  },

  /** Stores a new passkey. Returns recovery codes when this turns 2FA on. */
  async registerPasskey(userId: string, response: RegistrationResponseJSON, name: string, origin: ActivityOrigin) {
    const passkey = await passkeyService.register(userId, response, name);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorEnabled: true } });
    let recoveryCodes: string[] | null = null;
    if (!user.twoFactorEnabled) {
      const { codes, ops } = turnOnOps(userId);
      await prisma.$transaction(ops);
      recoveryCodes = codes;
    }
    void activityService.record(origin, {
      action: 'auth.passkey_added',
      entity: 'auth',
      entityId: userId,
      description: `Added a passkey (${passkey.name})`,
      metadata: { method: 'passkey' },
    });
    return { passkey, recoveryCodes };
  },

  /** Removes one passkey. Removing the last sign-in method turns 2FA off. */
  async removePasskey(userId: string, passkeyId: string, password: string, origin: ActivityOrigin) {
    const user = await requirePassword(userId, password);
    const { count } = await prisma.webAuthnCredential.deleteMany({ where: { id: passkeyId, userId } });
    if (count === 0) throw new NotFoundError('Passkey');
    const turnedOff = !user.twoFactorSecret && (await passkeyService.count(userId)) === 0;
    if (turnedOff) await this.clear(userId);
    void activityService.record(origin, {
      action: 'auth.passkey_removed',
      entity: 'auth',
      entityId: userId,
      description: turnedOff ? 'Removed their last passkey; two-factor authentication is off' : 'Removed a passkey',
    });
    return { twoFactorEnabled: !turnedOff };
  },

  /** Removes the authenticator app. With no passkey left, 2FA turns off. */
  async removeTotp(userId: string, password: string, origin: ActivityOrigin) {
    const user = await requirePassword(userId, password);
    if (!user.twoFactorSecret) throw new BadRequestError('No authenticator app is set up', 'TWO_FACTOR_NOT_ENABLED');
    const turnedOff = (await passkeyService.count(userId)) === 0;
    if (turnedOff) {
      await this.clear(userId);
    } else {
      await prisma.user.update({ where: { id: userId }, data: { twoFactorSecret: null, twoFactorPendingSecret: null, twoFactorLastStep: null } });
    }
    void activityService.record(origin, {
      action: 'auth.2fa_totp_removed',
      entity: 'auth',
      entityId: userId,
      description: turnedOff ? 'Removed their authenticator app; two-factor authentication is off' : 'Removed their authenticator app',
    });
    return { twoFactorEnabled: !turnedOff };
  },

  /** Options for proving a passkey before a sensitive change (disable, new recovery codes). */
  stepUpOptions(userId: string) {
    return passkeyService.authenticationOptions(userId, stepUpAuthKey(userId));
  },

  /** Turning 2FA off needs both the password and a current second factor. */
  async disable(userId: string, password: string, proof: TwoFactorProof, origin: ActivityOrigin) {
    const user = await requirePassword(userId, password);
    if (!user.twoFactorEnabled) throw NOT_ENABLED();
    if (!(await this.verifyProof(user, proof, stepUpAuthKey(userId)))) throw proof.passkey ? PASSKEY_FAILED() : INVALID_CODE();

    await this.clear(userId);
    void activityService.record(origin, {
      action: 'auth.2fa_disabled',
      entity: 'auth',
      entityId: userId,
      description: 'Disabled two-factor authentication',
    });
  },

  /** Replaces every recovery code; the old ones stop working immediately. */
  async regenerateRecoveryCodes(userId: string, proof: TwoFactorProof, origin: ActivityOrigin) {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, twoFactorEnabled: true, twoFactorSecret: true },
    });
    if (!user) throw new NotFoundError('User');
    if (!user.twoFactorEnabled) throw NOT_ENABLED();
    if (!(await this.verifyProof(user, proof, stepUpAuthKey(userId)))) throw proof.passkey ? PASSKEY_FAILED() : INVALID_CODE();

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

  /** Removes 2FA entirely — every method. Used by self-service disable and by an admin reset. */
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
      prisma.webAuthnCredential.deleteMany({ where: { userId } }),
    ]);
  },
};

