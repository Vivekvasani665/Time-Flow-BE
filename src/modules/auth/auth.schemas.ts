import { z } from 'zod';
import { emailSchema, passwordSchema, trimmed } from '../../common/utils/validation';

/**
 * Mobile number in international form, country code included: `+919876543210`.
 * Spaces, dashes and brackets are dropped, so `+91 98765-43210` is accepted too.
 */
export const mobileSchema = z
  .string({ message: 'Mobile number is required' })
  .trim()
  .min(1, 'Mobile number is required')
  .transform((v) => v.replace(/[\s()-]/g, ''))
  .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, 'Enter the mobile number with its country code, e.g. +919876543210'));

/** Sign in with either the email or the mobile number on the account — exactly one of them. */
export const loginSchema = z
  .object({
    email: emailSchema.optional(),
    phone: mobileSchema.optional(),
    password: z.string({ message: 'Password is required' }).min(1, 'Password is required').max(128),
  })
  .strict()
  .refine((v) => (v.email === undefined) !== (v.phone === undefined), {
    message: 'Enter your email or mobile number',
    path: ['email'],
  });

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

/** `channel` is optional so existing clients keep working; `both` sends by email and SMS. */
export const resendLoginOtpSchema = z
  .object({
    verificationId: z.uuid({ message: 'Invalid verification id' }),
    channel: z.enum(['email', 'sms', 'both'], { message: 'Channel must be email, sms or both' }).default('both'),
  })
  .strict();

const challengeToken = z.string({ message: 'Challenge token is required' }).min(1, 'Challenge token is required').max(2048);
const password = z.string({ message: 'Password is required' }).min(1, 'Password is required').max(128);

/**
 * A WebAuthn response as `@simplewebauthn/browser` produces it. Only the shape
 * is checked here; the signature itself is verified by the passkey service.
 */
const webAuthnResponse = z
  .object({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal('public-key'),
    response: z.record(z.string(), z.unknown()),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
    authenticatorAttachment: z.string().max(32).optional(),
  })
  .loose();

/** Proof of the second factor: a code (authenticator or recovery) or a passkey — exactly one. */
const proofFields = { code: twoFactorCode.optional(), passkey: webAuthnResponse.optional() };
const oneProof = <T extends { code?: string; passkey?: unknown }>(v: T) => (v.code === undefined) !== (v.passkey === undefined);
const oneProofMessage = { message: 'Enter a code or use a passkey', path: ['code'] };

export const twoFactorCodeSchema = z.object({ code: twoFactorCode }).strict();

export const twoFactorProofSchema = z.object(proofFields).strict().refine(oneProof, oneProofMessage);

export const disableTwoFactorSchema = z
  .object({ password, ...proofFields })
  .strict()
  .refine(oneProof, oneProofMessage);

/** Adding or removing a sign-in method re-checks the password. */
export const passwordConfirmSchema = z.object({ password }).strict();

export const registerPasskeySchema = z
  .object({ response: webAuthnResponse, name: trimmed(1, 80, 'Passkey name').optional() })
  .strict();

export const passkeyLoginOptionsSchema = z.object({ challengeToken }).strict();

export const passkeyLoginSchema = z.object({ challengeToken, response: webAuthnResponse }).strict();

export const twoFactorSetupLoginSchema = z
  .object({
    challengeToken,
    code: z.string({ message: 'Code is required' }).trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app'),
  })
  .strict();

/** Public self-registration. Role and status are never client-controlled. */
export const registerSchema = z
  .object({
    firstName: trimmed(1, 80, 'First name'),
    lastName: trimmed(1, 80, 'Last name'),
    email: emailSchema,
    phone: mobileSchema,
    password: passwordSchema,
  })
  .strict();

const otpCode = z
  .string({ message: 'Code is required' })
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code');

export const verifySignupOtpSchema = z
  .object({ verificationId: z.uuid({ message: 'Invalid verification id' }), otp: otpCode })
  .strict();

/** `both` (the default) re-sends to email and SMS; the chart's two links send `email` or `sms`. */
export const resendSignupOtpSchema = z
  .object({
    verificationId: z.uuid({ message: 'Invalid verification id' }),
    channel: z.enum(['email', 'sms', 'both'], { message: 'Channel must be email, sms or both' }).default('both'),
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
