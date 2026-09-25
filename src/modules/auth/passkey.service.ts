import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { logger } from '../../lib/logger';
import { AppError, BadRequestError } from '../../common/errors';

/**
 * Passkeys (WebAuthn) as a second factor: Face ID, Touch ID, Windows Hello, a
 * device PIN or a security key. The server keeps only public keys; each
 * ceremony signs a one-time challenge parked in Redis for a few minutes.
 */

const CHALLENGE_TTL_SECONDS = 5 * 60;
/** Browsers give up after this; the challenge outlives it slightly. */
const CEREMONY_TIMEOUT_MS = 2 * 60 * 1000;

const appUrl = new URL(env.APP_URL);
export const RP_ID = env.WEBAUTHN_RP_ID ?? appUrl.hostname;
const EXPECTED_ORIGINS = env.WEBAUTHN_ORIGINS ?? [appUrl.origin];

export const PASSKEY_FAILED = () =>
  new BadRequestError('That passkey could not be verified. Try again, or use another sign-in method.', 'PASSKEY_VERIFICATION_FAILED');
const UNAVAILABLE = () =>
  new AppError(503, 'PASSKEY_UNAVAILABLE', 'Passkeys are temporarily unavailable. Use your authenticator app or a recovery code.');
const CHALLENGE_EXPIRED = () =>
  new BadRequestError('The passkey request timed out. Please try again.', 'PASSKEY_CHALLENGE_EXPIRED');

/** Registration challenges are per user; authentication ones per sign-in attempt or step-up. */
const regKey = (userId: string) => `webauthn:reg:${userId}`;
export const loginAuthKey = (challengeJti: string) => `webauthn:auth:login:${challengeJti}`;
export const stepUpAuthKey = (userId: string) => `webauthn:auth:stepup:${userId}`;

async function park(key: string, challenge: string): Promise<void> {
  try {
    await redis.set(key, challenge, 'EX', CHALLENGE_TTL_SECONDS);
  } catch (err) {
    // Fails closed: without the stored challenge nothing could ever be verified.
    logger.error({ err }, 'passkey challenge store unavailable');
    throw UNAVAILABLE();
  }
}

/** Single-use: read and delete in one step, so a signed challenge cannot be replayed. */
async function takeChallenge(key: string): Promise<string> {
  let challenge: string | null;
  try {
    challenge = await redis.getdel(key);
  } catch (err) {
    logger.error({ err }, 'passkey challenge store unavailable');
    throw UNAVAILABLE();
  }
  if (!challenge) throw CHALLENGE_EXPIRED();
  return challenge;
}

/** A readable default name from the browser's user agent: "Chrome on macOS". */
export function defaultPasskeyName(userAgent: string | null): string {
  if (!userAgent) return 'Passkey';
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : null;
  const os = /iPhone|iPad/.test(userAgent) ? 'iOS' : /Android/.test(userAgent) ? 'Android' : /Mac OS X/.test(userAgent) ? 'macOS' : /Windows/.test(userAgent) ? 'Windows' : /Linux/.test(userAgent) ? 'Linux' : null;
  return browser && os ? `${browser} on ${os}` : browser ?? os ?? 'Passkey';
}

export const passkeyService = {
  async list(userId: string) {
    return prisma.webAuthnCredential.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, backedUp: true, createdAt: true, lastUsedAt: true },
    });
  },

  count(userId: string) {
    return prisma.webAuthnCredential.count({ where: { userId } });
  },

  async registrationOptions(user: { id: string; email: string; firstName: string; lastName: string }) {
    const existing = await prisma.webAuthnCredential.findMany({ where: { userId: user.id }, select: { credentialId: true, transports: true } });
    const options = await generateRegistrationOptions({
      rpName: env.TOTP_ISSUER,
      rpID: RP_ID,
      userName: user.email,
      userDisplayName: `${user.firstName} ${user.lastName}`.trim(),
      userID: new TextEncoder().encode(user.id),
      timeout: CEREMONY_TIMEOUT_MS,
      attestationType: 'none',
      // The same authenticator twice would add nothing.
      excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports as never })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    await park(regKey(user.id), options.challenge);
    return options;
  },

  /** Verifies the browser's attestation and stores the new passkey. */
  async register(userId: string, response: RegistrationResponseJSON, name: string) {
    const expectedChallenge = await takeChallenge(regKey(userId));
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: EXPECTED_ORIGINS,
        expectedRPID: RP_ID,
        requireUserVerification: false,
      });
    } catch (err) {
      logger.info({ err, userId }, 'passkey registration rejected');
      throw PASSKEY_FAILED();
    }
    if (!verification.verified) throw PASSKEY_FAILED();

    const { credential, credentialBackedUp } = verification.registrationInfo;
    if (await prisma.webAuthnCredential.count({ where: { credentialId: credential.id } })) {
      throw new BadRequestError('This passkey is already registered.', 'PASSKEY_ALREADY_REGISTERED');
    }
    return prisma.webAuthnCredential.create({
      data: {
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        transports: credential.transports ?? [],
        name,
        backedUp: credentialBackedUp,
      },
      select: { id: true, name: true, backedUp: true, createdAt: true, lastUsedAt: true },
    });
  },

  /** Options for proving a passkey the user already has. Parked under `key`. */
  async authenticationOptions(userId: string, key: string) {
    const credentials = await prisma.webAuthnCredential.findMany({ where: { userId }, select: { credentialId: true, transports: true } });
    if (credentials.length === 0) throw new BadRequestError('No passkey is registered for this account.', 'PASSKEY_NOT_REGISTERED');
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      timeout: CEREMONY_TIMEOUT_MS,
      allowCredentials: credentials.map((c) => ({ id: c.credentialId, transports: c.transports })),
      userVerification: 'preferred',
    });
    await park(key, options.challenge);
    return options;
  },

  /**
   * True when `response` is a valid signature from one of the user's passkeys
   * over the challenge parked under `key`. The challenge is spent either way.
   */
  async verifyAuthentication(userId: string, key: string, response: AuthenticationResponseJSON): Promise<boolean> {
    const expectedChallenge = await takeChallenge(key);
    const stored = await prisma.webAuthnCredential.findFirst({
      where: { userId, credentialId: response.id },
      select: { id: true, credentialId: true, publicKey: true, counter: true, transports: true },
    });
    if (!stored) return false;

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: EXPECTED_ORIGINS,
        expectedRPID: RP_ID,
        requireUserVerification: false,
        credential: {
          id: stored.credentialId,
          publicKey: new Uint8Array(stored.publicKey),
          counter: Number(stored.counter),
          transports: stored.transports as never,
        },
      });
    } catch (err) {
      // Includes a counter that went backwards — a sign of a cloned authenticator.
      logger.info({ err, userId }, 'passkey assertion rejected');
      return false;
    }
    if (!verification.verified) return false;

    await prisma.webAuthnCredential.update({
      where: { id: stored.id },
      data: { counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: new Date() },
    });
    return true;
  },
};
