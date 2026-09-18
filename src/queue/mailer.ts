import nodemailer, { type Transporter } from 'nodemailer';
import { env, isProd } from '../config/env';
import { logger } from '../lib/logger';
import { mailSettingsService } from '../modules/emails/mail-settings.service';

export type MailMessage = { to: string; subject: string; html: string; text: string };

/** Threading headers, so a reply can be matched to — and shown under — its original. */
export type MailHeaders = {
  /** Local part of the Message-ID; the sender's domain is appended. */
  messageIdSeed?: string;
  inReplyTo?: string;
  references?: string[];
};

/** `<seed@domain-of-sender>` — a Message-ID on the sender's own domain looks least like spam. */
export function buildMessageId(seed: string, from: string): string {
  const domain = /@([^>\s]+)>?\s*$/.exec(from)?.[1] ?? 'timeflow.local';
  return `<${seed}@${domain}>`;
}

function headerOptions(from: string, headers: MailHeaders) {
  return {
    ...(headers.messageIdSeed ? { messageId: buildMessageId(headers.messageIdSeed, from) } : {}),
    ...(headers.inReplyTo ? { inReplyTo: headers.inReplyTo } : {}),
    ...(headers.references?.length ? { references: headers.references } : {}),
  };
}

export class SimulatedMailFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulatedMailFailure';
  }
}

/** Refused before it left the building — retrying would not change the outcome. */
export class BlockedMailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedMailError';
  }
}

type EnvTransport = {
  /** Which branch of the configuration produced this, for logs. */
  label: string;
  from: string;
  /** True when this transport can reach a real inbox outside the machine. */
  external: boolean;
  options: Parameters<typeof nodemailer.createTransport>[0];
};

/** A host that can only ever be a local catcher, never a real relay. */
const isLoopback = (host: string) => /^(127\.0\.0\.1|::1|localhost|mailpit)$/i.test(host);

/**
 * Turns EMAIL_PROVIDER into a concrete transport. Left unset, the provider is
 * inferred from SMTP_HOST exactly as before, so existing .env files keep working.
 */
export function resolveEnvTransport(): EnvTransport {
  const provider = env.EMAIL_PROVIDER ?? (env.SMTP_HOST ? 'smtp' : 'log');

  switch (provider) {
    case 'log':
      // No delivery at all: the message is serialised. Nodemailer still returns
      // a messageId, so a "completed" job here means nothing was sent.
      return { label: 'log-only', from: env.SMTP_FROM, external: false, options: { jsonTransport: true } };

    case 'mailpit':
      return {
        label: 'mailpit',
        from: env.SMTP_FROM,
        external: false,
        // Mailpit is an open relay and rejects an AUTH attempt, so never authenticate.
        options: { host: env.SMTP_HOST ?? 'localhost', port: env.SMTP_PORT, secure: false },
      };

    case 'gmail': {
      // GMAIL_* are the documented names; fall back to SMTP_* so an existing
      // Gmail-over-SMTP setup does not have to be renamed.
      const user = env.GMAIL_USER ?? env.SMTP_USER;
      const pass = env.GMAIL_APP_PASSWORD ?? env.SMTP_PASS;
      return {
        label: 'gmail',
        // Gmail rewrites any other sender, so From must be the account itself.
        from: user ? `TimeFlow <${user}>` : env.SMTP_FROM,
        external: true,
        options: {
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          ...(user && pass ? { auth: { user, pass } } : {}),
        },
      };
    }

    case 'smtp':
    default:
      return {
        label: 'smtp',
        from: env.SMTP_FROM,
        external: !env.SMTP_HOST || !isLoopback(env.SMTP_HOST),
        options: {
          host: env.SMTP_HOST ?? 'localhost',
          port: env.SMTP_PORT,
          secure: env.SMTP_SECURE,
          ...(env.SMTP_USER && env.SMTP_PASS ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } } : {}),
        },
      };
  }
}

/**
 * Outside production, a transport that reaches real inboxes is refused unless
 * EMAIL_ALLOW_REAL_SEND is set — so pointing a dev machine at the production
 * Gmail account cannot mail actual customers.
 */
function blockedReason(transport: EnvTransport): string | null {
  if (!transport.external || isProd || env.EMAIL_ALLOW_REAL_SEND) return null;
  return `Refusing to deliver: NODE_ENV=${env.NODE_ENV} with the "${transport.label}" provider would reach real inboxes. Use EMAIL_PROVIDER=mailpit locally, or set EMAIL_ALLOW_REAL_SEND=true to send for real.`;
}

let transporter: Transporter | null = null;

/** Cached DB transport, keyed so a settings change rebuilds it automatically. */
let configuredTransport: { key: string; transport: Transporter; from: string } | null = null;

async function getConfiguredTransport(): Promise<{ transport: Transporter; from: string } | null> {
  const config = await mailSettingsService.getTransportConfig().catch((err: unknown) => {
    logger.error({ err }, 'could not read mail settings; falling back to environment configuration');
    return null;
  });
  if (!config) {
    configuredTransport = null;
    return null;
  }
  const { from, ...options } = config;
  const key = `${options.host}:${options.port}:${options.secure}:${options.auth.user}:${options.auth.pass.length}:${from}`;
  if (configuredTransport?.key !== key) {
    configuredTransport?.transport.close();
    configuredTransport = { key, transport: nodemailer.createTransport(options), from };
    logger.info({ host: options.host, port: options.port, user: options.auth.user }, 'using mail account configured in the app');
  }
  return { transport: configuredTransport.transport, from: configuredTransport.from };
}

function getTransporter(resolved: EnvTransport): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport(resolved.options);
    if (resolved.label === 'log-only') {
      logger.warn('no mail provider configured — mail is logged, not delivered');
    } else {
      const opts = resolved.options as { host?: string; port?: number; secure?: boolean; auth?: unknown };
      logger.info(
        { provider: resolved.label, host: opts.host, port: opts.port, secure: opts.secure, authenticated: Boolean(opts.auth) },
        'SMTP transport ready',
      );
    }
  }
  return transporter;
}

/**
 * Proves the SMTP settings actually work, instead of finding out one failed
 * delivery at a time. Called once on worker boot; never throws, and never logs
 * the password — only whether each credential is present.
 */
export async function verifyTransport(): Promise<boolean> {
  const configured = await getConfiguredTransport();
  if (configured) {
    try {
      await configured.transport.verify();
      logger.info({ source: 'app settings', from: configured.from }, 'SMTP connection successful');
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
      logger.error({ source: 'app settings', reason: message }, 'SMTP connection failed — re-check the account in System → Email delivery');
      return false;
    }
  }

  const resolved = resolveEnvTransport();
  if (resolved.label === 'log-only') {
    logger.warn(
      { provider: resolved.label },
      'no mail provider configured (EMAIL_PROVIDER and SMTP_HOST are both unset) — mail will be logged, not delivered. Nodemailer still returns a messageId, so jobs will look successful.',
    );
    return false;
  }

  const blocked = blockedReason(resolved);
  if (blocked) {
    logger.warn({ provider: resolved.label, nodeEnv: env.NODE_ENV }, blocked);
    return false;
  }

  const opts = resolved.options as { host: string; port: number; secure?: boolean; auth?: { user: string; pass: string } };
  const context = {
    provider: resolved.label,
    smtpHost: opts.host,
    smtpPort: opts.port,
    secure: Boolean(opts.secure),
    smtpUserSet: Boolean(opts.auth?.user),
    smtpPassSet: Boolean(opts.auth?.pass),
  };

  // verify() only proves the socket and greeting work. With no `auth` block it
  // never authenticates, so a remote relay happily passes here and then rejects
  // every actual send. Treat "remote host, no credentials" as a failure.
  if (resolved.external && !opts.auth) {
    logger.error(
      context,
      `SMTP connection failed — ${opts.host} is a remote server but no credentials are set, so every send will be rejected. For Gmail, set GMAIL_USER to the account and GMAIL_APP_PASSWORD to a 16-character App Password.`,
    );
    return false;
  }

  try {
    await getTransporter(resolved).verify();
    logger.info(context, 'SMTP connection successful');
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    logger.error({ ...context, code, reason: message }, 'SMTP connection failed — outgoing mail will not be delivered');

    // The two that actually happen in practice, with the fix rather than the symptom.
    if (code === 'EAUTH') {
      logger.error(
        context.smtpUserSet
          ? 'SMTP rejected the credentials. For Gmail this must be a 16-character App Password (not the account password), issued for the exact account in GMAIL_USER.'
          : 'No SMTP credentials are set. A real provider needs both a username and a password; only a local catcher such as Mailpit accepts unauthenticated mail.',
      );
    } else if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') {
      logger.error(`Could not reach ${opts.host}:${opts.port}. Check the host, the port, and that the service is running.`);
    }
    return false;
  }
}

export type MailerOptions = { failureRate?: number; random?: () => number };

export async function sendMail(message: MailMessage, options: MailerOptions = {}, headers: MailHeaders = {}): Promise<string> {
  const failureRate = options.failureRate ?? env.EMAIL_FAILURE_RATE;
  const random = options.random ?? Math.random;

  // An account configured in the UI wins over the SMTP_* env vars.
  const configured = await getConfiguredTransport();

  // Demo hooks for retry / backoff / dead-letter behaviour. Kept out of
  // production: a real recipient using a plus-address such as
  // alice+failover@example.com would otherwise be undeliverable.
  if (!isProd && message.to.includes('+fail')) throw new SimulatedMailFailure(`SMTP rejected recipient ${message.to} (simulated)`);
  if (failureRate > 0 && random() < failureRate) throw new SimulatedMailFailure('SMTP connection reset (simulated)');

  if (configured) {
    // A UI-configured account is always a real provider, so it is subject to
    // the same non-production guard as EMAIL_PROVIDER=gmail.
    const blocked = blockedReason({ label: 'app settings', from: configured.from, external: true, options: {} });
    if (blocked) throw new BlockedMailError(blocked);
    const info = await configured.transport.sendMail({ from: configured.from, ...message, ...headerOptions(configured.from, headers) });
    return String(info.messageId);
  }

  const resolved = resolveEnvTransport();
  const blocked = blockedReason(resolved);
  if (blocked) throw new BlockedMailError(blocked);

  const info = await getTransporter(resolved).sendMail({ from: resolved.from, ...message, ...headerOptions(resolved.from, headers) });
  if (resolved.label === 'log-only') logger.info({ to: message.to, subject: message.subject }, 'email logged (no mail provider configured)');
  return String(info.messageId);
}
