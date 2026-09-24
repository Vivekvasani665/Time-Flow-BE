import { z } from 'zod';
import { listQuerySchema } from '../../common/http/pagination';
import { emailSchema, strongPasswordSchema, trimmed } from '../../common/utils/validation';

/** Only the email and role — the invitee supplies everything else when accepting. */
export const createInvitationSchema = z
  .object({
    email: emailSchema,
    roleId: z.uuid({ message: 'Role is required' }),
  })
  .strict();

export const listInvitationsQuerySchema = listQuerySchema(['createdAt', 'email', 'expiresAt'] as const, 'createdAt').extend({
  status: z.enum(['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED'], { message: 'Invalid status' }).optional(),
});

/** Raw tokens are 43 base64url characters; the bound only stops absurd input reaching the hash. */
const token = z.string({ message: 'Invitation token is required' }).trim().min(1, 'Invitation token is required').max(256, 'Invalid invitation token');

export const verifyInvitationQuerySchema = z.object({ token });

export const acceptInvitationSchema = z
  .object({
    token,
    /** Optional: the Set Password page may ask for a name. Otherwise it is derived from the email. */
    firstName: trimmed(1, 80, 'First name').optional(),
    lastName: trimmed(1, 80, 'Last name').optional(),
    password: strongPasswordSchema,
    confirmPassword: z.string({ message: 'Confirm your password' }).min(1, 'Confirm your password'),
  })
  .strict()
  .refine((v) => v.password === v.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' });

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type ListInvitationsQuery = z.infer<typeof listInvitationsQuerySchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
