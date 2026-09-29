import type { Transporter } from 'nodemailer';

/**
 * The seam between "a message TimeFlow wants delivered" and whoever delivers it.
 * The rest of the app only ever sees `MailProvider`, so moving from Gmail SMTP
 * to Resend, SendGrid or Brevo is a change of EMAIL_PROVIDER, not of code.
 */

export type MailAttachment = { filename: string; content: Buffer; contentType: string };

export type OutgoingMail = {
  /** `Name <address>` or a bare address. */
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  attachments: MailAttachment[];
  /** Full `<id@domain>` form. Providers that honour it keep reply threading intact. */
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
};

export type SendResult = {
  /** RFC 5322 Message-ID — what a reply's In-Reply-To will point at. */
  messageId: string;
  /** The provider's own id for the message, for its dashboard / logs. */
  providerMessageId: string | null;
};

export interface MailProvider {
  readonly name: string;
  sendEmail(mail: OutgoingMail): Promise<SendResult>;
}

/**
 * The provider refused the message itself (bad API key, invalid sender, a
 * malformed request). Retrying sends the same request and gets the same answer.
 */
export class PermanentMailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentMailError';
  }
}

/** `TimeFlow <a@b.com>` → `{ name: 'TimeFlow', email: 'a@b.com' }`. */
export function parseAddress(value: string): { name?: string; email: string } {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (!match) return { email: value.trim() };
  const name = match[1]?.trim();
  return name ? { name, email: match[2]!.trim() } : { email: match[2]!.trim() };
}

function threadingHeaders(mail: OutgoingMail): Record<string, string> {
  return {
    ...(mail.messageId ? { 'Message-ID': mail.messageId } : {}),
    ...(mail.inReplyTo ? { 'In-Reply-To': mail.inReplyTo } : {}),
    ...(mail.references?.length ? { References: mail.references.join(' ') } : {}),
  };
}

/**
 * POSTs JSON and turns a failure into the right kind of error: 4xx other than
 * 408/429 is the request's fault and permanent; the rest are worth a retry.
 */
async function postJson(provider: string, url: string, headers: Record<string, string>, payload: unknown): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.ok) return res;

  const detail = (await res.text().catch(() => '')).slice(0, 300);
  const message = `${provider} rejected the message (HTTP ${res.status})${detail ? `: ${detail}` : ''}`;
  const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
  throw permanent ? new PermanentMailError(message) : new Error(message);
}

/** Wraps a nodemailer transport — Gmail, Mailpit, any SMTP relay, or log-only. */
export class SmtpProvider implements MailProvider {
  constructor(
    readonly name: string,
    private readonly transport: Transporter,
  ) {}

  async sendEmail(mail: OutgoingMail): Promise<SendResult> {
    const info = await this.transport.sendMail({
      from: mail.from,
      to: mail.to,
      ...(mail.cc.length ? { cc: mail.cc } : {}),
      ...(mail.bcc.length ? { bcc: mail.bcc } : {}),
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      // Copies: nodemailer rewrites attachment objects in place (Buffer → base64).
      ...(mail.attachments.length ? { attachments: mail.attachments.map((a) => ({ ...a })) } : {}),
      ...(mail.messageId ? { messageId: mail.messageId } : {}),
      ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
      ...(mail.references?.length ? { references: mail.references } : {}),
    });
    const messageId = String(info.messageId);
    return { messageId, providerMessageId: messageId };
  }
}

/** https://resend.com/docs/api-reference/emails/send-email */
export class ResendProvider implements MailProvider {
  readonly name = 'resend';
  constructor(private readonly apiKey: string) {}

  async sendEmail(mail: OutgoingMail): Promise<SendResult> {
    const res = await postJson('Resend', 'https://api.resend.com/emails', { Authorization: `Bearer ${this.apiKey}` }, {
      from: mail.from,
      to: mail.to,
      ...(mail.cc.length ? { cc: mail.cc } : {}),
      ...(mail.bcc.length ? { bcc: mail.bcc } : {}),
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      headers: threadingHeaders(mail),
      ...(mail.attachments.length
        ? { attachments: mail.attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64'), content_type: a.contentType })) }
        : {}),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { messageId: mail.messageId ?? `<${body.id ?? 'unknown'}@resend.dev>`, providerMessageId: body.id ?? null };
  }
}

/** https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send */
export class SendGridProvider implements MailProvider {
  readonly name = 'sendgrid';
  constructor(private readonly apiKey: string) {}

  async sendEmail(mail: OutgoingMail): Promise<SendResult> {
    const list = (addresses: string[]) => addresses.map((a) => parseAddress(a));
    const res = await postJson('SendGrid', 'https://api.sendgrid.com/v3/mail/send', { Authorization: `Bearer ${this.apiKey}` }, {
      personalizations: [
        {
          to: list(mail.to),
          ...(mail.cc.length ? { cc: list(mail.cc) } : {}),
          ...(mail.bcc.length ? { bcc: list(mail.bcc) } : {}),
        },
      ],
      from: parseAddress(mail.from),
      subject: mail.subject,
      // SendGrid requires text/plain before text/html.
      content: [
        { type: 'text/plain', value: mail.text },
        { type: 'text/html', value: mail.html },
      ],
      headers: threadingHeaders(mail),
      ...(mail.attachments.length
        ? {
            attachments: mail.attachments.map((a) => ({
              content: a.content.toString('base64'),
              filename: a.filename,
              type: a.contentType,
              disposition: 'attachment',
            })),
          }
        : {}),
    });
    // 202 with an empty body; the id comes back in a header.
    const id = res.headers.get('x-message-id');
    return { messageId: mail.messageId ?? `<${id ?? 'unknown'}@sendgrid.net>`, providerMessageId: id };
  }
}

/** https://developers.brevo.com/reference/sendtransacemail */
export class BrevoProvider implements MailProvider {
  readonly name = 'brevo';
  constructor(private readonly apiKey: string) {}

  async sendEmail(mail: OutgoingMail): Promise<SendResult> {
    const list = (addresses: string[]) => addresses.map((a) => parseAddress(a));
    const res = await postJson('Brevo', 'https://api.brevo.com/v3/smtp/email', { 'api-key': this.apiKey }, {
      sender: parseAddress(mail.from),
      to: list(mail.to),
      ...(mail.cc.length ? { cc: list(mail.cc) } : {}),
      ...(mail.bcc.length ? { bcc: list(mail.bcc) } : {}),
      subject: mail.subject,
      htmlContent: mail.html,
      textContent: mail.text,
      headers: threadingHeaders(mail),
      ...(mail.attachments.length
        ? { attachment: mail.attachments.map((a) => ({ name: a.filename, content: a.content.toString('base64') })) }
        : {}),
    });
    const body = (await res.json().catch(() => ({}))) as { messageId?: string };
    // Brevo answers with the Message-ID it actually stamped.
    return { messageId: body.messageId ?? mail.messageId ?? '<unknown@brevo>', providerMessageId: body.messageId ?? null };
  }
}
