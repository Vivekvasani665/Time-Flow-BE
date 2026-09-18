import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { processActivityJob } from '../src/queue/processors/activity.processor';
import type { ActivityJobData } from '../src/queue/job-types';
import { userId } from './helpers';

const job = async (overrides: Partial<ActivityJobData> = {}): Promise<ActivityJobData> => ({
  id: randomUUID(),
  userId: await userId('manager@timeflow.dev'),
  action: 'task.assigned',
  entity: 'task',
  entityId: randomUUID(),
  description: 'Priya Nair assigned task X to Leo Park',
  metadata: { from: null, to: 'someone' },
  ipAddress: '127.0.0.1',
  userAgent: 'vitest',
  occurredAt: new Date().toISOString(),
  notify: [],
  ...overrides,
});

describe('activity processor', () => {
  it('persists the log, creates notifications for others and publishes them', async () => {
    const employeeId = await userId('employee@timeflow.dev');
    const publish = vi.spyOn(redis, 'publish');
    const data = await job({
      notify: [
        { userId: employeeId, type: 'task.assigned', title: 'Task assigned to you: X', link: '/tasks/1' },
        // The actor is never notified about their own action.
        { userId: await userId('manager@timeflow.dev'), type: 'task.assigned', title: 'self' },
      ],
    });

    const result = await processActivityJob(data);
    expect(result).toEqual({ created: true, notifications: 1 });

    const log = await prisma.activityLog.findUniqueOrThrow({ where: { id: data.id } });
    expect(log).toMatchObject({ action: 'task.assigned', entity: 'task', ipAddress: '127.0.0.1' });
    expect(await prisma.notification.count({ where: { userId: employeeId, title: 'Task assigned to you: X' } })).toBe(1);
    expect(publish).toHaveBeenCalledWith(`notifications:${employeeId}`, expect.stringContaining('Task assigned to you: X'));
    publish.mockRestore();
  });

  it('is idempotent when the same job is delivered twice', async () => {
    const data = await job();
    await processActivityJob(data);
    const again = await processActivityJob(data);
    expect(again).toEqual({ created: false, notifications: 0 });
    expect(await prisma.activityLog.count({ where: { id: data.id } })).toBe(1);
  });
});
