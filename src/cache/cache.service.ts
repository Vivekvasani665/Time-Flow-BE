import type Redis from 'ioredis';
import { env } from '../config/env';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import { stableHash } from '../common/utils/crypto';

/**
 * Cache namespaces. Each has a monotonically increasing version stored at
 * `cache:{ns}:v`. Keys embed the version, so invalidating a whole namespace is
 * a single O(1) INCR — no KEYS/SCAN — and stale entries simply age out via TTL.
 */
export type CacheNamespace = 'projects' | 'dashboard';

export type CacheResult<T> = { value: T; hit: boolean };

export class CacheService {
  constructor(
    private readonly client: Redis,
    private readonly defaultTtlSeconds: number,
  ) {}

  private versionKey(ns: CacheNamespace): string {
    return `cache:${ns}:v`;
  }

  async buildKey(ns: CacheNamespace, scope: string, params: unknown): Promise<string> {
    const version = (await this.client.get(this.versionKey(ns))) ?? '0';
    return `cache:${ns}:v${version}:${scope}:${stableHash(params)}`;
  }

  /**
   * Read-through cache. Redis failures degrade to a direct load rather than
   * failing the request — the cache is an optimisation, not a dependency.
   */
  async remember<T>(
    ns: CacheNamespace,
    scope: string,
    params: unknown,
    loader: () => Promise<T>,
    ttlSeconds = this.defaultTtlSeconds,
  ): Promise<CacheResult<T>> {
    let key: string | null = null;
    try {
      key = await this.buildKey(ns, scope, params);
      const cached = await this.client.get(key);
      if (cached !== null) return { value: JSON.parse(cached) as T, hit: true };
    } catch (err) {
      logger.warn({ err, ns }, 'cache read failed; falling back to loader');
    }

    const value = await loader();
    if (key) {
      this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds).catch((err: unknown) => {
        logger.warn({ err, ns }, 'cache write failed');
      });
    }
    return { value, hit: false };
  }

  /** Invalidate every key in the given namespaces. */
  async invalidate(...namespaces: CacheNamespace[]): Promise<void> {
    if (namespaces.length === 0) return;
    try {
      const pipeline = this.client.multi();
      for (const ns of new Set(namespaces)) pipeline.incr(this.versionKey(ns));
      await pipeline.exec();
    } catch (err) {
      logger.error({ err, namespaces }, 'cache invalidation failed');
    }
  }
}

export const cache = new CacheService(redis, env.CACHE_TTL_SECONDS);
