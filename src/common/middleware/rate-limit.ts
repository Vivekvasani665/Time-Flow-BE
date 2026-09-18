import type { Request, RequestHandler } from 'express';
import { redis } from '../../lib/redis';
import { logger } from '../../lib/logger';
import { SlidingWindowRateLimiter } from '../../cache/rate-limiter';
import { RateLimitError } from '../errors';

type Options = {
  name: string;
  limit: number;
  windowSeconds: number;
  message?: string;
  /**
   * What to count per. Defaults to the client IP; an authenticated limiter
   * should key on the user instead, so one office NAT is not one bucket.
   */
  identify?: (req: Request) => string;
};

export function rateLimit({ name, limit, windowSeconds, message, identify }: Options): RequestHandler {
  const limiter = new SlidingWindowRateLimiter(redis, name, limit, windowSeconds * 1000);

  return async (req, res, next) => {
    const identifier = identify?.(req) ?? req.ip ?? 'unknown';
    let decision;
    try {
      decision = await limiter.consume(identifier);
    } catch (err) {
      // Fail open: a Redis outage must not take the whole API down.
      logger.error({ err, limiter: name }, 'rate limiter unavailable; allowing request');
      return next();
    }

    res.setHeader('RateLimit-Limit', decision.limit);
    res.setHeader('RateLimit-Remaining', decision.remaining);
    res.setHeader('RateLimit-Reset', Math.ceil(decision.resetMs / 1000));

    if (!decision.allowed) {
      const retryAfter = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      res.setHeader('Retry-After', retryAfter);
      logger.warn({ limiter: name, ip: identifier, route: req.originalUrl }, 'rate limit exceeded');
      return next(new RateLimitError(retryAfter, message));
    }
    return next();
  };
}
