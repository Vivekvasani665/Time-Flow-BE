import type { Prisma } from '@prisma/client';
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
