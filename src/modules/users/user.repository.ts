import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { skipTake } from '../../common/http/pagination';
import type { ListUsersQuery } from './user.schemas';

export const userSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  avatarUrl: true,
  status: true,
  lastLoginAt: true,
  twoFactorEnabled: true,
  createdAt: true,
  updatedAt: true,
  role: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect;

export type UserRecord = Prisma.UserGetPayload<{ select: typeof userSelect }>;

export function buildUserWhere(query: Pick<ListUsersQuery, 'search' | 'status' | 'roleId'>): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = { deletedAt: null };
  if (query.status) where.status = query.status;
  if (query.roleId) where.roleId = query.roleId;
  if (query.search) {
    const contains = { contains: query.search, mode: 'insensitive' as const };
    where.OR = [{ firstName: contains }, { lastName: contains }, { email: contains }, { phone: contains }];
  }
  return where;
}

function userOrderBy({ sortBy, sortOrder }: Pick<ListUsersQuery, 'sortBy' | 'sortOrder'>): Prisma.UserOrderByWithRelationInput {
  if (sortBy === 'lastLoginAt') return { lastLoginAt: { sort: sortOrder, nulls: 'last' } };
  return { [sortBy]: sortOrder };
}

export const userRepository = {
  async list(query: ListUsersQuery, extraWhere: Prisma.UserWhereInput = {}) {
    const where: Prisma.UserWhereInput = { AND: [buildUserWhere(query), extraWhere] };
    const [items, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        select: userSelect,
        orderBy: [userOrderBy(query), { id: 'asc' }],
        ...skipTake(query.page, query.limit),
      }),
      prisma.user.count({ where }),
    ]);
    return { items, total };
  },

  findActiveById(id: string) {
    return prisma.user.findFirst({ where: { id, deletedAt: null }, select: { ...userSelect, roleId: true } });
  },

  emailTaken(email: string, excludeId?: string) {
    return prisma.user
      .count({ where: { email, deletedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) } })
      .then((n) => n > 0);
  },

  /** Compared on digits only, matching the `users_phone_active_key` index. */
  /** Matches on digits only, so `+91 98765-43210` finds `+919876543210`. Unverified signups are skipped. */
  async findIdByPhone(phone: string): Promise<string | null> {
    const digits = phone.replace(/\D/g, '');
    if (!digits) return null;
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM users
      WHERE deleted_at IS NULL AND phone IS NOT NULL
        AND regexp_replace(phone, '[^0-9]', '', 'g') = ${digits}
      ORDER BY (status = 'PENDING') ASC
      LIMIT 1`;
    return rows[0]?.id ?? null;
  },

  async phoneTaken(phone: string, opts: { excludeId?: string; ignorePending?: boolean } = {}) {
    const digits = phone.replace(/\D/g, '');
    if (!digits) return false;
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users
      WHERE deleted_at IS NULL AND phone IS NOT NULL
        AND regexp_replace(phone, '[^0-9]', '', 'g') = ${digits}
        ${opts.excludeId ? Prisma.sql`AND id <> ${opts.excludeId}::uuid` : Prisma.empty}
        ${opts.ignorePending ? Prisma.sql`AND status <> 'PENDING'` : Prisma.empty}`;
    return (rows[0]?.n ?? 0) > 0;
  },

  async stats(userId: string) {
    const [assignedTasks, completedTasks, projects] = await prisma.$transaction([
      prisma.task.count({ where: { assigneeId: userId, deletedAt: null, project: { deletedAt: null } } }),
      prisma.task.count({ where: { assigneeId: userId, status: 'COMPLETED', deletedAt: null, project: { deletedAt: null } } }),
      prisma.project.count({
        where: { deletedAt: null, OR: [{ managerId: userId }, { members: { some: { userId } } }] },
      }),
    ]);
    return { assignedTasks, completedTasks, projects };
  },
};
