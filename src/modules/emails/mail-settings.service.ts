import nodemailer from 'nodemailer';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { decryptSecret, encryptSecret } from '../../common/utils/crypto';
import { BadRequestError } from '../../common/errors/app-error';

/** Single row; the id is pinned so there can only ever be one. */
const ROW_ID = 1;

/** Presets so the UI asks for an account, not for SMTP trivia. */
export const MAIL_PROVIDERS = {
  gmail: { host: 'smtp.gmail.com', port: 587, secure: false, label: 'Gmail' },
} as const;

export type MailProvider = keyof typeof MAIL_PROVIDERS;

export type MailSettingsInput = {
  provider: MailProvider;
  username: string;
  /** Omitted on edit to keep the stored password. */
  password?: string;
  fromName: string;
  enabled: boolean;
};

/** Never includes the password — this shape is what the API returns. */
export type MailSettingsView = {
  configured: boolean;
  enabled: boolean;
  provider: MailProvider | 'custom';
  host: string | null;
  port: number | null;
  username: string | null;
  fromAddress: string | null;
  fromName: string | null;
  passwordSet: boolean;
  lastVerifiedAt: string | null;
  updatedAt: string | null;
};

const EMPTY: MailSettingsView = {
  configured: false,
  enabled: false,
  provider: 'gmail',
  host: null,
  port: null,
  username: null,
  fromAddress: null,
  fromName: null,
  passwordSet: false,
  lastVerifiedAt: null,
  updatedAt: null,
};

function toView(row: NonNullable<Awaited<ReturnType<typeof readRow>>>): MailSettingsView {
  const provider = (Object.entries(MAIL_PROVIDERS).find(([, p]) => p.host === row.host)?.[0] ?? 'custom') as MailProvider | 'custom';
  return {
    configured: true,
    enabled: row.enabled,
    provider,
    host: row.host,
    port: row.port,
    username: row.username,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    passwordSet: row.passwordEnc.length > 0,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function readRow() {
  return prisma.mailSettings.findUnique({ where: { id: ROW_ID } });
}

/** Builds a transport from a candidate config, without persisting anything. */
async function probe(host: string, port: number, secure: boolean, username: string, password: string) {
  const transport = nodemailer.createTransport({ host, port, secure, auth: { user: username, pass: password } });
  try {
    await transport.verify();
    return { ok: true as const };
  } catch (err) {
    const code = (err as { code?: string }).code;
    const raw = err instanceof Error ? err.message.split('\n')[0] : String(err);
    // Translate the two that actually happen into something actionable.
    const message =
      code === 'EAUTH'
        ? 'The server rejected these credentials. For Gmail this must be a 16-character App Password (not your normal password), issued for this exact account.'
        : code === 'ENOTFOUND' || code === 'ECONNECTION' || code === 'ETIMEDOUT'
          ? `Could not reach ${host}:${port}. Check your network and the port.`
          : raw;
    return { ok: false as const, code, message };
  } finally {
    transport.close();
  }
}

export const mailSettingsService = {
  async get(): Promise<MailSettingsView> {
    const row = await readRow();
    return row ? toView(row) : EMPTY;
  },

  /**
   * What the mailer needs to actually send. Returns null when nothing is
   * configured or it is switched off, so the caller falls back to env.
   */
  async getTransportConfig() {
    const row = await readRow();
    if (!row || !row.enabled) return null;
    const password = decryptSecret(row.passwordEnc);
    if (!password) {
      // Almost always means JWT_ACCESS_SECRET was rotated.
      logger.error('stored mail password could not be decrypted; re-enter it in System → Email delivery');
      return null;
    }
    return {
      host: row.host,
      port: row.port,
      secure: row.secure,
      auth: { user: row.username, pass: password },
      from: `${row.fromName} <${row.fromAddress}>`,
    };
  },

  /** Verifies before writing, so a bad password can never be saved. */
  async save(input: MailSettingsInput, actorId: string): Promise<MailSettingsView> {
    const preset = MAIL_PROVIDERS[input.provider];
    const existing = await readRow();

    const password = input.password ?? (existing ? decryptSecret(existing.passwordEnc) : null);
    if (!password) throw new BadRequestError('An app password is required.');

    const result = await probe(preset.host, preset.port, preset.secure, input.username, password);
    if (!result.ok) throw new BadRequestError(result.message);

    const data = {
      host: preset.host,
      port: preset.port,
      secure: preset.secure,
      username: input.username,
      passwordEnc: encryptSecret(password),
      // Gmail rewrites any other sender, so From must be the account itself.
      fromAddress: input.username,
      fromName: input.fromName,
      enabled: input.enabled,
      lastVerifiedAt: new Date(),
      updatedById: actorId,
    };
    const row = await prisma.mailSettings.upsert({ where: { id: ROW_ID }, create: { id: ROW_ID, ...data }, update: data });
    logger.info({ host: row.host, username: row.username, enabled: row.enabled }, 'mail settings saved');
    return toView(row);
  },

  /** Tests a candidate config, or the stored one when no password is supplied. */
  async test(input: { provider: MailProvider; username: string; password?: string }) {
    const preset = MAIL_PROVIDERS[input.provider];
    const existing = await readRow();
    const password = input.password ?? (existing ? decryptSecret(existing.passwordEnc) : null);
    if (!password) throw new BadRequestError('Enter an app password to test.');

    const result = await probe(preset.host, preset.port, preset.secure, input.username, password);
    if (result.ok && existing) {
      await prisma.mailSettings.update({ where: { id: ROW_ID }, data: { lastVerifiedAt: new Date() } });
    }
    return result;
  },

  async disable(actorId: string): Promise<MailSettingsView> {
    const row = await prisma.mailSettings.update({ where: { id: ROW_ID }, data: { enabled: false, updatedById: actorId } });
    return toView(row);
  },
};
