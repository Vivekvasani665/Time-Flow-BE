import { z } from 'zod';
import { listQuerySchema } from '../../common/http/pagination';
import { dateOnly, optionalText, trimmed } from '../../common/utils/validation';

export const projectStatus = z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED']);
export const priority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

const memberIds = z
  .array(z.uuid({ message: 'Invalid member id' }))
  .max(200)
  .transform((ids) => [...new Set(ids)]);

const base = {
  name: trimmed(2, 120, 'Project name'),
  description: optionalText(5000),
  status: projectStatus,
  priority,
  startDate: dateOnly,
  endDate: dateOnly.nullable(),
  managerId: z.uuid({ message: 'Project manager is required' }),
  memberIds,
};

export const createProjectSchema = z
  .object({
    ...base,
    description: base.description.optional(),
    status: base.status.default('PLANNING'),
    priority: base.priority.default('MEDIUM'),
    endDate: base.endDate.optional(),
    memberIds: base.memberIds.default([]),
  })
  .strict()
  .refine((v) => !v.endDate || v.endDate >= v.startDate, { message: 'End date must be on or after start date', path: ['endDate'] });

export const updateProjectSchema = z
  .object(base)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export const listProjectsQuerySchema = listQuerySchema(
  ['createdAt', 'name', 'startDate', 'endDate', 'priority', 'status'] as const,
  'createdAt',
).extend({
  status: projectStatus.optional(),
  priority: priority.optional(),
  managerId: z.uuid().optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;
