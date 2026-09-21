import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { cache } from '../../cache/cache.service';
import { skipTake } from '../../common/http/pagination';
import { buildMeta } from '../../common/http/response';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import { fullName, type RequestContext } from '../../common/utils/request-context';
import { activityService } from '../activity-logs/activity.service';
import { rbacService } from '../permissions/rbac.service';
import { userSelect } from '../users/user.repository';
import type { CreateRoleInput, ListRolesQuery, RoleUsersQuery, UpdateRoleInput } from './role.schemas';

const roleSelect = {
  id: true,
  name: true,
  description: true,
  isSystem: true,
  createdAt: true,
  updatedAt: true,
  permissions: { select: { permission: { select: { key: true } } } },
  _count: { select: { users: { where: { deletedAt: null } } } },
} satisfies Prisma.RoleSelect;

type RoleRecord = Prisma.RoleGetPayload<{ select: typeof roleSelect }>;

function toRole(role: RoleRecord) {
  const { permissions, _count, ...rest } = role;
  return { ...rest, permissions: permissions.map((p) => p.permission.key).sort(), userCount: _count.users };
}

async function resolvePermissionIds(keys: string[]): Promise<Map<string, string>> {
  const rows = await prisma.permission.findMany({ where: { key: { in: keys } }, select: { id: true, key: true } });
  const found = new Map(rows.map((r) => [r.key, r.id]));
  const unknown = keys.filter((k) => !found.has(k));
  if (unknown.length > 0) {
    throw new ValidationError(unknown.map((k) => ({ path: 'permissions', message: `Unknown permission: ${k}` })));
  }
  return found;
}

async function assertNameAvailable(name: string, excludeId?: string) {
  const clash = await prisma.role.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  if (clash) throw new ConflictError('Role name already exists', 'ROLE_NAME_EXISTS');
}

async function loadRole(id: string) {
  const role = await prisma.role.findUnique({ where: { id }, select: roleSelect });
  if (!role) throw new NotFoundError('Role');
  return role;
}

export const roleService = {
  async list(query: ListRolesQuery) {
    const where: Prisma.RoleWhereInput = query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {};
    const [items, total] = await prisma.$transaction([
      prisma.role.findMany({
        where,
        select: roleSelect,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        ...skipTake(query.page, query.limit),
      }),
      prisma.role.count({ where }),
    ]);
    return { items: items.map(toRole), meta: buildMeta(query.page, query.limit, total) };
  },

  async get(id: string) {
    return toRole(await loadRole(id));
  },

  async users(id: string, query: RoleUsersQuery) {
    await loadRole(id);
    const where: Prisma.UserWhereInput = { roleId: id, deletedAt: null };
    const [items, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        select: userSelect,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        ...skipTake(query.page, query.limit),
      }),
      prisma.user.count({ where }),
    ]);
    return { items, meta: buildMeta(query.page, query.limit, total) };
  },

  async create(ctx: RequestContext, input: CreateRoleInput) {
    await assertNameAvailable(input.name);
    const permissionIds = await resolvePermissionIds(input.permissions);
    rbacService.assertHoldsAll(ctx.actor, input.permissions, 'You cannot grant permissions you do not have');

    const role = await prisma.role.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        permissions: { create: [...permissionIds.values()].map((permissionId) => ({ permissionId })) },
      },
      select: roleSelect,
    });

    void activityService.record(ctx, {
      action: 'role.created',
      entity: 'role',
      entityId: role.id,
      description: `${fullName(ctx.actor)} created role ${role.name}`,
      metadata: { permissions: input.permissions },
    });
    return toRole(role);
  },

  async update(ctx: RequestContext, id: string, input: UpdateRoleInput) {
    const existing = await loadRole(id);
    if (input.name && input.name !== existing.name) {
      if (existing.isSystem) throw new ForbiddenError('The Super Admin role cannot be renamed');
      await assertNameAvailable(input.name, id);
    }

    const current = new Set(existing.permissions.map((p) => p.permission.key));
    let added: string[] = [];
    let removed: string[] = [];
    let permissionIds = new Map<string, string>();

    if (input.permissions) {
      const next = new Set(input.permissions);
      added = [...next].filter((k) => !current.has(k));
      removed = [...current].filter((k) => !next.has(k));
      if ((added.length || removed.length) && existing.isSystem) {
        throw new ForbiddenError('Super Admin permissions cannot be changed');
      }
      permissionIds = await resolvePermissionIds(input.permissions);
      rbacService.assertHoldsAll(ctx.actor, [...added, ...removed], 'You cannot grant or revoke permissions you do not have');
    }
    const permissionsChanged = added.length > 0 || removed.length > 0;

    // Replace the permission set atomically: readers never observe a half-applied role.
    const role = await prisma.$transaction(async (tx) => {
      if (permissionsChanged) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({
          data: [...permissionIds.values()].map((permissionId) => ({ roleId: id, permissionId })),
        });
      }
      return tx.role.update({
        where: { id },
        data: { name: input.name, description: input.description },
        select: roleSelect,
      });
    });

    if (permissionsChanged) {
      await rbacService.invalidateRole(id);
      await cache.invalidate('projects', 'dashboard');
      void activityService.record(ctx, {
        action: 'role.permissions_changed',
        entity: 'role',
        entityId: id,
        description: `${fullName(ctx.actor)} changed permissions of role ${role.name}`,
        metadata: { added, removed },
      });
    }
    if (input.name !== undefined || input.description !== undefined) {
      const renamed = input.name !== undefined && input.name !== existing.name;
      if (renamed) {
        const affected = await prisma.user.findMany({ where: { roleId: id }, select: { id: true } });
        await rbacService.invalidateUser(...affected.map((u) => u.id));
      }
      if (renamed || input.description !== existing.description) {
        void activityService.record(ctx, {
          action: 'role.updated',
          entity: 'role',
          entityId: id,
          description: `${fullName(ctx.actor)} updated role ${role.name}`,
          metadata: renamed ? { from: existing.name, to: role.name } : {},
        });
      }
    }
    return toRole(role);
  },

  async remove(ctx: RequestContext, id: string) {
    const role = await loadRole(id);
    if (role.isSystem) throw new ForbiddenError('The Super Admin role cannot be deleted');

    // Soft-deleted users still reference the role (FK RESTRICT), so count everyone.
    const assigned = await prisma.user.count({ where: { roleId: id } });
    if (assigned > 0) {
      throw new ConflictError(`Role is assigned to ${assigned} user(s). Reassign them before deleting.`, 'ROLE_IN_USE');
    }

    await prisma.role.delete({ where: { id } });
    await rbacService.invalidateRole(id);
    void activityService.record(ctx, {
      action: 'role.deleted',
      entity: 'role',
      entityId: id,
      description: `${fullName(ctx.actor)} deleted role ${role.name}`,
    });
  },
};
