import { z } from 'zod';

export const uuidParam = z.object({ id: z.uuid({ message: 'Invalid id' }) });

/** `YYYY-MM-DD` → Date at UTC midnight. */
export const dateOnly = z.iso.date({ message: 'Expected a date in YYYY-MM-DD format' }).transform((v) => new Date(`${v}T00:00:00.000Z`));

export const trimmed = (min: number, max: number, label: string) =>
  z
    .string({ message: `${label} is required` })
    .trim()
    .min(min, min <= 1 ? `${label} is required` : `${label} must be at least ${min} characters`)
    .max(max, `${label} must be at most ${max} characters`);

/**
 * Nullable free text; empty string is stored as null. Deliberately *not*
 * `.nullish()`: an absent key must stay absent so PATCH requests don't
 * clear fields they didn't mention. Add `.optional()` at the use site.
 */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be at most ${max} characters`)
    .nullable()
    .transform((v) => (v ? v : null));

export const passwordSchema = z
  .string({ message: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

export const emailSchema = z
  .string({ message: 'Email is required' })
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Invalid email address' }).max(254));

export const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');
