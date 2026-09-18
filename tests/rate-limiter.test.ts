import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { redis } from '../src/lib/redis';
import { SlidingWindowRateLimiter } from '../src/cache/rate-limiter';
import { csvCell } from '../src/modules/activity-logs/activity-log.service';
import { stableHash } from '../src/common/utils/crypto';

describe('SlidingWindowRateLimiter', () => {
  it('admits up to the limit, then rejects with a retry hint', async () => {
    const limiter = new SlidingWindowRateLimiter(redis, `test-${randomUUID()}`, 3, 1000);
    const t0 = 1_000_000;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.consume('ip', t0 + i * 10));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3]!.retryAfterMs).toBe(1000 - 30);
  });

  it('slides: capacity frees up as old requests leave the window', async () => {
    const limiter = new SlidingWindowRateLimiter(redis, `test-${randomUUID()}`, 2, 1000);
    const t0 = 5_000_000;
    await limiter.consume('ip', t0);
    await limiter.consume('ip', t0 + 500);
    expect((await limiter.consume('ip', t0 + 900)).allowed).toBe(false);
    // First request expired, second still counts → exactly one slot.
    expect((await limiter.consume('ip', t0 + 1001)).allowed).toBe(true);
    expect((await limiter.consume('ip', t0 + 1002)).allowed).toBe(false);
  });

  it('isolates identifiers', async () => {
    const limiter = new SlidingWindowRateLimiter(redis, `test-${randomUUID()}`, 1, 60_000);
    expect((await limiter.consume('a')).allowed).toBe(true);
    expect((await limiter.consume('b')).allowed).toBe(true);
    expect((await limiter.consume('a')).allowed).toBe(false);
  });
});

describe('utilities', () => {
  it('stableHash ignores key order and undefined values', () => {
    expect(stableHash({ a: 1, b: 'x', c: undefined })).toBe(stableHash({ b: 'x', a: 1 }));
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });

  it('csvCell escapes quotes and neutralises formula injection', () => {
    expect(csvCell('hello, "world"')).toBe('"hello, ""world"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell(null)).toBe('');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});
