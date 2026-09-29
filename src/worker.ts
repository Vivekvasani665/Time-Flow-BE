process.env.SERVICE_NAME ??= 'timeflow-worker';

import { productionWarnings } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { closeProducerConnection } from './queue/connection';
import { closeQueues } from './queue/queues';
import { startWorkers } from './queue/workers';

const SHUTDOWN_TIMEOUT_MS = 25_000;

async function main(): Promise<void> {
  for (const warning of productionWarnings()) logger.warn(warning);
  const workers = await startWorkers();

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
    await workers.close();
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
