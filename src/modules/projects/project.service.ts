import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { cache } from '../../cache/cache.service';
import { skipTake } from '../../common/http/pagination';
import { buildMeta, type PaginationMeta } from '../../common/http/response';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../common/errors';
import { fullName, type RequestContext } from '../../common/utils/request-context';
import { producers } from '../../queue/producers';
import { activityService, type ActivityEvent } from '../activity-logs/activity.service';
import type { AuthContext } from '../auth/auth.types';
import { projectScope, projectSelect, toProjects, type ProjectDto, type ProjectRecord } from './project.repository';
import type { CreateProjectInput, ListProjectsQuery, UpdateProjectInput } from './project.schemas';

const STATUS_LABEL: Record<string, string> = {
  PLANNING: 'Planning',
  ACTIVE: 'Active',
  ON_HOLD: 'On Hold',
  COMPLETED: 'Completed',
  ARCHIVED: 'Archived',
};

async function assertActiveUsers(ids: string[], path: string): Promise<void> {
  if (ids.length === 0) return;
  const found = await prisma.user.count({ where: { id: { in: ids }, deletedAt: null, status: 'ACTIVE' } });
  if (found !== ids.length) {
    throw new BadRequestError('One or more selected users do not exist or are inactive', 'VALIDATION_ERROR', [
      { path, message: 'User not found or inactive' },
    ]);
  }
}

async function findScoped(actor: AuthContext, id: string) {
  const project = await prisma.project.findFirst({ where: { AND: [{ id }, projectScope(actor)] }, select: projectSelect });
  if (!project) throw new NotFoundError('Project');
  return project;
}

function assertCanModify(actor: AuthContext, project: { managerId: string }) {
  if (actor.permissions.has('projects.view_all') || project.managerId === actor.id) return;
  throw new ForbiddenError('Only the project manager can modify this project');
}

/**
 * Mails everyone newly added to a project. Deliberately not awaited: the
 * membership is already committed, and a mail problem must not fail the write.
 * Whoever did the adding is skipped — they know.
 */
function mailInvitations(record: ProjectRecord, addedIds: string[], invitedBy: string, actorId: string): void {
  if (addedIds.length === 0) return;
  const added = new Set(addedIds);
  for (const { user } of record.members) {
    if (!added.has(user.id) || user.id === actorId) continue;
    void producers.projectInvitationEmail({
      project: record,
      manager: record.manager ? { name: fullName(record.manager) } : null,
      member: user,
      invitedBy,
    });
  }
}

const notifyMembers = (userIds: string[], projectId: string, projectName: string): ActivityEvent['notify'] =>
  userIds.map((userId) => ({
    userId,
    type: 'project.member_added',
    title: `You were added to project ${projectName}`,
    link: `/projects/${projectId}`,
  }));

export const projectService = {
  /** Cached per data scope. Mutations bump the namespace version. */
  async list(actor: AuthContext, query: ListProjectsQuery) {
    const scopeKey = actor.permissions.has('projects.view_all') ? 'all' : `u:${actor.id}`;
    return cache.remember<{ items: ProjectDto[]; meta: PaginationMeta }>('projects', scopeKey, query, async () => {
      const filters: Prisma.ProjectWhereInput = {};
      if (query.status) filters.status = query.status;
      if (query.priority) filters.priority = query.priority;
      if (query.managerId) filters.managerId = query.managerId;
      if (query.search) {
        filters.OR = [
          { name: { contains: query.search, mode: 'insensitive' } },
          { description: { contains: query.search, mode: 'insensitive' } },
        ];
      }
      const where: Prisma.ProjectWhereInput = { AND: [projectScope(actor), filters] };
      const orderBy: Prisma.ProjectOrderByWithRelationInput =
        query.sortBy === 'endDate' ? { endDate: { sort: query.sortOrder, nulls: 'last' } } : { [query.sortBy]: query.sortOrder };

      const [records, total] = await prisma.$transaction([
        prisma.project.findMany({ where, select: projectSelect, orderBy: [orderBy, { id: 'asc' }], ...skipTake(query.page, query.limit) }),
        prisma.project.count({ where }),
      ]);
      return { items: await toProjects(records), meta: buildMeta(query.page, query.limit, total) };
    });
  },

  async get(actor: AuthContext, id: string) {
    const [project] = await toProjects([await findScoped(actor, id)]);
    return project;
  },

  async create(ctx: RequestContext, input: CreateProjectInput) {
    const { actor } = ctx;
    const memberIds = new Set(input.memberIds.filter((m) => m !== input.managerId));
    // A creator without global scope would otherwise lose sight of their own project.
    if (!actor.permissions.has('projects.view_all') && input.managerId !== actor.id) memberIds.add(actor.id);

    await assertActiveUsers([input.managerId], 'managerId');
    await assertActiveUsers([...memberIds], 'memberIds');

    const record = await prisma.project.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        status: input.status,
        priority: input.priority,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        managerId: input.managerId,
        createdById: actor.id,
        members: { create: [...memberIds].map((userId) => ({ userId })) },
      },
      select: projectSelect,
    });

    await cache.invalidate('projects', 'dashboard');
    void activityService.record(ctx, {
      action: 'project.created',
      entity: 'project',
      entityId: record.id,
      description: `${fullName(actor)} created project ${record.name}`,
      metadata: { status: record.status, priority: record.priority, managerId: record.managerId, memberCount: memberIds.size },
      notify: [
        { userId: input.managerId, type: 'project.manager_assigned', title: `You now manage project ${record.name}`, link: `/projects/${record.id}` },
        ...(notifyMembers([...memberIds], record.id, record.name) ?? []),
      ],
    });
    mailInvitations(record, [...memberIds], fullName(actor), actor.id);
    const [project] = await toProjects([record]);
    return project;
  },

  async update(ctx: RequestContext, id: string, input: UpdateProjectInput) {
    const { actor } = ctx;
    const existing = await findScoped(actor, id);
    assertCanModify(actor, existing);

    const startDate = input.startDate ?? existing.startDate;
    const endDate = input.endDate === undefined ? existing.endDate : input.endDate;
    if (endDate && endDate < startDate) {
      throw new BadRequestError('End date must be on or after start date', 'VALIDATION_ERROR', [
        { path: 'endDate', message: 'End date must be on or after start date' },
      ]);
    }

    const managerId = input.managerId ?? existing.managerId;
    if (input.managerId && input.managerId !== existing.managerId) await assertActiveUsers([input.managerId], 'managerId');

    const currentMembers = new Set(existing.members.map((m) => m.user.id));
    let added: string[] = [];
    let removed: string[] = [];
    if (input.memberIds) {
      const next = new Set(input.memberIds.filter((m) => m !== managerId));
      added = [...next].filter((m) => !currentMembers.has(m));
      removed = [...currentMembers].filter((m) => !next.has(m));
      await assertActiveUsers(added, 'memberIds');
    }

    const record = await prisma.$transaction(async (tx) => {
      if (removed.length) await tx.projectMember.deleteMany({ where: { projectId: id, userId: { in: removed } } });
      if (added.length) await tx.projectMember.createMany({ data: added.map((userId) => ({ projectId: id, userId })), skipDuplicates: true });
      return tx.project.update({
        where: { id },
        data: {
          name: input.name,
          description: input.description,
          status: input.status,
          priority: input.priority,
          startDate: input.startDate,
          endDate: input.endDate,
          managerId: input.managerId,
        },
        select: projectSelect,
      });
    });

    await cache.invalidate('projects', 'dashboard');

    const actorName = fullName(actor);
    const changedFields = (Object.keys(input) as (keyof UpdateProjectInput)[]).filter((k) => k !== 'memberIds');
    if (input.status && input.status !== existing.status) {
      void activityService.record(ctx, {
        action: 'project.status_changed',
        entity: 'project',
        entityId: id,
        description: `${actorName} changed project ${record.name} status from ${STATUS_LABEL[existing.status]} to ${STATUS_LABEL[input.status]}`,
        metadata: { from: existing.status, to: input.status },
      });
    }
    const notify = [
      ...(notifyMembers(added, id, record.name) ?? []),
      ...(input.managerId && input.managerId !== existing.managerId
        ? [{ userId: input.managerId, type: 'project.manager_assigned', title: `You now manage project ${record.name}`, link: `/projects/${id}` }]
        : []),
    ];
    const otherFields = changedFields.filter((k) => k !== 'status');
    if (otherFields.length || added.length || removed.length) {
      void activityService.record(ctx, {
        action: 'project.updated',
        entity: 'project',
        entityId: id,
        description: `${actorName} updated project ${record.name}`,
        metadata: { fields: otherFields, membersAdded: added, membersRemoved: removed },
        notify,
      });
    }
    mailInvitations(record, added, actorName, actor.id);
    const [project] = await toProjects([record]);
    return project;
  },

  async remove(ctx: RequestContext, id: string) {
    const existing = await findScoped(ctx.actor, id);
    assertCanModify(ctx.actor, existing);

    const now = new Date();
    await prisma.$transaction([
      prisma.project.update({ where: { id }, data: { deletedAt: now } }),
      prisma.task.updateMany({ where: { projectId: id, deletedAt: null }, data: { deletedAt: now } }),
    ]);

    await cache.invalidate('projects', 'dashboard');
    void activityService.record(ctx, {
      action: 'project.deleted',
      entity: 'project',
      entityId: id,
      description: `${fullName(ctx.actor)} deleted project ${existing.name}`,
    });
  },
};
