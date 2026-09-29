import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { prisma } from '../src/lib/prisma';
import { logger } from '../src/lib/logger';
import {
  BrevoProvider,
  parseAddress,
  PermanentMailError,
  ResendProvider,
  SendGridProvider,
  type OutgoingMail,
} from '../src/queue/mail-providers';
import * as mailer from '../src/queue/mailer';
import { processEmailJob } from '../src/queue/processors/email.processor';
import { closeQueues, getQueues } from '../src/queue/queues';
import { closeProducerConnection } from '../src/queue/connection';
import type { EmailJobData } from '../src/queue/job-types';
import type * as ProducersModule from '../src/queue/producers';

const mail: OutgoingMail = {
  from: 'TimeFlow <team@example.com>',
  to: ['client@gmail.com'],
  cc: ['pm@example.com'],
  bcc: ['audit@example.com'],
  subject: 'Project Update',
  html: '<p>Hello</p>',
  text: 'Hello',
  attachments: [{ filename: 'report.pdf', contentType: 'application/pdf', content: Buffer.from('PDF') }],
  messageId: '<abc@example.com>',
  inReplyTo: '<parent@example.com>',
};

function mockFetch(response: Response) {
  const fn = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

const sentBody = (fn: ReturnType<typeof vi.fn>) => JSON.parse((fn.mock.calls[0] as [string, RequestInit])[1].body as string);

afterEach(() => vi.unstubAllGlobals());

describe('mail providers', () => {
  it('parses display-name addresses', () => {
    expect(parseAddress('TimeFlow <team@example.com>')).toEqual({ name: 'TimeFlow', email: 'team@example.com' });
    expect(parseAddress('"Ops, Team" <ops@example.com>')).toEqual({ name: 'Ops, Team', email: 'ops@example.com' });
    expect(parseAddress('plain@example.com')).toEqual({ email: 'plain@example.com' });
  });

  it('sends through Resend with recipients, threading headers and base64 attachments', async () => {
    const fn = mockFetch(Response.json({ id: 're_123' }));
    const result = await new ResendProvider('re_key').sendEmail(mail);

    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_key');
    expect(sentBody(fn)).toMatchObject({
      from: 'TimeFlow <team@example.com>',
      to: ['client@gmail.com'],
      cc: ['pm@example.com'],
      bcc: ['audit@example.com'],
      headers: { 'Message-ID': '<abc@example.com>', 'In-Reply-To': '<parent@example.com>' },
      attachments: [{ filename: 'report.pdf', content: Buffer.from('PDF').toString('base64') }],
    });
    expect(result).toEqual({ messageId: '<abc@example.com>', providerMessageId: 're_123' });
  });

  it('sends through SendGrid, reading the id from the response header', async () => {
    const fn = mockFetch(new Response(null, { status: 202, headers: { 'X-Message-Id': 'sg_1' } }));
    const result = await new SendGridProvider('sg_key').sendEmail(mail);

    expect((fn.mock.calls[0] as [string])[0]).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(sentBody(fn)).toMatchObject({
      personalizations: [{ to: [{ email: 'client@gmail.com' }], cc: [{ email: 'pm@example.com' }], bcc: [{ email: 'audit@example.com' }] }],
      from: { name: 'TimeFlow', email: 'team@example.com' },
      content: [{ type: 'text/plain' }, { type: 'text/html' }],
    });
    expect(result.providerMessageId).toBe('sg_1');
  });

  it('sends through Brevo and keeps the Message-ID Brevo reports', async () => {
    const fn = mockFetch(Response.json({ messageId: '<brevo-1@smtp-relay.mailin.fr>' }));
    const result = await new BrevoProvider('xkeysib-1').sendEmail(mail);

    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect((init.headers as Record<string, string>)['api-key']).toBe('xkeysib-1');
    expect(sentBody(fn)).toMatchObject({ sender: { name: 'TimeFlow', email: 'team@example.com' }, attachment: [{ name: 'report.pdf' }] });
    expect(result.messageId).toBe('<brevo-1@smtp-relay.mailin.fr>');
  });

  it('treats a rejected request as permanent and a server error as retryable', async () => {
    mockFetch(new Response('invalid api key', { status: 401 }));
    await expect(new ResendProvider('bad').sendEmail(mail)).rejects.toBeInstanceOf(PermanentMailError);

    mockFetch(new Response('upstream down', { status: 503 }));
    const err = await new ResendProvider('k').sendEmail(mail).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentMailError);

    mockFetch(new Response('slow down', { status: 429 }));
    await expect(new ResendProvider('k').sendEmail(mail)).rejects.not.toBeInstanceOf(PermanentMailError);
  });
});

describe('draft → queue → delivery', () => {
  let employeeId: string;
  let producers: typeof ProducersModule.producers;

  beforeAll(async () => {
    employeeId = (await prisma.user.findFirstOrThrow({ where: { email: 'employee@timeflow.dev' }, select: { id: true } })).id;
    // tests/setup.ts mocks the producers for API tests; this suite needs the real ones.
    ({ producers } = await vi.importActual<typeof ProducersModule>('../src/queue/producers'));
  });

  afterAll(async () => {
    await closeQueues();
    await closeProducerConnection();
  });

  it('queues a draft exactly once, then delivers it with its cc, bcc and attachments', async () => {
    const draft = await prisma.emailLog.create({
      data: {
        status: 'DRAFT',
        template: 'message',
        fromAddress: '',
        fromUserId: employeeId,
        to: 'client@example.com',
        subject: 'Report',
        bodyText: 'See attached',
        attachments: {
          create: { uploadedById: employeeId, fileName: 'report.pdf', mimeType: 'application/pdf', size: 3, content: new Uint8Array(Buffer.from('PDF')) },
        },
      },
    });

    const input = {
      draftId: draft.id,
      from: { id: employeeId, name: 'Leo Park' },
      to: { id: null, email: 'client@example.com' },
      cc: ['pm@example.com'],
      bcc: ['audit@example.com'],
      subject: 'Report',
      body: 'See attached',
    };
    await producers.userMessage(input);
    // A second click on Send finds it already queued.
    await expect(producers.userMessage(input)).rejects.toMatchObject({ statusCode: 409 });

    const queued = await prisma.emailLog.findUniqueOrThrow({ where: { id: draft.id } });
    expect(queued).toMatchObject({ status: 'QUEUED', cc: ['pm@example.com'], bcc: ['audit@example.com'], fromAddress: expect.stringContaining('@') });
    expect(queued.bodyHtml).toContain('See attached');

    const spy = vi.spyOn(mailer, 'deliverMail');
    const job = (await getQueues().email.getJob(draft.id)) as Job<EmailJobData>;
    await processEmailJob(job, logger);
    await job.remove();

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'client@example.com',
        cc: ['pm@example.com'],
        bcc: ['audit@example.com'],
        attachments: [{ filename: 'report.pdf', contentType: 'application/pdf', content: Buffer.from('PDF') }],
      }),
      undefined,
      expect.objectContaining({ messageIdSeed: draft.id }),
    );
    const sent = await prisma.emailLog.findUniqueOrThrow({ where: { id: draft.id } });
    expect(sent).toMatchObject({ status: 'SENT', messageId: `<${draft.id}@timeflow.dev>`, providerMessageId: expect.any(String) });
    spy.mockRestore();
  });
});
