import { afterEach, describe, expect, it, vi } from 'vitest';

type SmtpOptions = { host?: string; port?: number; secure?: boolean; jsonTransport?: boolean; auth?: { user: string; pass: string } };

/**
 * `env` is parsed once at import, so each case re-imports the module graph with
 * a different environment rather than mutating a loaded config.
 */
async function loadMailer(vars: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  return import('../src/queue/mailer');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('mail transport selection', () => {
  it('falls back to log-only when nothing is configured', async () => {
    const { resolveEnvTransport } = await loadMailer({ EMAIL_PROVIDER: '', SMTP_HOST: '' });
    const t = resolveEnvTransport();
    expect(t).toMatchObject({ label: 'log-only', external: false });
    expect(t.options as SmtpOptions).toMatchObject({ jsonTransport: true });
  });

  it('uses an unauthenticated local relay for mailpit', async () => {
    const { resolveEnvTransport } = await loadMailer({ EMAIL_PROVIDER: 'mailpit', SMTP_HOST: 'localhost', SMTP_PORT: '1025' });
    const t = resolveEnvTransport();
    expect(t).toMatchObject({ label: 'mailpit', external: false });
    // Mailpit is an open relay and rejects an AUTH attempt.
    expect((t.options as SmtpOptions).auth).toBeUndefined();
    expect(t.options as SmtpOptions).toMatchObject({ host: 'localhost', port: 1025, secure: false });
  });

  it('builds a Gmail transport from the app password and sends as that account', async () => {
    const { resolveEnvTransport } = await loadMailer({
      EMAIL_PROVIDER: 'gmail',
      GMAIL_USER: 'ops@example.com',
      GMAIL_APP_PASSWORD: 'abcdefghijklmnop',
    });
    const t = resolveEnvTransport();
    expect(t).toMatchObject({ label: 'gmail', external: true, from: 'TimeFlow <ops@example.com>' });
    expect(t.options as SmtpOptions).toMatchObject({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: 'ops@example.com', pass: 'abcdefghijklmnop' },
    });
  });

  it('refuses to deliver to real inboxes outside production', async () => {
    const mailer = await loadMailer({
      EMAIL_PROVIDER: 'gmail',
      GMAIL_USER: 'ops@example.com',
      GMAIL_APP_PASSWORD: 'abcdefghijklmnop',
      EMAIL_ALLOW_REAL_SEND: 'false',
    });
    await expect(
      mailer.sendMail({ to: 'customer@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' }),
    ).rejects.toBeInstanceOf(mailer.BlockedMailError);

    const { prisma } = await import('../src/lib/prisma');
    await prisma.$disconnect();
  });

  it('reports the misconfiguration instead of pretending to verify', async () => {
    // A remote host with no credentials passes a socket check and then rejects
    // every send, so verify() must call it a failure.
    const { verifyTransport } = await loadMailer({ EMAIL_PROVIDER: 'gmail', GMAIL_USER: '', GMAIL_APP_PASSWORD: '', SMTP_USER: '', SMTP_PASS: '' });
    await expect(verifyTransport()).resolves.toBe(false);

    const { prisma } = await import('../src/lib/prisma');
    await prisma.$disconnect();
  });
});
