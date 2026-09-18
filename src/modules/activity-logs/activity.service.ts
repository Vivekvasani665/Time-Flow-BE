import { randomUUID } from 'node:crypto';
import { logger } from '../../lib/logger';
import { producers } from '../../queue/producers';
import { processActivityJob } from '../../queue/processors/activity.processor';
import type { ActivityJobData, NotificationInput } from '../../queue/job-types';
import type { RequestContext } from '../../common/utils/request-context';

export type ActivityEvent = {
  action: string;
  entity: string;
  entityId?: string | null;
  description: string;
  metadata?: Record<string, unknown>;
  notify?: NotificationInput[];
};

/** Minimal context for events without an authenticated actor (e.g. failed login). */
export type ActivityOrigin = Pick<RequestContext, 'ip' | 'userAgent'> & { actorId: string | null };

export function originOf(ctx: RequestContext): ActivityOrigin {
  return { actorId: ctx.actor.id, ip: ctx.ip, userAgent: ctx.userAgent };
}

export const activityService = {
  /**
   * Records an activity asynchronously via the `activity` queue.
   * Never throws and never blocks the request on the database write; if the
   * queue itself is unreachable we degrade to a direct write so the audit
   * trail is not lost.
   */
  async record(origin: ActivityOrigin | RequestContext, event: ActivityEvent): Promise<void> {
    const o = 'actor' in origin ? originOf(origin) : origin;
    const data: ActivityJobData = {
      id: randomUUID(),
      userId: o.actorId,
      action: event.action,
      entity: event.entity,
      entityId: event.entityId ?? null,
      description: event.description,
      metadata: event.metadata ?? {},
      ipAddress: o.ip,
      userAgent: o.userAgent,
      occurredAt: new Date().toISOString(),
      notify: event.notify ?? [],
    };

    try {
      await producers.activity(data);
    } catch (err) {
      logger.warn({ err, action: data.action }, 'activity queue unavailable; writing activity synchronously');
      await processActivityJob(data).catch((writeErr: unknown) =>
        logger.error({ err: writeErr, action: data.action }, 'failed to persist activity'),
      );
    }
  },
};
