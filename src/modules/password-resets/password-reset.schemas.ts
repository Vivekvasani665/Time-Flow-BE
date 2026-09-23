import { z } from 'zod';
import { strongPasswordSchema } from '../../common/utils/validation';

export const userIdParam = z.object({ userId: z.uuid({ message: 'Invalid user id' }) });

/** Raw tokens are 43 base64url characters; the bound only stops absurd input reaching the hash. */
const token = z.string({ message: 'Reset token is required' }).trim().min(1, 'Reset token is required').max(256, 'Invalid reset token');

export const verifyTokenQuerySchema = z.object({ token });

export const completeResetSchema = z
  .object({
    token,
    newPassword: strongPasswordSchema,
    confirmPassword: z.string({ message: 'Confirm your new password' }).min(1, 'Confirm your new password'),
  })
  .strict()
  .refine((v) => v.newPassword === v.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' });

/** `?userIds=a,b,c` — the members on the page being shown. */
export const listLatestQuerySchema = z.object({
  userIds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []))
    .pipe(z.array(z.uuid({ message: 'Invalid user id' })).max(100, 'At most 100 user ids')),
});
