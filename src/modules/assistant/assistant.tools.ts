import { z, type ZodType } from 'zod';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../common/errors';
import { fullName, type RequestContext } from '../../common/utils/request-context';
import { can } from '../permissions/rbac.service';
import { P } from '../permissions/permission-catalog';
import { listProjectsQuerySchema } from '../projects/project.schemas';
import { projectService } from '../projects/project.service';
import { createTaskSchema, listTasksQuerySchema, updateTaskSchema } from '../tasks/task.schemas';
import { taskService } from '../tasks/task.service';
import { dashboardService } from '../dashboard/dashboard.service';

/** Human wording for the "Looking up …" line while a tool runs. */
export const TOOL_STATUS: Record<string, string> = {
  list_tasks: 'Looking up tasks…',
  list_projects: 'Looking up projects…',
  list_project_members: 'Checking the team…',
  get_overview: 'Checking your dashboard…',
  create_tasks: 'Creating tasks…',
  assign_task: 'Assigning the task…',
};

/** Most tasks one request may create, so a misread "everyone" can't flood the board. */
export const MAX_TASKS_PER_REQUEST = 50;

/** A lookup or action the assistant can call. Provider-neutral: the service turns it into the model API's tool format. */
export type AssistantTool = {
  name: string;
  description: string;
  inputSchema: ZodType<Record<string, unknown>>;
  run: (input: never) => Promise<string>;
};

function tool<S extends ZodType<Record<string, unknown>>>(def: {
  name: string;
  description: string;
  inputSchema: S;
  run: (input: z.infer<S>) => Promise<string>;
}): AssistantTool {
  return def as AssistantTool;
}

const today = () => new Date().toISOString().slice(0, 10);
const day = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/** A service refusal (validation, permission, not found) becomes text the model can relay; anything else propagates. */
function refusal(err: unknown): string {
  if (!(err instanceof AppError)) throw err;
  return JSON.stringify({ error: err.message, details: err.details?.map((d) => d.message) });
}

/** The people a project's tasks can go to (manager and members), with their unfinished task count across all projects. */
async function teamWithWorkload(project: { manager: { id: string } | null; members: { id: string }[] }) {
  const ids = [...new Set([project.manager?.id, ...project.members.map((m) => m.id)].filter((id): id is string => !!id))];
  const [users, open] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids }, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, firstName: true, lastName: true, email: true },
    }),
    prisma.task.groupBy({
      by: ['assigneeId'],
      where: { assigneeId: { in: ids }, deletedAt: null, status: { not: 'COMPLETED' } },
      _count: { _all: true },
    }),
  ]);
  const load = new Map(open.map((g) => [g.assigneeId, g._count._all]));
  return users
    .map((u) => ({ id: u.id, name: fullName(u), email: u.email, openTasks: load.get(u.id) ?? 0 }))
    .sort((a, b) => a.openTasks - b.openTasks || a.name.localeCompare(b.name));
}

/**
 * Tools running as the signed-in user through the same services (and so the
 * same permission checks, row scoping, notifications and activity log) as the
 * REST API. The assistant can never see or change more than the user could
 * themselves.
 */
export function assistantTools(ctx: RequestContext): AssistantTool[] {
  const { actor } = ctx;
  const noAccess = (what: string) => JSON.stringify({ error: `You don't have permission to ${what}.` });

  const listTasks = tool({
    name: 'list_tasks',
    description:
      'List tasks the user can see. Use mine=true for "my tasks" (assigned to the user). Returns id, title, status, priority, due date, project, assignee and whether it is overdue.',
    inputSchema: z.object({
      mine: z.boolean().describe('Only tasks assigned to the user').optional(),
      status: z.enum(['TODO', 'IN_PROGRESS', 'REVIEW', 'COMPLETED']).optional(),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
      overdueOnly: z.boolean().describe('Only unfinished tasks whose due date has passed').optional(),
      search: z.string().max(100).describe('Text to find in the title or description').optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    run: async (input) => {
      if (!can(actor, P['tasks.view'])) return noAccess('view tasks');
      const limit = input.limit ?? 25;
      const { items, meta } = await taskService.list(
        actor,
        listTasksQuerySchema.parse({
          assigneeId: input.mine ? 'me' : undefined,
          status: input.status,
          priority: input.priority,
          search: input.search,
          sortBy: 'dueDate',
          sortOrder: 'asc',
          // Overdue is filtered below, so fetch a wider page for it.
          limit: input.overdueOnly ? 100 : limit,
        }),
      );
      const now = today();
      const tasks = items
        .map((t) => {
          const due = day(t.dueDate);
          return {
            id: t.id,
            title: t.title,
            status: t.status,
            priority: t.priority,
            dueDate: due,
            overdue: due !== null && due < now && t.status !== 'COMPLETED',
            project: t.project.name,
            assignee: t.assignee ? fullName(t.assignee) : null,
          };
        })
        .filter((t) => !input.overdueOnly || t.overdue)
        .slice(0, limit);
      return JSON.stringify({ today: now, total: input.overdueOnly ? tasks.length : meta.total, tasks });
    },
  });

  const listProjects = tool({
    name: 'list_projects',
    description: 'List projects the user can see, with id, status, priority, dates, manager, member count and task progress.',
    inputSchema: z.object({
      status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED']).optional(),
      search: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    run: async (input) => {
      if (!can(actor, P['projects.view'])) return noAccess('view projects');
      const {
        value: { items, meta },
      } = await projectService.list(
        actor,
        listProjectsQuerySchema.parse({ status: input.status, search: input.search, limit: input.limit ?? 25, sortBy: 'name', sortOrder: 'asc' }),
      );
      return JSON.stringify({
        total: meta.total,
        projects: items.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          priority: p.priority,
          startDate: day(p.startDate),
          endDate: day(p.endDate),
          manager: fullName(p.manager),
          members: p.members.length,
          tasksCompleted: p.taskStats.completed,
          tasksTotal: p.taskStats.total,
        })),
      });
    },
  });

  const listProjectMembers = tool({
    name: 'list_project_members',
    description:
      "The people a project's tasks can be assigned to (manager and members), with their user id and how many unfinished tasks each has across all projects, least busy first.",
    inputSchema: z.object({ projectId: z.uuid() }),
    run: async (input) => {
      if (!can(actor, P['projects.view'])) return noAccess('view projects');
      try {
        const project = await projectService.get(actor, input.projectId);
        return JSON.stringify({ project: project!.name, people: await teamWithWorkload(project!) });
      } catch (err) {
        return refusal(err);
      }
    },
  });

  const getOverview = tool({
    name: 'get_overview',
    description: "The user's dashboard numbers: project and task counts, tasks by status, and projects by status.",
    inputSchema: z.object({}),
    run: async () => {
      const { value } = await dashboardService.get(actor);
      return JSON.stringify({ today: today(), stats: value.stats, tasksByStatus: value.tasksByStatus, projectsByStatus: value.projectsByStatus });
    },
  });

  const createTasks = tool({
    name: 'create_tasks',
    description: [
      'Create a task in a project and assign it. assignTo decides who gets it:',
      '"auto" = the least busy project member; "all_members" = one copy of the task for every project member (manager included);',
      '"people" = one copy for each id in assigneeIds (ids from list_project_members); "nobody" = leave unassigned.',
      'Returns the created tasks.',
    ].join(' '),
    inputSchema: z.object({
      projectId: z.uuid(),
      title: z.string().min(2).max(160),
      description: z.string().max(10000).optional(),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
      dueDate: z.string().describe('YYYY-MM-DD').optional(),
      assignTo: z.enum(['auto', 'all_members', 'people', 'nobody']),
      assigneeIds: z.array(z.uuid()).max(MAX_TASKS_PER_REQUEST).optional(),
    }),
    run: async (input) => {
      if (!can(actor, P['tasks.create'])) return noAccess('create tasks');
      try {
        const project = await projectService.get(actor, input.projectId);
        const team = await teamWithWorkload(project!);
        let assignees: (string | null)[];
        if (input.assignTo === 'nobody') assignees = [null];
        else if (input.assignTo === 'auto') assignees = [team[0]?.id ?? null];
        else if (input.assignTo === 'all_members') assignees = team.map((p) => p.id);
        else assignees = [...new Set(input.assigneeIds ?? [])];
        if (assignees.length === 0) {
          return JSON.stringify({ error: input.assignTo === 'people' ? 'No assigneeIds were given.' : 'This project has no active members to assign to.' });
        }
        if (assignees.length > MAX_TASKS_PER_REQUEST) {
          return JSON.stringify({ error: `That would create ${assignees.length} tasks; the limit is ${MAX_TASKS_PER_REQUEST} at once.` });
        }

        const data = createTaskSchema.parse({
          projectId: input.projectId,
          title: input.title,
          description: input.description,
          priority: input.priority,
          dueDate: input.dueDate,
        });
        const created = [];
        const failed = [];
        for (const assigneeId of assignees) {
          try {
            const task = await taskService.create(ctx, { ...data, assigneeId });
            created.push({ id: task.id, title: task.title, assignee: task.assignee ? fullName(task.assignee) : null, dueDate: day(task.dueDate) });
          } catch (err) {
            failed.push({ assigneeId, ...JSON.parse(refusal(err)) });
          }
        }
        return JSON.stringify({ project: project!.name, created, failed });
      } catch (err) {
        if (err instanceof z.ZodError) return JSON.stringify({ error: 'Invalid task details', issues: err.issues.map((i) => i.message) });
        return refusal(err);
      }
    },
  });

  const assignTask = tool({
    name: 'assign_task',
    description:
      'Assign (or reassign) an existing task. Use a task id from list_tasks. assigneeId is a user id from list_project_members, "auto" for the least busy member of the task\'s project, or null to unassign.',
    inputSchema: z.object({
      taskId: z.uuid(),
      assigneeId: z.union([z.uuid(), z.literal('auto'), z.null()]),
    }),
    run: async (input) => {
      if (!can(actor, P['tasks.update'])) return noAccess('update tasks');
      try {
        let assigneeId = input.assigneeId;
        if (assigneeId === 'auto') {
          const task = await taskService.get(actor, input.taskId);
          const team = await teamWithWorkload(await projectService.get(actor, task.project.id).then((p) => p!));
          assigneeId = team.find((p) => p.id !== task.assignee?.id)?.id ?? null;
          if (!assigneeId) return JSON.stringify({ error: 'Nobody else in this project can take the task.' });
        }
        const task = await taskService.update(ctx, input.taskId, updateTaskSchema.parse({ assigneeId }));
        return JSON.stringify({ id: task.id, title: task.title, assignee: task.assignee ? fullName(task.assignee) : null });
      } catch (err) {
        return refusal(err);
      }
    },
  });

  return [listTasks, listProjects, listProjectMembers, getOverview, createTasks, assignTask];
}
