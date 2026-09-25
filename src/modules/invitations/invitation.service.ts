import { Prisma, type InvitationStatus, type UserInvitation } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { cache } from '../../cache/cache.service';
import { producers } from '../../queue/producers';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../../common/errors';
import { buildMeta } from '../../common/http/response';
import { skipTake } from '../../common/http/pagination';
import { userRefSelect } from '../../common/http/selects';
import { randomToken, sha256 } from '../../common/utils/crypto';
import { fullName, type RequestContext } from '../../common/utils/request-context';
import { activityService, type ActivityOrigin } from '../activity-logs/activity.service';
import { rbacService } from '../permissions/rbac.service';
import { hashPassword } from '../auth/auth.service';
import { userRepository } from '../users/user.repository';
import type { AcceptInvitationInput, CreateInvitationInput, ListInvitationsQuery } from './invitation.schemas';

// One answer for "never existed", "expired", "already used" and "revoked", so a
// link reveals nothing about the account behind it — the invitee's next step is
// the same in every case: ask the administrator for a new link.
export const INVITATION_LINK_INVALID_MESSAGE = 'Invitation Link Expired or Already Used';
const invalidLink = () => new AppError(410, 'INVITATION_LINK_INVALID', INVITATION_LINK_INVALID_MESSAGE);
const emailExists = () => new ConflictError('A user with this email already exists', 'USER_EMAIL_EXISTS');

const summarySelect = {
  id: true,
  email: true,
  status: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  createdAt: true,
  role: { select: { id: true, name: true } },
  invitedBy: { select: userRefSelect },
  acceptedUser: { select: userRefSelect },
} satisfies Prisma.UserInvitationSelect;

type SummaryRow = Prisma.UserInvitationGetPayload<{ select: typeof summarySelect }>;

/**
 * A PENDING row past its expiry is reported as EXPIRED even before anything has
 * written that status back — expiry is a fact of the clock, not of a sweep job.
 */
const effectiveStatus = (row: Pick<UserInvitation, 'status' | 'expiresAt'>, now = Date.now()): InvitationStatus =>
  row.status === 'PENDING' && row.expiresAt.getTime() <= now ? 'EXPIRED' : row.status;

/** What an administrator may see. Never the token or its hash. */
const toSummary = (row: SummaryRow) => ({ ...row, status: effectiveStatus(row) });

export type InvitationSummary = ReturnType<typeof toSummary>;

const ttlMs = () => env.INVITATION_EXPIRY_HOURS * 60 * 60 * 1000;
const inviteUrlFor = (token: string) => `${env.APP_URL.replace(/\/+$/, '')}/accept-invitation?token=${encodeURIComponent(token)}`;

/** Filters on the status a caller sees, not the stored one (see effectiveStatus). */
function statusWhere(status: InvitationStatus | undefined, now: Date): Prisma.UserInvitationWhereInput {
  switch (status) {
    case undefined:
      return {};
    case 'PENDING':
      return { status: 'PENDING', expiresAt: { gt: now } };
    case 'EXPIRED':
      return { OR: [{ status: 'EXPIRED' }, { status: 'PENDING', expiresAt: { lte: now } }] };
    default:
      return { status };
  }
}

/** "jane.doe@x.com" → Jane / Doe, for invitees who accept without giving a name. */
function nameFromEmail(email: string): { firstName: string; lastName: string } {
  const parts = email
    .split('@')[0]
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1));
  return { firstName: (parts[0] ?? 'New').slice(0, 80), lastName: (parts.slice(1).join(' ') || 'User').slice(0, 80) };
}

/** Persists the lapse and audits it once; the conditional update makes concurrent callers record it only once. */
async function markExpired(row: { id: string; email: string }, origin: ActivityOrigin): Promise<void> {
  const { count } = await prisma.userInvitation.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
  if (count === 1) {
    void activityService.record(origin, {
      action: 'user.invitation_expired',
      entity: 'invitation',
      entityId: row.id,
      description: `The invitation for ${row.email} expired before it was used`,
      metadata: { email: row.email },
    });
  }
}

/** Resolves a raw token to its live invitation, or throws the single "expired or already used" error. */
async function findUsable(token: string, origin: ActivityOrigin) {
  const row = await prisma.userInvitation.findUnique({
    where: { tokenHash: sha256(token) },
    select: { id: true, email: true, status: true, expiresAt: true, invitedById: true, role: { select: { id: true, name: true } } },
  });
  if (!row) throw invalidLink();
  const status = effectiveStatus(row);
  if (status === 'EXPIRED' && row.status === 'PENDING') await markExpired(row, origin);
  if (status !== 'PENDING') throw invalidLink();
  return row;
}

export const invitationService = {
  /**
   * Generates a single-use invitation link for the Super Admin to copy and
   * share. Any link still pending for the same email is revoked first, so
   * exactly one works at a time — the newest. The raw link is returned only
   * here; afterwards only its hash exists.
   */
  async create(ctx: RequestContext, input: CreateInvitationInput): Promise<{ invitation: InvitationSummary; inviteUrl: string }> {
    const role = await prisma.role.findUnique({ where: { id: input.roleId }, select: { id: true, name: true } });
    if (!role) throw new BadRequestError('Selected role does not exist', 'VALIDATION_ERROR', [{ path: 'roleId', message: 'Role not found' }]);
    await rbacService.assertCanManageRole(ctx.actor, role.id, 'You cannot assign a role with permissions you do not have');
    if (await userRepository.emailTaken(input.email)) throw emailExists();

    const token = randomToken(32);
    const now = new Date();
    let revoked = 0;
    let row: SummaryRow;
    try {
      row = await prisma.$transaction(async (tx) => {
        ({ count: revoked } = await tx.userInvitation.updateMany({
          where: { email: input.email, status: 'PENDING' },
          data: { status: 'REVOKED', revokedAt: now },
        }));
        return tx.userInvitation.create({
          data: { email: input.email, roleId: role.id, invitedById: ctx.actor.id, tokenHash: sha256(token), expiresAt: new Date(now.getTime() + ttlMs()) },
          select: summarySelect,
        });
      });
    } catch (err) {
      // The one-pending-per-email index: another admin invited the same address at the same moment.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictError('An invitation was just generated for this email. Refresh to see it.', 'INVITATION_IN_PROGRESS');
      }
      throw err;
    }

    void activityService.record(ctx, {
      action: 'user.invited',
      entity: 'invitation',
      entityId: row.id,
      description: `${fullName(ctx.actor)} invited ${input.email} as ${role.name}`,
      metadata: { email: input.email, role: role.name, replacedPrevious: revoked > 0 },
    });
    return { invitation: toSummary(row), inviteUrl: inviteUrlFor(token) };
  },

  async list(query: ListInvitationsQuery) {
    const now = new Date();
    const where: Prisma.UserInvitationWhereInput = {
      ...statusWhere(query.status, now),
      ...(query.search ? { email: { contains: query.search, mode: 'insensitive' } } : {}),
    };
    const [rows, total] = await prisma.$transaction([
      prisma.userInvitation.findMany({ where, select: summarySelect, orderBy: { [query.sortBy]: query.sortOrder }, ...skipTake(query.page, query.limit) }),
      prisma.userInvitation.count({ where }),
    ]);
    return { items: rows.map(toSummary), meta: buildMeta(query.page, query.limit, total) };
  },

  /** Kills a link that has not been used yet — e.g. it was shared with the wrong person. */
  async revoke(ctx: RequestContext, id: string): Promise<InvitationSummary> {
    const existing = await prisma.userInvitation.findUnique({ where: { id }, select: { id: true, email: true, status: true, expiresAt: true } });
    if (!existing) throw new NotFoundError('Invitation', 'INVITATION_NOT_FOUND');
    if (effectiveStatus(existing) !== 'PENDING') {
      throw new BadRequestError('Only a pending invitation can be revoked', 'INVITATION_NOT_PENDING');
    }
    const { count } = await prisma.userInvitation.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'REVOKED', revokedAt: new Date() } });
    if (count !== 1) throw new BadRequestError('Only a pending invitation can be revoked', 'INVITATION_NOT_PENDING');

    void activityService.record(ctx, {
      action: 'user.invitation_revoked',
      entity: 'invitation',
      entityId: id,
      description: `${fullName(ctx.actor)} revoked the invitation for ${existing.email}`,
      metadata: { email: existing.email },
    });
    return toSummary(await prisma.userInvitation.findUniqueOrThrow({ where: { id }, select: summarySelect }));
  },

  /** What the Set Password page shows before the invitee submits. */
  async verify(token: string, origin: ActivityOrigin): Promise<{ valid: true; email: string; role: { id: string; name: string }; expiresAt: Date }> {
    const row = await findUsable(token, origin);
    return { valid: true, email: row.email, role: row.role, expiresAt: row.expiresAt };
  },

  /**
   * Creates the account and spends the link in one transaction: the
   * conditional claim means two concurrent submissions cannot both succeed,
   * and a failed user insert leaves the link usable. The invitee is not signed
   * in — they are sent to the Login page with their new password.
   */
  async accept(input: AcceptInvitationInput, origin: ActivityOrigin): Promise<{ email: string }> {
    const row = await findUsable(input.token, origin);
    if (await userRepository.emailTaken(row.email)) throw emailExists();

    const fallback = nameFromEmail(row.email);
    const firstName = input.firstName ?? fallback.firstName;
    const lastName = input.lastName ?? fallback.lastName;
    const passwordHash = await hashPassword(input.password);
    const now = new Date();

    let user: { id: string; email: string; firstName: string; lastName: string };
    try {
      user = await prisma.$transaction(async (tx) => {
        const claimed = await tx.userInvitation.updateMany({
          where: { id: row.id, status: 'PENDING', expiresAt: { gt: now } },
          data: { status: 'ACCEPTED', acceptedAt: now },
        });
        if (claimed.count !== 1) throw invalidLink();
        const createdUser = await tx.user.create({
          data: { firstName, lastName, email: row.email, passwordHash, roleId: row.role.id, status: 'ACTIVE' },
          select: { id: true, email: true, firstName: true, lastName: true },
        });
        await tx.userInvitation.update({ where: { id: row.id }, data: { acceptedUserId: createdUser.id } });
        return createdUser;
      });
    } catch (err) {
      // users_email_active_key: an account with this email appeared between the check and the insert.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw emailExists();
      throw err;
    }

    await cache.invalidate('dashboard');
    void producers.welcomeEmail({ id: user.id, email: user.email, firstName: user.firstName }, row.invitedById ?? user.id);
    void activityService.record(
      { ...origin, actorId: user.id },
      {
        action: 'user.invitation_accepted',
        entity: 'user',
        entityId: user.id,
        description: `${fullName(user)} accepted their invitation and joined as ${row.role.name}`,
        metadata: { invitationId: row.id, email: user.email, role: row.role.name },
        notify: row.invitedById
          ? [{ userId: row.invitedById, type: 'user.invitation_accepted', title: `${fullName(user)} accepted your invitation`, link: `/users/${user.id}` }]
          : [],
      },
    );
    return { email: user.email };
  },
};
