import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  APP_URL: z.string().url().default('http://localhost:3000'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  COOKIE_SECURE: bool.default(false),
  /** Name shown next to the account in authenticator apps. */
  TOTP_ISSUER: z.string().min(1).default('TimeFlow'),
  /** How long a password-verified sign-in waits for its 2FA code. */
  TWO_FACTOR_CHALLENGE_TTL_MINUTES: z.coerce.number().int().positive().default(5),
  /** How long an administrator-issued password reset link stays usable. Links go to APP_URL/reset-password. */
  RESET_PASSWORD_TOKEN_EXPIRY_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),

  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_API_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_API_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  /** Composing mail emits real email from the org's identity, so it is held to
   *  a far tighter budget than a read — and counted per user, not per IP. */
  RATE_LIMIT_EMAIL_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_EMAIL_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

  /**
   * Chooses the outgoing transport explicitly, so moving between environments
   * is a config change rather than a code change:
   *   mailpit — local catcher, no auth (development)
   *   gmail   — smtp.gmail.com with GMAIL_USER + GMAIL_APP_PASSWORD (production)
   *   smtp    — any other provider, configured through the SMTP_* vars
   *   log     — serialise the message instead of sending it
   * Left unset, the transport is inferred from SMTP_HOST as it always was.
   */
  // Preprocessed so `EMAIL_PROVIDER=` (present but blank, as .env files often
  // leave it) means "unset" rather than failing validation at boot.
  EMAIL_PROVIDER: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['mailpit', 'gmail', 'smtp', 'log']).optional()),
  /**
   * Safety catch: outside production, a provider that reaches real inboxes is
   * refused unless this is explicitly set. Prevents a stray test run from
   * mailing actual customers.
   */
  EMAIL_ALLOW_REAL_SEND: bool.default(false),
  GMAIL_USER: z.string().optional().transform((v) => (v ? v : undefined)),
  /** 16-character Google App Password — never the account password. */
  GMAIL_APP_PASSWORD: z.string().optional().transform((v) => (v ? v : undefined)),

  SMTP_HOST: z.string().optional().transform((v) => (v ? v : undefined)),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  /** Implicit TLS — true for port 465, false for 587/25 which use STARTTLS. */
  SMTP_SECURE: bool.default(false),
  /** Credentials for a real provider. Leave both empty for an open relay like Mailpit. */
  SMTP_USER: z.string().optional().transform((v) => (v ? v : undefined)),
  SMTP_PASS: z.string().optional().transform((v) => (v ? v : undefined)),
  SMTP_FROM: z.string().default('TimeFlow <no-reply@timeflow.dev>'),
  EMAIL_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  /**
   * Pulls replies to TimeFlow's mail back into the app by reading the sending
   * account's inbox over IMAP. Only mail that answers a message TimeFlow sent is
   * imported; the rest of the inbox is never downloaded.
   */
  INBOUND_SYNC_ENABLED: bool.default(true),
  INBOUND_POLL_SECONDS: z.coerce.number().int().min(10).default(30),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),

  UPLOAD_DIR: z.string().default('./uploads'),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  // SMTP_PASSWORD is accepted as an alias, since many hosting guides use that name.
  const parsed = EnvSchema.safeParse({ ...process.env, SMTP_PASS: process.env.SMTP_PASS || process.env.SMTP_PASSWORD });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // Logger depends on env, so fail fast with plain stderr.
    process.stderr.write(`Invalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * Settings that boot fine but are unsafe on a public deployment. Reported
 * rather than fatal: the local pm2 deployment runs NODE_ENV=production over
 * plain http://localhost on purpose.
 */
export function productionWarnings(): string[] {
  if (!isProd) return [];
  const warnings: string[] = [];
  const local = /localhost|127\.0\.0\.1/;
  if (!env.COOKIE_SECURE) warnings.push('COOKIE_SECURE is false — auth cookies will be sent over plain HTTP. Set it to true behind HTTPS.');
  if (/dev-only|replace-with|change-me/i.test(env.JWT_ACCESS_SECRET)) warnings.push('JWT_ACCESS_SECRET is a placeholder — generate one with `openssl rand -base64 48`.');
  if (local.test(env.APP_URL)) warnings.push(`APP_URL is ${env.APP_URL} — links in emails will point at localhost.`);
  if (env.CORS_ORIGINS.some((o) => local.test(o))) warnings.push('CORS_ORIGINS still allows a localhost origin.');
  if (env.EMAIL_FAILURE_RATE > 0) warnings.push(`EMAIL_FAILURE_RATE is ${env.EMAIL_FAILURE_RATE} — real emails will be failed on purpose.`);
  return warnings;
}
