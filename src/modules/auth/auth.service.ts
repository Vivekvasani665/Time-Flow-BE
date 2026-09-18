import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { isTest } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { sha256 } from '../../common/utils/crypto';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../../common/errors';
import { fullName } from '../../common/utils/request-context';
import { activityService, type ActivityOrigin } from '../activity-logs/activity.service';
import { rbacService } from '../permissions/rbac.service';
import { withDefaults, type Preferences } from './auth.schemas';
import { tokenService } from './token.service';
import type { LoginInput } from './auth.schemas';

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
  async login(input: LoginInput, client: ClientInfo): Promise<IssuedSession> {
    const user = await prisma.user.findFirst({
      where: { email: input.email, deletedAt: null },
      select: { id: true, passwordHash: true, status: true, tokenVersion: true, firstName: true, lastName: true },
    });

    const passwordOk = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
    const origin: ActivityOrigin = { actorId: user?.id ?? null, ...client };

    if (!user || !passwordOk) {
      void activityService.record(origin, {
        action: 'auth.login_failed',
        entity: 'auth',
        entityId: user?.id ?? null,
        description: `Failed login attempt for ${input.email}`,
        metadata: { email: input.email },
      });
      throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    if (user.status !== 'ACTIVE') {
      throw new ForbiddenError('Your account is inactive. Contact an administrator.', 'ACCOUNT_INACTIVE');
    }

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
