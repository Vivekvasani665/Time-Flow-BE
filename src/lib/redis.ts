import Redis, { type RedisOptions } from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

const baseOptions: RedisOptions = {
  lazyConnect: false,
  enableReadyCheck: true,
};

function create(name: string, options: RedisOptions = {}): Redis {
  const client = new Redis(env.REDIS_URL, { ...baseOptions, ...options, connectionName: `timeflow:${name}` });
  client.on('error', (err) => logger.error({ err, redis: name }, 'redis error'));
  return client;
}

/** General purpose client: cache, rate limiting, auth context, publishing. */
export const redis = create('main');

/**
 * Factory for BullMQ / pub-sub connections. BullMQ workers need
 * `maxRetriesPerRequest: null` because they use blocking commands.
 */
export function createRedisConnection(name: string, options: RedisOptions = {}): Redis {
  return create(name, options);
}
