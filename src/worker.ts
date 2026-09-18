process.env.SERVICE_NAME ??= 'timeflow-worker';

import { Worker, type Job } from 'bullmq';
import { env, productionWarnings } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { createWorkerConnection, closeProducerConnection } from './queue/connection';
import { verifyTransport } from './queue/mailer';
import { closeQueues, getQueues, QUEUE_NAMES } from './queue/queues';
import { syncInbox } from './queue/inbound/inbox-sync';
import { handleEmailJobFailure, processEmailJob } from './queue/processors/email.processor';
import { processActivityJob } from './queue/processors/activity.processor';
import type { ActivityJobData, EmailJobData, InboxSyncJobData } from './queue/job-types';

const SHUTDOWN_TIMEOUT_MS = 25_000;

function attachLogging<T>(worker: Worker<T>, queue: string): void {
  worker.on('active', (job: Job<T>) => logger.info({ queue, jobId: job.id, name: job.name, attempt: job.attemptsMade + 1 }, 'job started'));
  worker.on('completed', (job: Job<T>, result: unknown) =>
    logger.info({ queue, jobId: job.id, name: job.name, attempt: job.attemptsMade, durationMs: (job.finishedOn ?? Date.now()) - (job.processedOn ?? Date.now()), result }, 'job completed'),
  );
  worker.on('stalled', (jobId: string) => logger.warn({ queue, jobId }, 'job stalled; will be reprocessed'));
  worker.on('error', (err) => logger.error({ queue, err }, 'worker error'));
}

async function main(): Promise<void> {
  for (const warning of productionWarnings()) logger.warn(warning);

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

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutting down; waiting for active jobs to finish');
    const force = setTimeout(() => {
      logger.error('worker shutdown timed out; forcing exit (unfinished jobs will be retried as stalled)');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();

    // Worker.close() stops fetching new jobs and waits for in-flight ones.
    await Promise.allSettled([emailWorker.close(), activityWorker.close(), inboxWorker.close()]);
    await closeQueues();
    await closeProducerConnection();
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
    logger.info('worker stopped cleanly');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
