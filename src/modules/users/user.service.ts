import { prisma } from '../../lib/prisma';
import { cache } from '../../cache/cache.service';
import { producers } from '../../queue/producers';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../common/errors';
import { buildMeta } from '../../common/http/response';
import { fullName, type RequestContext } from '../../common/utils/request-context';
import { activityService } from '../activity-logs/activity.service';
import { rbacService } from '../permissions/rbac.service';
import { hashPassword } from '../auth/auth.service';
import { twoFactorService } from '../auth/two-factor.service';
import { userRepository, userSelect } from './user.repository';
import type { CreateUserInput, ListUsersQuery, UpdateUserInput } from './user.schemas';
import { userRefSelect } from '../../common/http/selects';

const EMAIL_EXISTS = () => new ConflictError('Email already exists', 'USER_EMAIL_EXISTS');

async function assertRoleExists(roleId: string): Promise<{ id: string; name: string }> {
  const role = await prisma.role.findUnique({ where: { id: roleId }, select: { id: true, name: true } });
  if (!role) throw new BadRequestError('Selected role does not exist', 'VALIDATION_ERROR', [{ path: 'roleId', message: 'Role not found' }]);
  return role;
}

async function loadTarget(id: string) {
  const user = await userRepository.findActiveById(id);
  if (!user) throw new NotFoundError('User');
  return user;
}

/** Prevents lower-privileged actors from modifying users who out-rank them. */
async function assertCanManageUser(ctx: RequestContext, target: { id: string; roleId: string }) {
  if (target.id === ctx.actor.id) return;
  await rbacService.assertCanManageRole(ctx.actor, target.roleId, 'You cannot manage a user with more privileges than you');
}

export const userService = {
  async list(query: ListUsersQuery) {
    const { items, total } = await userRepository.list(query);
    return { items, meta: buildMeta(query.page, query.limit, total) };
  },

  async get(id: string) {
    const user = await loadTarget(id);
    const { roleId: _roleId, ...rest } = user;
    return { ...rest, stats: await userRepository.stats(id) };
  },

  options(search?: string) {
    const contains = search ? { contains: search, mode: 'insensitive' as const } : undefined;
    return prisma.user.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        ...(contains ? { OR: [{ firstName: contains }, { lastName: contains }, { email: contains }] } : {}),
      },
      select: userRefSelect,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: 200,
    });
  },

  async create(ctx: RequestContext, input: CreateUserInput) {
    const role = await assertRoleExists(input.roleId);
    await rbacService.assertCanManageRole(ctx.actor, role.id, 'You cannot assign a role with permissions you do not have');
    if (await userRepository.emailTaken(input.email)) throw EMAIL_EXISTS();

    // Explicit field whitelist — request bodies are never spread into Prisma.
    const user = await prisma.user.create({
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone ?? null,
        avatarUrl: input.avatarUrl ?? null,
        status: input.status,
        roleId: role.id,
        passwordHash: await hashPassword(input.password),
      },
      select: userSelect,
    });

    await cache.invalidate('dashboard');
    void producers.welcomeEmail({ id: user.id, email: user.email, firstName: user.firstName }, ctx.actor.id);
    void activityService.record(ctx, {
      action: 'user.created',
      entity: 'user',
      entityId: user.id,
      description: `${fullName(ctx.actor)} created user ${fullName(user)}`,
      metadata: { email: user.email, role: role.name },
    });
    return user;
  },

  async update(ctx: RequestContext, id: string, input: UpdateUserInput) {
    const target = await loadTarget(id);
    const isSelf = target.id === ctx.actor.id;
    await assertCanManageUser(ctx, target);

    if (isSelf && input.roleId && input.roleId !== target.roleId) throw new ForbiddenError('You cannot change your own role');
    if (isSelf && input.status === 'INACTIVE') throw new ForbiddenError('You cannot deactivate your own account');

    let newRoleName: string | undefined;
    if (input.roleId && input.roleId !== target.roleId) {
      const role = await assertRoleExists(input.roleId);
      await rbacService.assertCanManageRole(ctx.actor, role.id, 'You cannot assign a role with permissions you do not have');
      newRoleName = role.name;
    }
    if (input.email && input.email !== target.email && (await userRepository.emailTaken(input.email, id))) throw EMAIL_EXISTS();

    const changed = (Object.keys(input) as (keyof UpdateUserInput)[]).filter((key) => {
      if (key === 'password') return true;
      return input[key] !== undefined && input[key] !== (target as Record<string, unknown>)[key];
    });
    const statusChanged = input.status !== undefined && input.status !== target.status;
    const roleChanged = newRoleName !== undefined;
    const revokeSessions = input.password !== undefined || (statusChanged && input.status === 'INACTIVE');

    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: {
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone,
          avatarUrl: input.avatarUrl,
          status: input.status,
          roleId: input.roleId,
          ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}),
          ...(revokeSessions ? { tokenVersion: { increment: 1 } } : {}),
        },
        select: userSelect,
      });
      if (revokeSessions) {
        await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      return updated;
    });

    await rbacService.invalidateUser(id);
    await cache.invalidate('dashboard', 'projects');

    const actorName = fullName(ctx.actor);
    if (statusChanged) {
      void activityService.record(ctx, {
        action: 'user.status_changed',
        entity: 'user',
        entityId: id,
        description: `${actorName} ${input.status === 'ACTIVE' ? 'activated' : 'deactivated'} user ${fullName(user)}`,
        metadata: { from: target.status, to: input.status },
      });
    }
    if (roleChanged) {
      void activityService.record(ctx, {
        action: 'user.role_changed',
        entity: 'user',
        entityId: id,
        description: `${actorName} changed ${fullName(user)}'s role from ${target.role.name} to ${newRoleName}`,
        metadata: { from: target.role.name, to: newRoleName },
        notify: [{ userId: id, type: 'user.role_changed', title: `Your role is now ${newRoleName}`, link: '/profile' }],
      });
    }
    const otherChanges = changed.filter((k) => k !== 'status' && k !== 'roleId');
    if (otherChanges.length > 0) {
      void activityService.record(ctx, {
        action: 'user.updated',
        entity: 'user',
        entityId: id,
        description: `${actorName} updated user ${fullName(user)}`,
        metadata: { fields: otherChanges },
      });
    }
    return user;
  },

  /** For a user locked out of both their authenticator and their recovery codes. */
  async resetTwoFactor(ctx: RequestContext, id: string) {
    const target = await loadTarget(id);
    await assertCanManageUser(ctx, target);
    if (!target.twoFactorEnabled) throw new BadRequestError('Two-factor authentication is not enabled for this user', 'TWO_FACTOR_NOT_ENABLED');

    await twoFactorService.clear(id);
    void activityService.record(ctx, {
      action: 'user.2fa_reset',
      entity: 'user',
      entityId: id,
      description: `${fullName(ctx.actor)} reset two-factor authentication for ${fullName(target)}`,
      notify: [{ userId: id, type: 'user.2fa_reset', title: 'Your two-factor authentication was reset by an administrator', link: '/profile' }],
    });
  },

  async remove(ctx: RequestContext, id: string) {
    const target = await loadTarget(id);
    if (target.id === ctx.actor.id) throw new ForbiddenError('You cannot delete your own account');
    await assertCanManageUser(ctx, target);

    await prisma.$transaction([
      prisma.user.update({
        where: { id },
        data: { deletedAt: new Date(), status: 'INACTIVE', tokenVersion: { increment: 1 } },
      }),
      prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
      prisma.projectMember.deleteMany({ where: { userId: id } }),
    ]);

    await rbacService.invalidateUser(id);
    await cache.invalidate('dashboard', 'projects');
    void activityService.record(ctx, {
      action: 'user.deleted',
      entity: 'user',
      entityId: id,
      description: `${fullName(ctx.actor)} deleted user ${fullName(target)}`,
      metadata: { email: target.email },
    });
  },
};
