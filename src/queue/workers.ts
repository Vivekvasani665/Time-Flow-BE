import { Worker, type Job } from 'bullmq';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { createWorkerConnection } from './connection';
import { verifyTransport } from './mailer';
import { getQueues, QUEUE_NAMES } from './queues';
import { syncInbox } from './inbound/inbox-sync';
import { handleEmailJobFailure, processEmailJob } from './processors/email.processor';
import { processActivityJob } from './processors/activity.processor';
import type { ActivityJobData, EmailJobData, InboxSyncJobData } from './job-types';

function attachLogging<T>(worker: Worker<T>, queue: string): void {
  worker.on('active', (job: Job<T>) => logger.info({ queue, jobId: job.id, name: job.name, attempt: job.attemptsMade + 1 }, 'job started'));
  worker.on('completed', (job: Job<T>, result: unknown) =>
    logger.info({ queue, jobId: job.id, name: job.name, attempt: job.attemptsMade, durationMs: (job.finishedOn ?? Date.now()) - (job.processedOn ?? Date.now()), result }, 'job completed'),
  );
  worker.on('stalled', (jobId: string) => logger.warn({ queue, jobId }, 'job stalled; will be reprocessed'));
  worker.on('error', (err) => logger.error({ queue, err }, 'worker error'));
}

/**
 * Starts the email, activity and inbox-sync consumers. Used by the standalone
 * worker process, and by the API itself when RUN_WORKER_IN_API is set — for
 * hosts where a separate worker service is not available (Render's free plan).
 * `close()` stops fetching new jobs and waits for the in-flight ones.
 */
export async function startWorkers(): Promise<{ close: () => Promise<void> }> {
  // Surface a broken mail setup at boot rather than one failed delivery at a
  // time. Deliberately not fatal: the activity queue must still run.
  void verifyTransport();

  const emailWorker = new Worker<EmailJobData>(QUEUE_NAMES.email, (job) => processEmailJob(job, logger.child({ jobId: job.id })), {
    connection: createWorkerConnection('email'),
    concurrency: env.WORKER_CONCURRENCY,
  });
  attachLogging(emailWorker, QUEUE_NAMES.email);
  emailWorker.on('failed', (job, err) => {
    if (!job) return;
    handleEmailJobFailure(job, err, logger).catch((e: unknown) => logger.error({ err: e, jobId: job.id }, 'failed to handle email job failure'));
  });

  const activityWorker = new Worker<ActivityJobData>(QUEUE_NAMES.activity, (job) => processActivityJob(job.data), {
    connection: createWorkerConnection('activity'),
    concurrency: env.WORKER_CONCURRENCY * 2,
  });
  attachLogging(activityWorker, QUEUE_NAMES.activity);
  activityWorker.on('failed', (job, err) =>
    logger.warn({ queue: QUEUE_NAMES.activity, jobId: job?.id, attemptsMade: job?.attemptsMade, err: err.message }, 'activity job failed'),
  );

  // Replies are pulled, not pushed: one poll at a time, on a fixed schedule.
  // The scheduler is keyed, so every worker replica upserts the same one.
  const inboxWorker = new Worker<InboxSyncJobData>(QUEUE_NAMES.inbox, (job) => syncInbox(logger.child({ jobId: job.id })), {
    connection: createWorkerConnection('inbox'),
    concurrency: 1,
  });
  inboxWorker.on('completed', (job, result) => {
    // A quiet poll every 30 seconds is noise; only log the ones that did something.
    if (job.data.reason === 'manual' || (result && 'imported' in result && result.imported > 0)) {
      logger.info({ queue: QUEUE_NAMES.inbox, jobId: job.id, result }, 'inbox sync completed');
    }
  });
  inboxWorker.on('failed', (job, err) =>
    logger.warn({ queue: QUEUE_NAMES.inbox, jobId: job?.id, err: err.message }, 'inbox sync failed; will try again on the next poll'),
  );
  inboxWorker.on('error', (err) => logger.error({ queue: QUEUE_NAMES.inbox, err }, 'worker error'));
  if (env.INBOUND_SYNC_ENABLED) {
    await getQueues().inbox.upsertJobScheduler(
      'inbox-poll',
      { every: env.INBOUND_POLL_SECONDS * 1000 },
      { name: 'sync', data: { reason: 'schedule' } },
    );
  } else {
    await getQueues().inbox.removeJobScheduler('inbox-poll');
  }

  logger.info(
    {
      queues: [QUEUE_NAMES.email, QUEUE_NAMES.activity, QUEUE_NAMES.inbox],
      concurrency: env.WORKER_CONCURRENCY,
      inboundPollSeconds: env.INBOUND_SYNC_ENABLED ? env.INBOUND_POLL_SECONDS : null,
    },
    'worker started',
  );

  return {
    close: async () => {
      await Promise.allSettled([emailWorker.close(), activityWorker.close(), inboxWorker.close()]);
    },
  };
}
