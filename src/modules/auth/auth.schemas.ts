import { z } from 'zod';
import { emailSchema, passwordSchema, trimmed } from '../../common/utils/validation';

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string({ message: 'Password is required' }).min(1, 'Password is required').max(128),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;

/** A 6-digit authenticator code or a `xxxxx-xxxxx` recovery code. */
const twoFactorCode = z.string({ message: 'Code is required' }).trim().min(6, 'Code is required').max(32);

export const twoFactorLoginSchema = z
  .object({
    challengeToken: z.string({ message: 'Challenge token is required' }).min(1, 'Challenge token is required').max(2048),
    code: twoFactorCode,
  })
  .strict();

export const verifyLoginOtpSchema = z
  .object({
    verificationId: z.uuid({ message: 'Invalid verification id' }),
    otp: z
      .string({ message: 'Code is required' })
      .trim()
      .regex(/^\d{6}$/, 'Enter the 6-digit code'),
  })
  .strict();

export const resendLoginOtpSchema = z.object({ verificationId: z.uuid({ message: 'Invalid verification id' }) }).strict();

export const twoFactorCodeSchema = z.object({ code: twoFactorCode }).strict();

export const disableTwoFactorSchema = z
  .object({
    password: z.string({ message: 'Password is required' }).min(1, 'Password is required').max(128),
    code: twoFactorCode,
  })
  .strict();

/** Public self-registration. Role and status are never client-controlled. */
export const registerSchema = z
  .object({
    firstName: trimmed(1, 80, 'First name'),
    lastName: trimmed(1, 80, 'Last name'),
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * UI preferences, stored as a JSON bag on the user. Kept strict so a stray key
 * can never end up persisted, and every field optional on PATCH so the client
 * can send just what changed.
 */
const preferenceFields = z.object({
  theme: z.enum(['dark', 'light', 'system']),
  density: z.enum(['comfortable', 'compact']),
});

export const preferencesSchema = preferenceFields.strict();

export const updatePreferencesSchema = preferencesSchema.partial();

export type Preferences = z.infer<typeof preferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = { theme: 'light', density: 'comfortable' };

/**
 * Anything unrecognised in the stored JSON falls back to the default. Unknown keys
 * (e.g. the retired `accent`) are dropped rather than failing the whole bag, and
 * disappear from the database on the user's next save.
 */
export function withDefaults(stored: unknown): Preferences {
  const parsed = preferenceFields.partial().safeParse(stored);
  return { ...DEFAULT_PREFERENCES, ...(parsed.success ? parsed.data : {}) };
}
