import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

async function check(fn: () => Promise<unknown>): Promise<{ status: 'up' | 'down'; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    await withTimeout(fn(), 2000);
    return { status: 'up', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'down', latencyMs: Date.now() - start, error: err instanceof Error ? err.message : 'unknown' };
  }
}

export const healthRouter = Router();

/** Liveness: the process is running. Never touches dependencies. */
healthRouter.get('/live', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

/** Readiness: dependencies reachable — used by uptime checks / load balancers. */
healthRouter.get('/ready', async (_req, res) => {
  const [database, cache] = await Promise.all([check(() => prisma.$queryRaw`SELECT 1`), check(() => redis.ping())]);
  const ready = database.status === 'up' && cache.status === 'up';
  res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'degraded', checks: { database, redis: cache } });
});
