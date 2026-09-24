import { z } from 'zod';
import { listQuerySchema } from '../../common/http/pagination';
import { emailSchema, passwordSchema, trimmed } from '../../common/utils/validation';

const status = z.enum(['ACTIVE', 'INACTIVE'], { message: 'Status must be ACTIVE or INACTIVE' });
/** PENDING (awaiting signup verification) can be filtered on, but only a signup OTP sets it. */
const listStatus = z.enum(['ACTIVE', 'INACTIVE', 'PENDING'], { message: 'Status must be ACTIVE, INACTIVE or PENDING' });

/** Stored in E.164 (+919876543210) so the number can receive SMS codes. Empty clears it. */
const phone = z
  .string()
  .trim()
  .max(32)
  .transform((v) => v.replace(/[\s().-]/g, ''))
  .pipe(z.string().regex(/^(\+[1-9]\d{7,14})?$/, 'Enter the mobile number with its country code, e.g. +919876543210'))
  .nullable()
  .transform((v) => (v ? v : null));

/** Only our own upload paths or https URLs — never `javascript:` / `data:` URIs. */
const avatarUrl = z
  .string()
  .trim()
  .max(500)
  .regex(/^(\/uploads\/avatars\/[\w.-]+|https:\/\/[^\s]+)?$/, 'Invalid profile image URL')
  .nullable()
  .transform((v) => (v ? v : null));

export const createUserSchema = z
  .object({
    firstName: trimmed(1, 80, 'First name'),
    lastName: trimmed(1, 80, 'Last name'),
    email: emailSchema,
    phone: phone.optional(),
    password: passwordSchema,
    roleId: z.uuid({ message: 'Role is required' }),
    status: status.default('ACTIVE'),
    avatarUrl: avatarUrl.optional(),
  })
  .strict();

export const updateUserSchema = z
  .object({
    firstName: trimmed(1, 80, 'First name'),
    lastName: trimmed(1, 80, 'Last name'),
    email: emailSchema,
    phone,
    password: passwordSchema,
    roleId: z.uuid({ message: 'Invalid role' }),
    status,
    avatarUrl,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export const updateUserStatusSchema = z.object({ status }).strict();

export const listUsersQuerySchema = listQuerySchema(
  ['createdAt', 'firstName', 'lastName', 'email', 'status', 'lastLoginAt'] as const,
  'createdAt',
).extend({
  status: listStatus.optional(),
  roleId: z.uuid().optional(),
});

export const userOptionsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
