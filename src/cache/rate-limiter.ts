import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** ms until a slot frees up (0 when allowed) */
  retryAfterMs: number;
  /** ms until the window fully resets */
  resetMs: number;
};

/**
 * Sliding-window log limiter. Each request is a member of a sorted set scored
 * by its timestamp; the script trims entries older than the window, counts
 * the rest and admits the request only if under the limit. Running it as a
 * Lua script makes check-and-add atomic across API replicas.
 *
 * Rejected requests are not recorded, so a client that backs off regains
 * capacity as soon as the oldest admitted request leaves the window.
 */
const SLIDING_WINDOW_LUA = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, 0, window}
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry = window - (now - tonumber(oldest[2]))
if retry < 0 then retry = 0 end
return {0, 0, retry, retry}
`;

export class SlidingWindowRateLimiter {
  constructor(
    private readonly client: Redis,
    private readonly prefix: string,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  async consume(identifier: string, now = Date.now()): Promise<RateLimitDecision> {
    const key = `rl:${this.prefix}:${identifier}`;
    const result = (await this.client.eval(
      SLIDING_WINDOW_LUA,
      1,
      key,
      now,
      this.windowMs,
      this.limit,
      `${now}-${randomUUID()}`,
    )) as [number, number, number, number];

    const [allowed, remaining, retryAfterMs, resetMs] = result;
    return { allowed: allowed === 1, limit: this.limit, remaining, retryAfterMs, resetMs };
  }

  async reset(identifier: string): Promise<void> {
    await this.client.del(`rl:${this.prefix}:${identifier}`);
  }
}
