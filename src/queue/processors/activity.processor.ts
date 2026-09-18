import { Prisma, type Notification } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { cache } from '../../cache/cache.service';
import type { ActivityJobData } from '../job-types';

export const notificationChannel = (userId: string) => `notifications:${userId}`;

export type ActivityProcessResult = { created: boolean; notifications: number };

/**
 * Persists an activity record and fans out notifications.
 * Idempotent: the ActivityLog id is fixed by the producer, so a retry after a
 * partial failure (e.g. crash after commit) detects the existing row and skips.
 */
export async function processActivityJob(data: ActivityJobData): Promise<ActivityProcessResult> {
  const existing = await prisma.activityLog.findUnique({ where: { id: data.id }, select: { id: true } });
  if (existing) return { created: false, notifications: 0 };

  const recipients = data.notify.filter((n) => n.userId !== data.userId);

  let notifications: Notification[] = [];
  try {
    notifications = await prisma.$transaction(async (tx) => {
      await tx.activityLog.create({
        data: {
          id: data.id,
          userId: data.userId,
          action: data.action,
          entity: data.entity,
          entityId: data.entityId,
          description: data.description.slice(0, 500),
          metadata: data.metadata as Prisma.InputJsonObject,
          ipAddress: data.ipAddress,
          userAgent: data.userAgent,
          createdAt: new Date(data.occurredAt),
        },
      });
      if (recipients.length === 0) return [];
      return tx.notification.createManyAndReturn({
        data: recipients.map((n) => ({
          userId: n.userId,
          type: n.type,
          title: n.title.slice(0, 160),
          body: n.body?.slice(0, 500) ?? null,
          link: n.link ?? null,
          createdAt: new Date(data.occurredAt),
        })),
      });
    });
  } catch (err) {
    // Concurrent duplicate delivery — the other attempt won.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { created: false, notifications: 0 };
    }
    throw err;
  }

  // Recent-activity panel is cached; auth events aren't shown prominently enough to bust it.
  if (data.entity !== 'auth') await cache.invalidate('dashboard');
  await Promise.all(notifications.map((n) => redis.publish(notificationChannel(n.userId), JSON.stringify(n))));

  return { created: true, notifications: notifications.length };
}
