import type Redis from 'ioredis';
import { createRedisConnection } from '../lib/redis';

let producerConnection: Redis | null = null;

/**
 * Producers share one connection. `maxRetriesPerRequest: null` is required by
 * BullMQ; `enableOfflineQueue: false` makes `add()` fail fast when Redis is
 * down so callers can fall back instead of hanging a request.
 */
export function getProducerConnection(): Redis {
  producerConnection ??= createRedisConnection('bullmq-producer', {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });
  return producerConnection;
}

/** Workers each get their own blocking connection. */
export function createWorkerConnection(name: string): Redis {
  return createRedisConnection(`bullmq-worker-${name}`, { maxRetriesPerRequest: null });
}

export async function closeProducerConnection(): Promise<void> {
  if (producerConnection) {
    await producerConnection.quit().catch(() => undefined);
    producerConnection = null;
  }
}
