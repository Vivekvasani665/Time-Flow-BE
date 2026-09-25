import type { ProjectStatus, TaskStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { cache } from '../../cache/cache.service';
import { userRefSelect } from '../../common/http/selects';
import type { AuthContext } from '../auth/auth.types';
import { projectScope, projectSelect, toProjects } from '../projects/project.repository';
import { taskScope, taskSelect, toTask } from '../tasks/task.repository';

const TASK_STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'REVIEW', 'COMPLETED'];
const PROJECT_STATUSES: ProjectStatus[] = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED'];

async function build(actor: AuthContext) {
  const canUsers = actor.permissions.has('users.view');
  const canProjects = actor.permissions.has('projects.view');
  const canTasks = actor.permissions.has('tasks.view');
  const canActivity = actor.permissions.has('activity_logs.view');
  const pScope = projectScope(actor);
  const tScope = taskScope(actor);

  const [totalUsers, activeUsers, projectGroups, taskGroups, recentProjectRecords, recentActivity, myTasks] = await Promise.all([
    canUsers ? prisma.user.count({ where: { deletedAt: null, status: { not: 'PENDING' } } }) : null,
    canUsers ? prisma.user.count({ where: { deletedAt: null, status: 'ACTIVE' } }) : null,
    canProjects ? prisma.project.groupBy({ by: ['status'], where: pScope, _count: { _all: true } }) : [],
    canTasks ? prisma.task.groupBy({ by: ['status'], where: tScope, _count: { _all: true } }) : [],
    canProjects ? prisma.project.findMany({ where: pScope, select: projectSelect, orderBy: { updatedAt: 'desc' }, take: 5 }) : [],
    canActivity
      ? prisma.activityLog.findMany({
          select: {
            id: true,
            action: true,
            entity: true,
            entityId: true,
            description: true,
            metadata: true,
            ipAddress: true,
            createdAt: true,
            user: { select: userRefSelect },
          },
          orderBy: { createdAt: 'desc' },
          take: 8,
        })
      : [],
    canTasks
      ? prisma.task.findMany({
          where: { AND: [tScope, { assigneeId: actor.id, status: { not: 'COMPLETED' } }] },
          select: taskSelect,
          orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
          take: 5,
        })
      : [],
  ]);

  const projectCount = new Map(projectGroups.map((g) => [g.status, g._count._all]));
  const taskCount = new Map(taskGroups.map((g) => [g.status, g._count._all]));
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

  return {
    stats: {
      totalUsers,
      activeUsers,
      totalProjects: sum(projectCount),
      activeProjects: projectCount.get('ACTIVE') ?? 0,
      totalTasks: sum(taskCount),
      completedTasks: taskCount.get('COMPLETED') ?? 0,
    },
    tasksByStatus: TASK_STATUSES.map((status) => ({ status, count: taskCount.get(status) ?? 0 })),
    projectsByStatus: PROJECT_STATUSES.map((status) => ({ status, count: projectCount.get(status) ?? 0 })),
    recentProjects: await toProjects(recentProjectRecords),
    recentActivity,
    myTasks: myTasks.map(toTask),
  };
}

export type DashboardData = Awaited<ReturnType<typeof build>>;

export const dashboardService = {
  /** Cached per user: the payload mixes global counts with personal scope. */
  get(actor: AuthContext) {
    const permissionFingerprint = [...actor.permissions].sort().join(',');
    return cache.remember<DashboardData>('dashboard', `u:${actor.id}`, { p: permissionFingerprint }, () => build(actor));
  },
};
