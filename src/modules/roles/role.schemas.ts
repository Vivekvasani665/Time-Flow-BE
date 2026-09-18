import { z } from 'zod';
import { listQuerySchema } from '../../common/http/pagination';
import { optionalText, trimmed } from '../../common/utils/validation';

const permissionKeys = z
  .array(z.string().regex(/^[a-z_]+\.[a-z_]+$/, 'Invalid permission key'))
  .max(100)
  .transform((keys) => [...new Set(keys)]);

export const createRoleSchema = z
  .object({
    name: trimmed(2, 60, 'Role name'),
    description: optionalText(255).optional(),
    permissions: permissionKeys.default([]),
  })
  .strict();

export const updateRoleSchema = z
  .object({
    name: trimmed(2, 60, 'Role name'),
    description: optionalText(255),
    permissions: permissionKeys,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export const listRolesQuerySchema = listQuerySchema(['name', 'createdAt'] as const, 'createdAt');
export const roleUsersQuerySchema = listQuerySchema(['createdAt', 'firstName', 'email'] as const, 'createdAt');

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type ListRolesQuery = z.infer<typeof listRolesQuerySchema>;
export type RoleUsersQuery = z.infer<typeof roleUsersQuerySchema>;
