import { z } from 'zod';

export const sortOrderSchema = z.enum(['asc', 'desc']).default('desc');

/** Base list query: every list endpoint extends this with its own filters and `sortBy` enum. */
export function listQuerySchema<const S extends readonly [string, ...string[]]>(sortable: S, defaultSort: S[number]) {
  return z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    search: z
      .string()
      .trim()
      .max(100)
      .optional()
      .transform((v) => (v ? v : undefined)),
    sortBy: z.enum(sortable).default(defaultSort),
    sortOrder: sortOrderSchema,
  });
}

export function skipTake(page: number, limit: number): { skip: number; take: number } {
  return { skip: (page - 1) * limit, take: limit };
}
