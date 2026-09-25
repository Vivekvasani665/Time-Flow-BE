import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { env, isTest } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { sha256 } from '../../common/utils/crypto';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../../common/errors';
import { fullName } from '../../common/utils/request-context';
import { activityService, type ActivityOrigin } from '../activity-logs/activity.service';
import { rbacService } from '../permissions/rbac.service';
import { withDefaults, type Preferences } from './auth.schemas';
import { cache } from '../../cache/cache.service';
import { producers } from '../../queue/producers';
import { tokenService } from './token.service';
import { twoFactorService } from './two-factor.service';
import { loginOtpService, type LoginOtpChallenge } from './login-otp.service';
import { signupOtpService, type SignupOtpChallenge } from './signup-otp.service';
import { userRepository } from '../users/user.repository';
import type { LoginInput, RegisterInput } from './auth.schemas';

/** Role given to everyone who signs up themselves; admins can promote them later. */
export const SIGNUP_ROLE = 'Employee';

export const BCRYPT_COST = isTest ? 4 : 12;

/** A rotated refresh token re-presented within this window is treated as a benign client race, not theft. */
export const REFRESH_REUSE_GRACE_MS = 10_000;

/** Pre-computed hash so unknown emails cost the same as wrong passwords (no user enumeration via timing). */
const DUMMY_HASH = bcrypt.hashSync('timing-attack-dummy-password', BCRYPT_COST);

type ClientInfo = { ip: string | null; userAgent: string | null };

export type IssuedSession = {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  userId: string;
};

/** Password was right, but the account has 2FA: no session until a code is supplied. */
export type TwoFactorChallenge = {
  twoFactorRequired: true;
  challengeToken: string;
  challengeExpiresAt: Date;
};

const CHALLENGE_INVALID = () =>
  new UnauthorizedError('Your sign-in attempt has expired. Please sign in again.', 'TWO_FACTOR_CHALLENGE_INVALID');

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

async function issueSession(
  user: { id: string; tokenVersion: number },
  client: ClientInfo,
  familyId: string = randomUUID(),
): Promise<IssuedSession & { refreshTokenId: string }> {
  const refresh = tokenService.generateRefreshToken();
  const row = await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: refresh.hash,
      familyId,
      expiresAt: refresh.expiresAt,
      ipAddress: client.ip,
      userAgent: client.userAgent,
    },
    select: { id: true },
  });
  return {
    accessToken: tokenService.signAccessToken({ sub: user.id, tv: user.tokenVersion }),
    refreshToken: refresh.raw,
    refreshExpiresAt: refresh.expiresAt,
    refreshTokenId: row.id,
    userId: user.id,
  };
}

export const authService = {
  async login(input: LoginInput, client: ClientInfo): Promise<IssuedSession | TwoFactorChallenge | LoginOtpChallenge> {
    const identifier = input.email ?? input.phone ?? '';
    // A phone number is resolved to its account first; a miss still runs the password check below, so timing does not reveal it.
    const phoneUserId = input.phone ? await userRepository.findIdByPhone(input.phone) : null;
    const user = await prisma.user.findFirst({
      where: input.phone ? { id: phoneUserId ?? '00000000-0000-0000-0000-000000000000', deletedAt: null } : { email: input.email, deletedAt: null },
      select: {
        id: true,
        email: true,
        phone: true,
        passwordHash: true,
        status: true,
        tokenVersion: true,
        firstName: true,
        lastName: true,
        twoFactorEnabled: true,
      },
    });

    const passwordOk = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
    const origin: ActivityOrigin = { actorId: user?.id ?? null, ...client };

    if (!user || !passwordOk) {
      void activityService.record(origin, {
        action: 'auth.login_failed',
        entity: 'auth',
        entityId: user?.id ?? null,
        description: `Failed login attempt for ${identifier}`,
        metadata: input.phone ? { phone: input.phone } : { email: input.email },
      });
      throw new UnauthorizedError(input.phone ? 'Invalid mobile number or password' : 'Invalid email or password', 'INVALID_CREDENTIALS');
    }
    if (user.status === 'PENDING') {
      throw new ForbiddenError('Your account is not verified yet. Enter the code we sent to your email and mobile number, or sign up again to get a new one.', 'ACCOUNT_NOT_VERIFIED');
    }
    if (user.status !== 'ACTIVE') {
      throw new ForbiddenError('Your account is inactive. Contact an administrator.', 'ACCOUNT_INACTIVE');
    }

    if (user.twoFactorEnabled) {
      // tv is carried so a password change mid-challenge voids the challenge.
      const challenge = tokenService.signTwoFactorChallenge({ sub: user.id, tv: user.tokenVersion });
      return { twoFactorRequired: true, challengeToken: challenge.token, challengeExpiresAt: challenge.expiresAt };
    }

    // An authenticator app is the stronger factor, so it takes precedence over the emailed code.
    if (env.LOGIN_OTP_ENABLED) return loginOtpService.start(user, origin);

    const session = await issueSession(user, client);
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    void activityService.record(origin, {
      action: 'auth.login',
      entity: 'auth',
      entityId: user.id,
      description: `${fullName(user)} signed in`,
    });
    return session;
  },

  /** Second step of an emailed-code sign-in: the session is issued only here. */
  async verifyLoginOtp(verificationId: string, otp: string, client: ClientInfo): Promise<IssuedSession> {
    const userId = await loginOtpService.verify(verificationId, otp, client);
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, status: true, tokenVersion: true, firstName: true, lastName: true },
    });
    // Deactivated or deleted while the code was in flight.
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedError('This sign-in attempt is no longer valid. Please sign in again.', 'LOGIN_OTP_SESSION_INVALID');
    }

    const session = await issueSession(user, client);
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    void activityService.record(
      { actorId: user.id, ...client },
      { action: 'auth.login', entity: 'auth', entityId: user.id, description: `${fullName(user)} signed in`, metadata: { loginOtp: true } },
    );
    return session;
  },

  /**
   * Passwordless sign-in, last step: the code was right. Accounts with an
   * authenticator app still owe their 2FA code, exactly as after a password.
   */
  async completeOtpLogin(userId: string, tokenVersion: number, client: ClientInfo): Promise<IssuedSession | TwoFactorChallenge> {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null, status: 'ACTIVE', tokenVersion },
      select: { id: true, tokenVersion: true, firstName: true, lastName: true, twoFactorEnabled: true },
    });
    if (!user) throw new UnauthorizedError('This sign-in code is no longer valid. Request a new code.', 'OTP_TOKEN_INVALID');

    if (user.twoFactorEnabled) {
      const challenge = tokenService.signTwoFactorChallenge({ sub: user.id, tv: user.tokenVersion });
      return { twoFactorRequired: true, challengeToken: challenge.token, challengeExpiresAt: challenge.expiresAt };
    }

    const session = await issueSession(user, client);
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    void activityService.record(
      { actorId: user.id, ...client },
      { action: 'auth.login', entity: 'auth', entityId: user.id, description: `${fullName(user)} signed in with a one-time code`, metadata: { otpLogin: true } },
    );
    return session;
  },

  /** Second step of a 2FA sign-in: exchanges the challenge + a code for a session. */
  async verifyTwoFactorLogin(challengeToken: string, code: string, client: ClientInfo): Promise<IssuedSession & { method: 'totp' | 'recovery' }> {
    const challenge = tokenService.verifyTwoFactorChallenge(challengeToken);
    if (!challenge) throw CHALLENGE_INVALID();

    const user = await prisma.user.findFirst({
      where: { id: challenge.sub, deletedAt: null },
      select: {
        id: true,
        status: true,
        tokenVersion: true,
        firstName: true,
        lastName: true,
        twoFactorEnabled: true,
        twoFactorSecret: true,
      },
    });
    if (!user || user.tokenVersion !== challenge.tv || !user.twoFactorEnabled) throw CHALLENGE_INVALID();
    if (user.status !== 'ACTIVE') {
      throw new ForbiddenError('Your account is inactive. Contact an administrator.', 'ACCOUNT_INACTIVE');
    }

    const origin: ActivityOrigin = { actorId: user.id, ...client };
    const method = await twoFactorService.verifyCode(user, code);
    if (!method) {
      void activityService.record(origin, {
        action: 'auth.2fa_failed',
        entity: 'auth',
        entityId: user.id,
        description: `Failed two-factor code for ${fullName(user)}`,
      });
      throw new UnauthorizedError('That code is not valid. Check your authenticator app and try again.', 'INVALID_TWO_FACTOR_CODE');
    }

    const session = await issueSession(user, client);
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    void activityService.record(origin, {
      action: 'auth.login',
      entity: 'auth',
      entityId: user.id,
      description: method === 'recovery' ? `${fullName(user)} signed in with a recovery code` : `${fullName(user)} signed in`,
      metadata: { twoFactor: method },
    });
    return { ...session, method };
  },

  /**
   * Self-service sign-up, step 1: creates a PENDING user with the default role
   * and sends one code to its email and mobile number. No session is issued —
   * the account can sign in only after verifySignup.
   */
  async register(input: RegisterInput, client: ClientInfo): Promise<SignupOtpChallenge> {
    const role = await prisma.role.findUnique({ where: { name: SIGNUP_ROLE }, select: { id: true } });
    if (!role) {
      logger.error({ role: SIGNUP_ROLE }, 'sign-up role is missing; run the seed');
      throw new ForbiddenError('Sign-up is not available right now', 'SIGNUP_UNAVAILABLE');
    }
    // An unverified (PENDING) signup does not own its email or number: signing
    // up again replaces it, so an abandoned attempt never locks anyone out.
    const emailTaken = await prisma.user.count({ where: { email: input.email, deletedAt: null, status: { not: 'PENDING' } } });
    if (emailTaken > 0) throw new ConflictError('An account with this email already exists', 'USER_EMAIL_EXISTS');
    if (await userRepository.phoneTaken(input.phone, { ignorePending: true })) {
      throw new ConflictError('An account with this mobile number already exists', 'USER_PHONE_EXISTS');
    }

    const digits = input.phone.replace(/\D/g, '');
    const passwordHash = await hashPassword(input.password);
    const user = await prisma.$transaction(async (tx) => {
      const stale = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM users
        WHERE deleted_at IS NULL AND status = 'PENDING'
          AND (email = ${input.email} OR regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = ${digits})`;
      if (stale.length > 0) await tx.user.deleteMany({ where: { id: { in: stale.map((r) => r.id) }, status: 'PENDING' } });

      // Explicit field whitelist — request bodies are never spread into Prisma.
      return tx.user.create({
        data: {
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone,
          status: 'PENDING',
          roleId: role.id,
          passwordHash,
        },
        select: { id: true, email: true, phone: true, firstName: true, lastName: true },
      });
    });

    const origin: ActivityOrigin = { actorId: user.id, ...client };
    let challenge: SignupOtpChallenge;
    try {
      challenge = await signupOtpService.start(user, origin);
    } catch (err) {
      // No code reached the user, so the account could never be verified.
      await prisma.user.deleteMany({ where: { id: user.id, status: 'PENDING' } });
      throw err;
    }

    void activityService.record(origin, {
      action: 'user.registered',
      entity: 'user',
      entityId: user.id,
      description: `${fullName(user)} signed up`,
      metadata: { email: user.email, role: SIGNUP_ROLE, status: 'PENDING' },
    });
    return challenge;
  },

  /** Self-service sign-up, step 2: the code activates the account. The user then signs in normally. */
  async verifySignup(verificationId: string, otp: string, client: ClientInfo): Promise<{ id: string; email: string }> {
    const userId = await signupOtpService.verify(verificationId, otp, client);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, email: true, firstName: true } });
    await cache.invalidate('dashboard');
    void producers.welcomeEmail(user, user.id);
    return { id: user.id, email: user.email };
  },

  /**
   * Refresh-token rotation with reuse detection. Each refresh invalidates the
   * presented token and issues a new one in the same family. Presenting an
   * already-rotated token (outside a short grace window) means the token was
   * copied — the entire family is revoked, logging out every holder.
   */
  async refresh(rawToken: string, client: ClientInfo): Promise<IssuedSession> {
    const existing = await prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
      include: { user: { select: { id: true, status: true, deletedAt: true, tokenVersion: true } } },
    });
    if (!existing) throw new UnauthorizedError('Invalid refresh token');

    if (existing.revokedAt) {
      const withinGrace = existing.replacedBy !== null && Date.now() - existing.revokedAt.getTime() < REFRESH_REUSE_GRACE_MS;
      if (!withinGrace) {
        await prisma.refreshToken.updateMany({
          where: { familyId: existing.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        logger.warn({ userId: existing.userId, familyId: existing.familyId }, 'refresh token reuse detected; family revoked');
        void activityService.record(
          { actorId: existing.userId, ...client },
          {
            action: 'auth.refresh_token_reused',
            entity: 'auth',
            entityId: existing.userId,
            description: 'Refresh token reuse detected — all sessions in this family were revoked',
            metadata: { familyId: existing.familyId },
          },
        );
      }
      throw new UnauthorizedError('Refresh token has been revoked');
    }

    if (existing.expiresAt.getTime() <= Date.now()) throw new UnauthorizedError('Refresh token expired');
    const { user } = existing;
    if (user.deletedAt || user.status !== 'ACTIVE') throw new UnauthorizedError('Account is no longer active');

    // Atomically claim the token; a concurrent refresh loses the race here.
    const claimed = await prisma.refreshToken.updateMany({
      where: { id: existing.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count === 0) throw new UnauthorizedError('Refresh token has been revoked');

    const session = await issueSession(user, client, existing.familyId);
    await prisma.refreshToken.update({ where: { id: existing.id }, data: { replacedBy: session.refreshTokenId } });
    return session;
  },

  async logout(rawToken: string | null, actorId: string | null, client: ClientInfo): Promise<void> {
    if (!rawToken) return;
    const token = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) }, select: { familyId: true, userId: true } });
    if (!token) return;
    await prisma.refreshToken.updateMany({ where: { familyId: token.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    void activityService.record(
      { actorId: actorId ?? token.userId, ...client },
      { action: 'auth.logout', entity: 'auth', entityId: token.userId, description: 'Signed out' },
    );
  },

  async getAuthUser(userId: string) {
    const [user, permissions] = await Promise.all([
      prisma.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          avatarUrl: true,
          status: true,
          lastLoginAt: true,
          createdAt: true,
          preferences: true,
          twoFactorEnabled: true,
          role: { select: { id: true, name: true } },
          roleId: true,
        },
      }),
      rbacService.buildAuthContext(userId),
    ]);
    if (!user || !permissions) throw new UnauthorizedError();
    const { roleId: _roleId, preferences, ...rest } = user;
    // Preferences ride along with /auth/me, so the client needs no extra request.
    return { ...rest, preferences: withDefaults(preferences), permissions: [...permissions.permissions].sort() };
  },

  /** Merges a partial patch into the stored bag and returns the whole thing. */
  async updatePreferences(userId: string, patch: Partial<Preferences>) {
    const current = await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { preferences: true } });
    if (!current) throw new UnauthorizedError();
    const merged = withDefaults({ ...withDefaults(current.preferences), ...patch });
    await prisma.user.update({ where: { id: userId }, data: { preferences: merged } });
    return merged;
  },

  /** Revokes every refresh token and bumps tokenVersion so outstanding access tokens die too. */
  async revokeAllSessions(userId: string): Promise<void> {
    await prisma.$transaction([
      prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
      prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } }),
    ]);
    await rbacService.invalidateUser(userId);
  },

  /**
   * One sign-in = one token family, which rotation extends. Collapsing the
   * family to its newest live token gives "this device, last seen then".
   */
  async listSessions(userId: string, currentRawToken: string | null) {
    const tokens = await prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { familyId: true, tokenHash: true, ipAddress: true, userAgent: true, createdAt: true, expiresAt: true },
    });
    const currentHash = currentRawToken ? sha256(currentRawToken) : null;

    const byFamily = new Map<string, { familyId: string; ipAddress: string | null; userAgent: string | null; lastSeenAt: Date; expiresAt: Date; current: boolean }>();
    for (const t of tokens) {
      // findMany is newest-first, so the first row per family is the live one.
      if (!byFamily.has(t.familyId)) {
        byFamily.set(t.familyId, {
          familyId: t.familyId,
          ipAddress: t.ipAddress,
          userAgent: t.userAgent,
          lastSeenAt: t.createdAt,
          expiresAt: t.expiresAt,
          current: false,
        });
      }
      if (currentHash && t.tokenHash === currentHash) byFamily.get(t.familyId)!.current = true;
    }
    // The device you are on belongs at the top.
    return [...byFamily.values()].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  },

  /**
   * Revokes refresh tokens only — tokenVersion is per-user, so bumping it here
   * would also kill the caller's own access token. The revoked device keeps a
   * working access token until it expires (15 min) and then cannot refresh.
   */
  async revokeSession(userId: string, familyId: string): Promise<void> {
    const { count } = await prisma.refreshToken.updateMany({
      where: { userId, familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw new NotFoundError('Session');
  },

  /** Signs out every other device, leaving the caller signed in. */
  async revokeOtherSessions(userId: string, currentRawToken: string | null): Promise<number> {
    const current = currentRawToken
      ? await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(currentRawToken) }, select: { familyId: true } })
      : null;
    const { count } = await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null, ...(current ? { familyId: { not: current.familyId } } : {}) },
      data: { revokedAt: new Date() },
    });
    return count;
  },
};
