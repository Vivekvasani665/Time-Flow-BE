import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { prisma } from '../src/lib/prisma';
import { logger } from '../src/lib/logger';
import { handleEmailJobFailure, processEmailJob } from '../src/queue/processors/email.processor';
import { closeQueues, EMAIL_JOB_OPTIONS, getQueues } from '../src/queue/queues';
import { closeProducerConnection } from '../src/queue/connection';
import type { EmailJobData } from '../src/queue/job-types';

/** A real user id, so the outbox row's recipient relation resolves. */
let EXISTING_USER_ID: string;
beforeAll(async () => {
  EXISTING_USER_ID = (await prisma.user.findFirstOrThrow({ where: { email: 'employee@timeflow.dev' }, select: { id: true } })).id;
});

afterAll(async () => {
  await closeQueues();
  await closeProducerConnection();
});

async function fakeJob(to: string, attemptsMade = 0): Promise<Job<EmailJobData>> {
  const log = await prisma.emailLog.create({
    data: { to, fromAddress: 'TimeFlow <no-reply@timeflow.dev>', subject: 'Welcome to TimeFlow', template: 'welcome' },
  });
  return {
    id: log.id,
    name: 'welcome',
    attemptsMade,
    opts: { attempts: EMAIL_JOB_OPTIONS.attempts },
    data: { emailLogId: log.id, template: 'welcome', to, variables: { firstName: 'Tess' } },
  } as unknown as Job<EmailJobData>;
}

describe('email processor', () => {
  it('uses exponential backoff with 5 attempts', () => {
    expect(EMAIL_JOB_OPTIONS).toMatchObject({ attempts: 5, backoff: { type: 'exponential', delay: 2000 } });
  });

  it('sends the email and marks the log SENT', async () => {
    const job = await fakeJob('tess@timeflow.dev');
    const result = await processEmailJob(job, logger);
    expect(result).toHaveProperty('messageId');
    expect(await prisma.emailLog.findUniqueOrThrow({ where: { id: job.id! } })).toMatchObject({ status: 'SENT', attempts: 1 });

    // A duplicate delivery of an already-sent email is a no-op.
    expect(await processEmailJob(job, logger)).toEqual({ skipped: true });
  });

  it('stamps a Message-ID derived from the row, so replies can be matched to it', async () => {
    const parent = await prisma.emailLog.create({
      data: {
        to: 'team@timeflow.dev',
        fromAddress: 'client@example.com',
        subject: 'Question',
        template: 'inbound',
        direction: 'INBOUND',
        status: 'SENT',
        messageId: `<${randomUUID()}@example.com>`,
      },
    });
    const job = await fakeJob('client@example.com');
    await prisma.emailLog.update({ where: { id: job.id! }, data: { replyToId: parent.id } });

    await processEmailJob(job, logger);
    const sent = await prisma.emailLog.findUniqueOrThrow({ where: { id: job.id! } });
    // .env.test pins the log transport, which sends as TimeFlow <no-reply@timeflow.dev>.
    expect(sent.messageId).toBe(`<${job.id}@timeflow.dev>`);
  });

  it('records the error and rethrows so BullMQ retries', async () => {
    const job = await fakeJob('tess+fail@timeflow.dev', 1);
    await expect(processEmailJob(job, logger)).rejects.toThrow(/simulated/);
    expect(await prisma.emailLog.findUniqueOrThrow({ where: { id: job.id! } })).toMatchObject({ status: 'QUEUED', attempts: 2, lastError: expect.stringMatching(/simulated/) });
  });

  it('does not dead-letter while retries remain', async () => {
    const job = await fakeJob('retry+fail@timeflow.dev', 2);
    await handleEmailJobFailure(job, new Error('boom'), logger);
    expect((await prisma.emailLog.findUniqueOrThrow({ where: { id: job.id! } })).status).toBe('QUEUED');
  });

  it('treats an unrecoverable failure as final, without waiting out the attempt count', async () => {
    // A blocked send is a configuration decision; retrying repeats the refusal.
    const job = await fakeJob('blocked+fail@timeflow.dev', 1);
    const err = new Error('Refusing to deliver: would reach real inboxes');
    err.name = 'UnrecoverableError';
    await handleEmailJobFailure(job, err, logger);
    expect((await prisma.emailLog.findUniqueOrThrow({ where: { id: job.id! } })).status).toBe('FAILED');
  });

  it('moves exhausted jobs to the dead-letter queue and marks the log FAILED', async () => {
    const job = await fakeJob('dead+fail@timeflow.dev', 5);
    await handleEmailJobFailure(job, new Error('SMTP down'), logger);
    expect((await prisma.emailLog.findUniqueOrThrow({ where: { id: job.id! } })).status).toBe('FAILED');
    const dlq = await getQueues().emailDeadLetter.getJob(`dlq-${job.id}-5`);
    expect(dlq?.data).toMatchObject({ sourceQueue: 'email', failedReason: 'SMTP down', attemptsMade: 5 });
  });
});

/** The real producers; tests/setup.ts replaces them with spies everywhere else. */
const realProducers = async () =>
  (await vi.importActual<typeof import('../src/queue/producers')>('../src/queue/producers')).producers;

describe('email producers', () => {
  it('writes a readable outbox row and enqueues delivery', async () => {
    const producers = await realProducers();
    const email = `${Date.now()}@timeflow.dev`;
    await producers.welcomeEmail({ id: EXISTING_USER_ID, email, firstName: 'Tess' });

    const log = await prisma.emailLog.findFirstOrThrow({ where: { to: email } });
    // Rendered at enqueue time, so the message is readable while still QUEUED.
    expect(log).toMatchObject({ status: 'QUEUED', template: 'welcome', subject: 'Welcome to TimeFlow', toUserId: EXISTING_USER_ID });
    expect(log.bodyHtml).toContain('Tess');
    expect(log.bodyText).toContain('Tess');
    expect(log.jobId).toBe(log.id);
    expect(await getQueues().email.getJob(log.id)).toBeDefined();
  });

  it('does not send the same task assignment twice', async () => {
    const producers = await realProducers();
    const assignee = { id: EXISTING_USER_ID, email: `dupe-${Date.now()}@timeflow.dev`, firstName: 'Tess' };
    const task = { id: randomUUID(), title: 'Ship it', description: null, dueDate: null, priority: 'HIGH' };

    await producers.taskAssignedEmail({ task, project: { name: 'Apollo' }, assignee, assignedBy: 'Ava' });
    await producers.taskAssignedEmail({ task, project: { name: 'Apollo' }, assignee, assignedBy: 'Ava' });

    expect(await prisma.emailLog.count({ where: { to: assignee.email } })).toBe(1);
  });
});
