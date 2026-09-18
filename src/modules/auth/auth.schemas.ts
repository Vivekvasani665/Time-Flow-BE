import { z } from 'zod';
import { emailSchema } from '../../common/utils/validation';

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string({ message: 'Password is required' }).min(1, 'Password is required').max(128),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * UI preferences, stored as a JSON bag on the user. Kept strict so a stray key
 * can never end up persisted, and every field optional on PATCH so the client
 * can send just what changed.
 */
export const preferencesSchema = z
  .object({
    theme: z.enum(['dark', 'light', 'system']),
    accent: z.enum(['cyan', 'violet', 'magenta', 'lime', 'amber']),
    density: z.enum(['comfortable', 'compact']),
  })
  .strict();

export const updatePreferencesSchema = preferencesSchema.partial();

export type Preferences = z.infer<typeof preferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = { theme: 'light', accent: 'cyan', density: 'comfortable' };

/** Anything unrecognised in the stored JSON falls back to the default. */
export function withDefaults(stored: unknown): Preferences {
  const parsed = preferencesSchema.partial().safeParse(stored);
  return { ...DEFAULT_PREFERENCES, ...(parsed.success ? parsed.data : {}) };
}
