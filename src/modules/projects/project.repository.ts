import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { userRefSelect } from '../../common/http/selects';
import type { AuthContext } from '../auth/auth.types';

export const projectSelect = {
  id: true,
  name: true,
  description: true,
  status: true,
  priority: true,
  startDate: true,
  endDate: true,
  managerId: true,
  createdAt: true,
  updatedAt: true,
  manager: { select: userRefSelect },
  members: { select: { user: { select: userRefSelect } }, orderBy: { joinedAt: 'asc' } },
} satisfies Prisma.ProjectSelect;

export type ProjectRecord = Prisma.ProjectGetPayload<{ select: typeof projectSelect }>;

/**
 * Row-level data scope. Without `projects.view_all` a user only sees projects
 * they manage or are a member of. Applied to every read *and* write lookup.
 */
export function projectScope(actor: AuthContext): Prisma.ProjectWhereInput {
  if (actor.permissions.has('projects.view_all')) return { deletedAt: null };
  return {
    deletedAt: null,
    OR: [{ managerId: actor.id }, { members: { some: { userId: actor.id } } }],
  };
}

export async function taskStatsFor(projectIds: string[]): Promise<Map<string, { total: number; completed: number }>> {
  const stats = new Map(projectIds.map((id) => [id, { total: 0, completed: 0 }]));
  if (projectIds.length === 0) return stats;
  const groups = await prisma.task.groupBy({
    by: ['projectId', 'status'],
    where: { projectId: { in: projectIds }, deletedAt: null },
    _count: { _all: true },
  });
  for (const g of groups) {
    const s = stats.get(g.projectId);
    if (!s) continue;
    s.total += g._count._all;
    if (g.status === 'COMPLETED') s.completed += g._count._all;
  }
  return stats;
}

export async function toProjects(records: ProjectRecord[]) {
  const stats = await taskStatsFor(records.map((r) => r.id));
  return records.map((r) => {
    const { members, managerId: _managerId, ...rest } = r;
    return {
      ...rest,
      members: members.map((m) => m.user),
      taskStats: stats.get(r.id) ?? { total: 0, completed: 0 },
    };
  });
}

export type ProjectDto = Awaited<ReturnType<typeof toProjects>>[number];
