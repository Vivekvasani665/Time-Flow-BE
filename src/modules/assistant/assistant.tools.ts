import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { fullName } from '../../common/utils/request-context';
import type { AuthContext } from '../auth/auth.types';
import { can } from '../permissions/rbac.service';
import { P } from '../permissions/permission-catalog';
import { listProjectsQuerySchema } from '../projects/project.schemas';
import { projectService } from '../projects/project.service';
import { listTasksQuerySchema } from '../tasks/task.schemas';
import { taskService } from '../tasks/task.service';
import { dashboardService } from '../dashboard/dashboard.service';

/** Human wording for the "Looking up …" line while a tool runs. */
export const TOOL_STATUS: Record<string, string> = {
  list_tasks: 'Looking up tasks…',
  list_projects: 'Looking up projects…',
  get_overview: 'Checking your dashboard…',
};

const today = () => new Date().toISOString().slice(0, 10);
const day = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/**
 * Read-only tools, each running as the signed-in user through the same
 * services (and so the same permission checks and row scoping) as the REST
 * API. The assistant can never see more than the user could open themselves.
 */
export function assistantTools(actor: AuthContext) {
  const noAccess = (what: string) => JSON.stringify({ error: `You don't have permission to view ${what}.` });

  const listTasks = betaZodTool({
    name: 'list_tasks',
    description:
      'List tasks the user can see. Use mine=true for "my tasks" (assigned to the user). Returns title, status, priority, due date, project, assignee and whether it is overdue.',
    inputSchema: z.object({
      mine: z.boolean().describe('Only tasks assigned to the user').optional(),
      status: z.enum(['TODO', 'IN_PROGRESS', 'REVIEW', 'COMPLETED']).optional(),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
      overdueOnly: z.boolean().describe('Only unfinished tasks whose due date has passed').optional(),
      search: z.string().max(100).describe('Text to find in the title or description').optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    run: async (input) => {
      if (!can(actor, P['tasks.view'])) return noAccess('tasks');
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

  const listProjects = betaZodTool({
    name: 'list_projects',
    description: 'List projects the user can see, with status, priority, dates, manager, member count and task progress.',
    inputSchema: z.object({
      status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED']).optional(),
      search: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    run: async (input) => {
      if (!can(actor, P['projects.view'])) return noAccess('projects');
      const {
        value: { items, meta },
      } = await projectService.list(
        actor,
        listProjectsQuerySchema.parse({ status: input.status, search: input.search, limit: input.limit ?? 25, sortBy: 'name', sortOrder: 'asc' }),
      );
      return JSON.stringify({
        total: meta.total,
        projects: items.map((p) => ({
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

  const getOverview = betaZodTool({
    name: 'get_overview',
    description: "The user's dashboard numbers: project and task counts, tasks by status, and projects by status.",
    inputSchema: z.object({}),
    run: async () => {
      const { value } = await dashboardService.get(actor);
      return JSON.stringify({ today: today(), stats: value.stats, tasksByStatus: value.tasksByStatus, projectsByStatus: value.projectsByStatus });
    },
  });

  // Inputs stream as they're generated; betaZodTool validates each one against its schema before `run`.
  return [listTasks, listProjects, getOverview].map((tool) => ({ ...tool, eager_input_streaming: true }));
}
