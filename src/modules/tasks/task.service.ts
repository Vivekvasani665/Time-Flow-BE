import type { Prisma, TaskStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { cache } from '../../cache/cache.service';
import { skipTake } from '../../common/http/pagination';
import { buildMeta } from '../../common/http/response';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../common/errors';
import { fullName, type RequestContext } from '../../common/utils/request-context';
import { producers } from '../../queue/producers';
import { activityService } from '../activity-logs/activity.service';
import type { AuthContext } from '../auth/auth.types';
import { isTaskPrivileged, taskScope, taskSelect, toTask } from './task.repository';
import type { CreateTaskInput, ListTasksQuery, UpdateTaskInput } from './task.schemas';

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  TODO: 'Todo',
  IN_PROGRESS: 'In Progress',
  REVIEW: 'Review',
  COMPLETED: 'Completed',
};

async function findScoped(actor: AuthContext, id: string) {
  const task = await prisma.task.findFirst({ where: { AND: [{ id }, taskScope(actor)] }, select: taskSelect });
  if (!task) throw new NotFoundError('Task');
  return task;
}

/**
 * Project the actor may place tasks in: any project with `tasks.view_all` or
 * `projects.view_all`; otherwise one they manage or belong to.
 */
async function loadWritableProject(actor: AuthContext, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, name: true, managerId: true, members: { select: { userId: true } } },
  });
  const global = actor.permissions.has('tasks.view_all') || actor.permissions.has('projects.view_all');
  const involved = project && (project.managerId === actor.id || project.members.some((m) => m.userId === actor.id));
  if (!project || (!global && !involved)) {
    throw new BadRequestError('Project not found or not accessible', 'VALIDATION_ERROR', [{ path: 'projectId', message: 'Project not found' }]);
  }
  return project;
}

async function assertAssignable(project: { managerId: string; members: { userId: string }[] }, assigneeId: string) {
  const inProject = project.managerId === assigneeId || project.members.some((m) => m.userId === assigneeId);
  const active = await prisma.user.count({ where: { id: assigneeId, deletedAt: null, status: 'ACTIVE' } });
  if (!inProject || active === 0) {
    throw new BadRequestError('Assignee must be an active member of the project', 'VALIDATION_ERROR', [
      { path: 'assigneeId', message: 'Assignee must be the project manager or a project member' },
    ]);
  }
}

const completedAtFor = (status: TaskStatus | undefined, previous: TaskStatus | null, current: Date | null) => {
  if (status === undefined || status === previous) return undefined;
  if (status === 'COMPLETED') return new Date();
  return current ? null : undefined;
};

export const taskService = {
  async list(actor: AuthContext, query: ListTasksQuery) {
    const filters: Prisma.TaskWhereInput = {};
    if (query.status) filters.status = query.status;
    if (query.priority) filters.priority = query.priority;
    if (query.projectId) filters.projectId = query.projectId;
    if (query.assigneeId) filters.assigneeId = query.assigneeId === 'me' ? actor.id : query.assigneeId;
    if (query.search) {
      filters.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const where: Prisma.TaskWhereInput = { AND: [taskScope(actor), filters] };
    const orderBy: Prisma.TaskOrderByWithRelationInput =
      query.sortBy === 'dueDate' ? { dueDate: { sort: query.sortOrder, nulls: 'last' } } : { [query.sortBy]: query.sortOrder };

    const [records, total] = await prisma.$transaction([
      prisma.task.findMany({ where, select: taskSelect, orderBy: [orderBy, { id: 'asc' }], ...skipTake(query.page, query.limit) }),
      prisma.task.count({ where }),
    ]);
    return { items: records.map(toTask), meta: buildMeta(query.page, query.limit, total) };
  },

  async get(actor: AuthContext, id: string) {
    return toTask(await findScoped(actor, id));
  },

  async create(ctx: RequestContext, input: CreateTaskInput) {
    const { actor } = ctx;
    const project = await loadWritableProject(actor, input.projectId);
    if (input.assigneeId) await assertAssignable(project, input.assigneeId);

    const record = await prisma.task.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        projectId: project.id,
        assigneeId: input.assigneeId ?? null,
        status: input.status,
        priority: input.priority,
        dueDate: input.dueDate ?? null,
        createdById: actor.id,
        completedAt: input.status === 'COMPLETED' ? new Date() : null,
      },
      select: taskSelect,
    });

    await cache.invalidate('projects', 'dashboard');
    void activityService.record(ctx, {
      action: 'task.created',
      entity: 'task',
      entityId: record.id,
      description: `${fullName(actor)} created task ${record.title} in ${project.name}`,
      metadata: { projectId: project.id, assigneeId: record.assigneeId, status: record.status },
      notify: record.assigneeId
        ? [{ userId: record.assigneeId, type: 'task.assigned', title: `New task assigned: ${record.title}`, body: project.name, link: `/tasks/${record.id}` }]
        : [],
    });
    // After the write, and deliberately not awaited: the task is saved either way.
    if (record.assignee) {
      void producers.taskAssignedEmail({
        task: record,
        project,
        assignee: record.assignee,
        assignedBy: fullName(actor),
      });
    }
    return toTask(record);
  },

  async update(ctx: RequestContext, id: string, input: UpdateTaskInput) {
    const { actor } = ctx;
    const existing = await findScoped(actor, id);

    if (!isTaskPrivileged(actor, existing)) {
      const onlyStatus = Object.keys(input).every((k) => k === 'status');
      if (existing.assigneeId !== actor.id || !onlyStatus) {
        throw new ForbiddenError('You can only change the status of tasks assigned to you');
      }
    }

    const projectChanged = input.projectId !== undefined && input.projectId !== existing.project.id;
    const assigneeId = input.assigneeId === undefined ? existing.assigneeId : input.assigneeId;
    if (projectChanged || (input.assigneeId && input.assigneeId !== existing.assigneeId)) {
      const project = await loadWritableProject(actor, input.projectId ?? existing.project.id);
      if (assigneeId) await assertAssignable(project, assigneeId);
    }

    const record = await prisma.task.update({
      where: { id },
      data: {
        title: input.title,
        description: input.description,
        projectId: input.projectId,
        assigneeId: input.assigneeId,
        status: input.status,
        priority: input.priority,
        dueDate: input.dueDate,
        completedAt: completedAtFor(input.status, existing.status, existing.completedAt),
      },
      select: taskSelect,
    });

    await cache.invalidate('projects', 'dashboard');

    const actorName = fullName(actor);
    if (input.status && input.status !== existing.status) {
      void activityService.record(ctx, {
        action: 'task.status_changed',
        entity: 'task',
        entityId: id,
        description: `${actorName} changed task ${record.title} status from ${TASK_STATUS_LABEL[existing.status]} to ${TASK_STATUS_LABEL[input.status]}`,
        metadata: { from: existing.status, to: input.status, projectId: record.project.id },
        notify:
          existing.createdById && existing.createdById !== actor.id
            ? [{ userId: existing.createdById, type: 'task.status_changed', title: `${record.title} → ${TASK_STATUS_LABEL[input.status]}`, link: `/tasks/${id}` }]
            : [],
      });
      // The task's author is the one tracking its progress. Mailing the actor
      // about their own change would be noise, so they are skipped — same rule
      // as the in-app notification above.
      if (existing.createdBy && existing.createdById !== actor.id) {
        void producers.taskStatusChangedEmail({
          task: record,
          project: record.project,
          recipient: existing.createdBy,
          fromStatus: TASK_STATUS_LABEL[existing.status],
          toStatus: TASK_STATUS_LABEL[input.status],
          changedBy: actorName,
        });
      }
    }
    if (input.assigneeId !== undefined && input.assigneeId !== existing.assigneeId) {
      void activityService.record(ctx, {
        action: 'task.assigned',
        entity: 'task',
        entityId: id,
        description: record.assignee
          ? `${actorName} assigned task ${record.title} to ${fullName(record.assignee)}`
          : `${actorName} unassigned task ${record.title}`,
        metadata: { from: existing.assigneeId, to: input.assigneeId },
        notify: input.assigneeId
          ? [{ userId: input.assigneeId, type: 'task.assigned', title: `Task assigned to you: ${record.title}`, link: `/tasks/${id}` }]
          : [],
      });
      if (record.assignee) {
        void producers.taskAssignedEmail({
          task: record,
          project: record.project,
          assignee: record.assignee,
          assignedBy: actorName,
        });
      }
    }
    const otherFields = Object.keys(input).filter((k) => k !== 'status' && k !== 'assigneeId');
    if (otherFields.length > 0) {
      void activityService.record(ctx, {
        action: 'task.updated',
        entity: 'task',
        entityId: id,
        description: `${actorName} updated task ${record.title}`,
        metadata: { fields: otherFields },
      });
    }
    return toTask(record);
  },

  async remove(ctx: RequestContext, id: string) {
    const existing = await findScoped(ctx.actor, id);
    if (!isTaskPrivileged(ctx.actor, existing) && existing.createdById !== ctx.actor.id) {
      throw new ForbiddenError('Only the project manager or task creator can delete this task');
    }
    await prisma.task.update({ where: { id }, data: { deletedAt: new Date() } });
    await cache.invalidate('projects', 'dashboard');
    void activityService.record(ctx, {
      action: 'task.deleted',
      entity: 'task',
      entityId: id,
      description: `${fullName(ctx.actor)} deleted task ${existing.title}`,
      metadata: { projectId: existing.project.id },
    });
  },
};
