import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { env, productionWarnings } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { closeQueues } from './queue/queues';
import { closeProducerConnection } from './queue/connection';
import { notificationHub } from './modules/notifications/notification-stream';
import { createApp } from './app';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  for (const warning of productionWarnings()) logger.warn(warning);
  await prisma.$connect();
  const app = createApp();
  const server: Server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, `TimeFlow API listening on :${env.PORT}`);
  });

  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down API server');

    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();

    // 1. Stop accepting connections; close SSE streams so in-flight requests can drain.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    await notificationHub.close();
    server.closeIdleConnections();
    await closed;

    // 2. Release infrastructure.
    await closeQueues();
    await closeProducerConnection();
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
    for (const socket of sockets) socket.destroy();

    logger.info('API server stopped cleanly');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled promise rejection'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start API server');
  process.exit(1);
});
