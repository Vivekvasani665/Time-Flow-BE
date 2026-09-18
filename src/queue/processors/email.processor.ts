import { UnrecoverableError, type Job } from 'bullmq';
import { prisma } from '../../lib/prisma';
import type { Logger } from '../../lib/logger';
import { BlockedMailError, sendMail } from '../mailer';
import { renderEmail } from '../templates';
import { getQueues, QUEUE_NAMES } from '../queues';
import type { EmailJobData } from '../job-types';

export async function processEmailJob(job: Job<EmailJobData>, log: Logger): Promise<{ messageId: string } | { skipped: true }> {
  const { emailLogId, template, to, variables } = job.data;
  const attempt = job.attemptsMade + 1;

  const emailLog = await prisma.emailLog.findUnique({
    where: { id: emailLogId },
    select: { status: true, replyTo: { select: { messageId: true, inReplyTo: true } } },
  });
  if (emailLog?.status === 'SENT') {
    log.info({ jobId: job.id, emailLogId }, 'email already sent; skipping duplicate delivery');
    return { skipped: true };
  }

  await prisma.emailLog.updateMany({ where: { id: emailLogId }, data: { attempts: attempt } });

  try {
    // The Message-ID is derived from the row id, so every retry reuses it and a
    // reply can always be traced back here. Answering a received message carries
    // its ids forward, which keeps the conversation threaded in the other
    // person's mail client.
    const parent = emailLog?.replyTo;
    const messageId = await sendMail(renderEmail(template, to, variables), undefined, {
      messageIdSeed: emailLogId,
      ...(parent?.messageId ? { inReplyTo: parent.messageId } : {}),
      references: [parent?.inReplyTo, parent?.messageId].filter((id): id is string => Boolean(id)),
    });
    await prisma.emailLog.updateMany({
      where: { id: emailLogId },
      data: { status: 'SENT', sentAt: new Date(), lastError: null, messageId },
    });
    return { messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.emailLog.updateMany({ where: { id: emailLogId }, data: { lastError: message.slice(0, 1000) } });
    // A blocked send is a configuration decision, not a transient fault —
    // retrying it four more times would only repeat the same refusal.
    if (err instanceof BlockedMailError) throw new UnrecoverableError(message);
    throw err;
  }
}

/**
 * Called from the worker's `failed` event. Once retries are exhausted the job
 * is copied to the dead-letter queue for inspection / manual replay, and the
 * EmailLog is marked FAILED.
 */
export async function handleEmailJobFailure(job: Job<EmailJobData>, error: Error, log: Logger): Promise<void> {
  const maxAttempts = job.opts.attempts ?? 1;
  // An unrecoverable failure gets no further attempts, so it is finished now
  // even though the attempt counter has not reached the maximum.
  const exhausted = job.attemptsMade >= maxAttempts || error.name === 'UnrecoverableError';

  log.warn(
    { jobId: job.id, queue: QUEUE_NAMES.email, attemptsMade: job.attemptsMade, maxAttempts, exhausted, err: error.message },
    exhausted ? 'email job failed permanently' : 'email job failed; will retry with backoff',
  );
  if (!exhausted) return;

  await prisma.emailLog.updateMany({ where: { id: job.data.emailLogId }, data: { status: 'FAILED' } });
  await getQueues().emailDeadLetter.add(
    'dead-letter',
    {
      sourceQueue: QUEUE_NAMES.email,
      sourceJobId: job.id,
      name: job.name,
      data: job.data,
      failedReason: error.message,
      attemptsMade: job.attemptsMade,
      failedAt: new Date().toISOString(),
    },
    { jobId: `dlq-${job.id}-${job.attemptsMade}` },
  );
}
