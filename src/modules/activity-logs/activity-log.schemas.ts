import { z } from 'zod';
import { listQuerySchema } from '../../common/http/pagination';

const filters = {
  entity: z.string().trim().max(40).regex(/^[a-z_]+$/).optional(),
  action: z.string().trim().max(60).regex(/^[a-z_.]+$/).optional(),
  userId: z.uuid().optional(),
  from: z.iso.date().or(z.iso.datetime()).optional(),
  to: z.iso.date().or(z.iso.datetime()).optional(),
};

export const listActivityQuerySchema = listQuerySchema(['createdAt', 'action', 'entity'] as const, 'createdAt').extend(filters);

export const exportActivityQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  ...filters,
});

export type ActivityFilters = z.infer<typeof exportActivityQuerySchema>;
export type ListActivityQuery = z.infer<typeof listActivityQuerySchema>;
