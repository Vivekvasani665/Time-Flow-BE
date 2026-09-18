import { z } from 'zod';
import { listQuerySchema } from '../../common/http/pagination';
import { dateOnly, optionalText, trimmed } from '../../common/utils/validation';
import { priority } from '../projects/project.schemas';

export const taskStatus = z.enum(['TODO', 'IN_PROGRESS', 'REVIEW', 'COMPLETED']);

const base = {
  title: trimmed(2, 160, 'Title'),
  description: optionalText(10000),
  projectId: z.uuid({ message: 'Project is required' }),
  assigneeId: z.uuid({ message: 'Invalid assignee' }).nullable(),
  status: taskStatus,
  priority,
  dueDate: dateOnly.nullable(),
};

export const createTaskSchema = z
  .object({
    ...base,
    description: base.description.optional(),
    assigneeId: base.assigneeId.optional(),
    status: base.status.default('TODO'),
    priority: base.priority.default('MEDIUM'),
    dueDate: base.dueDate.optional(),
  })
  .strict();

export const updateTaskSchema = z
  .object(base)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export const listTasksQuerySchema = listQuerySchema(['createdAt', 'title', 'dueDate', 'priority', 'status'] as const, 'createdAt').extend({
  status: taskStatus.optional(),
  priority: priority.optional(),
  projectId: z.uuid().optional(),
  assigneeId: z.union([z.literal('me'), z.uuid()]).optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
