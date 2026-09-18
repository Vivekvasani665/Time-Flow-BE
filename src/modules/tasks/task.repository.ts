import type { Prisma } from '@prisma/client';
import { userRefSelect } from '../../common/http/selects';
import type { AuthContext } from '../auth/auth.types';

export const taskSelect = {
  id: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  dueDate: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  assigneeId: true,
  createdById: true,
  project: { select: { id: true, name: true, managerId: true } },
  assignee: { select: userRefSelect },
  createdBy: { select: userRefSelect },
} satisfies Prisma.TaskSelect;

export type TaskRecord = Prisma.TaskGetPayload<{ select: typeof taskSelect }>;

export function toTask(t: TaskRecord) {
  const { assigneeId: _a, createdById: _c, project, ...rest } = t;
  return { ...rest, project: { id: project.id, name: project.name } };
}

/**
 * Row-level scope for tasks. Without `tasks.view_all` a user sees tasks
 * assigned to them, created by them, or in projects they manage.
 */
export function taskScope(actor: AuthContext): Prisma.TaskWhereInput {
  const base: Prisma.TaskWhereInput = { deletedAt: null, project: { deletedAt: null } };
  if (actor.permissions.has('tasks.view_all')) return base;
  return {
    ...base,
    OR: [{ assigneeId: actor.id }, { createdById: actor.id }, { project: { managerId: actor.id, deletedAt: null } }],
  };
}

/** Full edit rights over a task: global scope or managing its project. */
export function isTaskPrivileged(actor: AuthContext, task: { project: { managerId: string } }): boolean {
  return actor.permissions.has('tasks.view_all') || task.project.managerId === actor.id;
}
