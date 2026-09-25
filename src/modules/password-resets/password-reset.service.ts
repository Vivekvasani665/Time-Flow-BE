import { Prisma, type PasswordResetRequest, type PasswordResetStatus } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../../common/errors';
import { randomToken, sha256 } from '../../common/utils/crypto';
import { fullName, type RequestContext } from '../../common/utils/request-context';
import { userRefSelect } from '../../common/http/selects';
import { sendMail } from '../../queue/mailer';
import { renderPasswordResetEmail } from '../../queue/templates';
import { activityService, type ActivityOrigin } from '../activity-logs/activity.service';
import { rbacService } from '../permissions/rbac.service';
import { hashPassword } from '../auth/auth.service';

// One message for "never existed", "already used" and "cancelled", so a link
// reveals nothing about the account behind it. Expiry is the only distinction
// worth making: it tells the member to ask for a new link.
const invalidLink = () => new AppError(400, 'PASSWORD_RESET_INVALID', 'This password reset link is invalid or expired.');
const expiredLink = () => new AppError(410, 'PASSWORD_RESET_EXPIRED', 'This reset link has expired. Ask your administrator for a new one.');
const deliveryFailed = () => new AppError(503, 'EMAIL_DELIVERY_FAILED', 'Unable to send password reset email.');

const summarySelect = {
  id: true,
  userId: true,
  status: true,
  createdAt: true,
  expiresAt: true,
  completedAt: true,
  cancelledAt: true,
  requestedBy: { select: userRefSelect },
} satisfies Prisma.PasswordResetRequestSelect;

type SummaryRow = Prisma.PasswordResetRequestGetPayload<{ select: typeof summarySelect }>;

/**
 * A PENDING row past its expiry is reported as EXPIRED even before anything has
 * written that status back — expiry is a fact of the clock, not of a sweep job.
 */
const effectiveStatus = (row: Pick<PasswordResetRequest, 'status' | 'expiresAt'>, now = Date.now()): PasswordResetStatus =>
  row.status === 'PENDING' && row.expiresAt.getTime() <= now ? 'EXPIRED' : row.status;

/** What an administrator may see. Never the token, its hash or anything about the password. */
const toSummary = (row: SummaryRow) => ({ ...row, status: effectiveStatus(row) });

export type PasswordResetSummary = ReturnType<typeof toSummary>;

const ttlMs = () => env.RESET_PASSWORD_TOKEN_EXPIRY_MINUTES * 60 * 1000;

/** Persists the lapse and audits it once; the conditional update makes concurrent callers record it only once. */
async function markExpired(row: { id: string; userId: string }, origin: ActivityOrigin): Promise<void> {
  const { count } = await prisma.passwordResetRequest.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
  if (count === 1) {
    void activityService.record(origin, {
      action: 'user.password_reset_expired',
      entity: 'user',
      entityId: row.userId,
      description: 'A password reset link expired before it was used',
      metadata: { requestId: row.id },
    });
  }
}

/**
 * Resolves a raw token to its live request, or throws. Deleted or deactivated
 * accounts invalidate their links: a reset must never re-open a closed account.
 */
async function findUsable(token: string, origin: ActivityOrigin) {
  const row = await prisma.passwordResetRequest.findUnique({
    where: { tokenHash: sha256(token) },
    select: {
      id: true,
      userId: true,
      requestedById: true,
      status: true,
      expiresAt: true,
      user: { select: { id: true, firstName: true, lastName: true, status: true, deletedAt: true } },
    },
  });
  if (!row || row.user.deletedAt || row.user.status !== 'ACTIVE') throw invalidLink();
  const status = effectiveStatus(row);
  if (status === 'EXPIRED') {
    if (row.status === 'PENDING') await markExpired(row, origin);
    throw expiredLink();
  }
  if (status !== 'PENDING') throw invalidLink();
  return row;
}

export const passwordResetService = {
  /**
   * Issues a fresh link and emails it. Any link still pending for the member is
   * cancelled first, so exactly one works at a time — the newest.
   */
  async request(ctx: RequestContext, userId: string): Promise<PasswordResetSummary> {
    const target = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, email: true, firstName: true, lastName: true, status: true },
    });
    if (!target) throw new NotFoundError('User', 'USER_NOT_FOUND');
    if (target.status !== 'ACTIVE') {
      throw new BadRequestError('This user is inactive. Activate the account before sending a password reset link.', 'USER_INACTIVE');
    }

    const token = randomToken(32);
    const now = new Date();
    let cancelled = 0;
    let row: SummaryRow;
    try {
      row = await prisma.$transaction(async (tx) => {
        ({ count: cancelled } = await tx.passwordResetRequest.updateMany({
          where: { userId, status: 'PENDING' },
          data: { status: 'CANCELLED', cancelledAt: now },
        }));
        return tx.passwordResetRequest.create({
          data: { userId, requestedById: ctx.actor.id, tokenHash: sha256(token), expiresAt: new Date(now.getTime() + ttlMs()) },
          select: summarySelect,
        });
      });
    } catch (err) {
      // The one-pending-per-user index: another admin issued a link at the same moment.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictError('A reset link was just sent to this user. Refresh to see its status.', 'PASSWORD_RESET_IN_PROGRESS');
      }
      throw err;
    }

    const resetUrl = `${env.APP_URL.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
    try {
      await sendMail(renderPasswordResetEmail(target.email, { firstName: target.firstName, resetUrl, minutes: env.RESET_PASSWORD_TOKEN_EXPIRY_MINUTES }));
    } catch (err) {
      // A link nobody received must not stay live. Logged without the message body, which carries the token.
      await prisma.passwordResetRequest.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      logger.error({ userId, requestId: row.id, reason: err instanceof Error ? err.message : String(err) }, 'password reset email could not be sent');
      throw deliveryFailed();
    }

    void activityService.record(ctx, {
      action: 'user.password_reset_requested',
      entity: 'user',
      entityId: userId,
      description: `${fullName(ctx.actor)} sent a password reset link to ${fullName(target)}`,
      metadata: { requestId: row.id, replacedPrevious: cancelled > 0 },
    });
    return toSummary(row);
  },

  /** The member's most recent request, or null if none was ever sent. */
  async latestForUser(userId: string): Promise<PasswordResetSummary | null> {
    const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true } });
    if (!user) throw new NotFoundError('User', 'USER_NOT_FOUND');
    const row = await prisma.passwordResetRequest.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' }, select: summarySelect });
    return row ? toSummary(row) : null;
  },

  /** Latest request per user, for a table of members. Users without one are simply absent. */
  async latestForUsers(userIds: string[]): Promise<PasswordResetSummary[]> {
    if (userIds.length === 0) return [];
    const rows = await prisma.passwordResetRequest.findMany({
      where: { userId: { in: userIds } },
      orderBy: [{ userId: 'asc' }, { createdAt: 'desc' }],
      distinct: ['userId'],
      select: summarySelect,
    });
    return rows.map(toSummary);
  },

  async verify(token: string, origin: ActivityOrigin): Promise<{ valid: true; expiresAt: Date }> {
    const row = await findUsable(token, origin);
    return { valid: true, expiresAt: row.expiresAt };
  },

  /**
   * Sets the new password and spends the link in one transaction: the
   * conditional claim means two concurrent submissions cannot both succeed,
   * and a failed password write leaves the link usable. Every existing session
   * is ended, as for any other password change.
   */
  async complete(token: string, newPassword: string, origin: ActivityOrigin): Promise<void> {
    const row = await findUsable(token, origin);
    const passwordHash = await hashPassword(newPassword);
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetRequest.updateMany({
        where: { id: row.id, status: 'PENDING', expiresAt: { gt: now } },
        data: { status: 'COMPLETED', completedAt: now },
      });
      if (claimed.count !== 1) throw invalidLink();
      await tx.user.update({ where: { id: row.userId }, data: { passwordHash, tokenVersion: { increment: 1 } } });
      await tx.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: now } });
    });

    await rbacService.invalidateUser(row.userId);
    void activityService.record(
      { ...origin, actorId: row.userId },
      {
        action: 'user.password_reset_completed',
        entity: 'user',
        entityId: row.userId,
        description: `${fullName(row.user)} reset their password using an administrator's link`,
        metadata: { requestId: row.id },
        notify: row.requestedById
          ? [{ userId: row.requestedById, type: 'user.password_reset_completed', title: `${fullName(row.user)} has reset their password`, link: `/users/${row.userId}` }]
          : [],
      },
    );
  },
};
