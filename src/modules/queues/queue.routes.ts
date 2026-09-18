import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { JobType } from 'bullmq';
import { ConflictError, NotFoundError } from '../../common/errors';
import { ok } from '../../common/http/response';
import { authenticate, requirePermission } from '../../common/middleware/authenticate';
import { fullName, getRequestContext } from '../../common/utils/request-context';
import { getQueueByName, QUEUE_NAMES } from '../../queue/queues';
import { activityService } from '../activity-logs/activity.service';
import { P } from '../permissions/permission-catalog';

const STATES = ['waiting', 'active', 'completed', 'failed', 'delayed'] as const;

const jobsQuery = z.object({
  state: z.enum(STATES).default('failed'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const SENSITIVE_KEY = /password|token|secret/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v)]));
  }
  return value;
}

function queueOr404(name: string) {
  const queue = getQueueByName(name);
  if (!queue) throw new NotFoundError('Queue');
  return queue;
}

export const queueRouter = Router();
queueRouter.use(authenticate, requirePermission(P['queues.view']));

queueRouter.get('/', async (_req: Request, res: Response) => {
  const data = await Promise.all(
    Object.values(QUEUE_NAMES).map(async (name) => {
      const counts = await queueOr404(name).getJobCounts(...STATES);
      return { name, counts };
    }),
  );
  return ok(res, data);
});

queueRouter.get('/:name/jobs', async (req: Request, res: Response) => {
  const queue = queueOr404(String(req.params.name));
  const { state, limit } = jobsQuery.parse(req.query);
  const jobs = await queue.getJobs([state as JobType], 0, limit - 1, false);
  return ok(
    res,
    jobs.map((job) => ({
      id: job.id,
      name: job.name,
      data: redact(job.data),
      attemptsMade: job.attemptsMade,
      attempts: job.opts.attempts ?? 1,
      failedReason: job.failedReason ?? null,
      stacktrace: (job.stacktrace ?? []).slice(-1),
      timestamp: job.timestamp,
      processedOn: job.processedOn ?? null,
      finishedOn: job.finishedOn ?? null,
    })),
  );
});

queueRouter.post('/:name/jobs/:id/retry', requirePermission(P['queues.manage']), async (req: Request, res: Response) => {
  const name = String(req.params.name);
  const queue = queueOr404(name);
  const job = await queue.getJob(String(req.params.id));
  if (!job) throw new NotFoundError('Job');
  if (!(await job.isFailed())) throw new ConflictError('Only failed jobs can be retried');
  // A manual retry gets a fresh retry budget (full exponential backoff sequence).
  await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });

  const ctx = getRequestContext(req);
  void activityService.record(ctx, {
    action: 'queue.job_retried',
    entity: 'queue',
    entityId: job.id ?? null,
    description: `${fullName(ctx.actor)} retried ${name} job ${job.id}`,
    metadata: { queue: name, jobName: job.name },
  });
  return ok(res, { id: job.id }, 'Job re-queued');
});
