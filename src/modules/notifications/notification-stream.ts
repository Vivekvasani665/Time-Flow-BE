import type { Response } from 'express';
import type Redis from 'ioredis';
import { createRedisConnection } from '../../lib/redis';
import { logger } from '../../lib/logger';
import { notificationChannel } from '../../queue/processors/activity.processor';

/**
 * Fans Redis pub/sub messages (published by the worker) out to connected
 * Server-Sent-Event clients. One shared subscriber connection per API process;
 * channels are subscribed on first listener and released on last disconnect,
 * so it scales horizontally — every replica receives every publish.
 */
class NotificationStreamHub {
  private subscriber: Redis | null = null;
  private readonly listeners = new Map<string, Set<Response>>();

  private getSubscriber(): Redis {
    if (!this.subscriber) {
      this.subscriber = createRedisConnection('notifications-sub');
      this.subscriber.on('message', (channel: string, message: string) => {
        const userId = channel.slice('notifications:'.length);
        for (const res of this.listeners.get(userId) ?? []) {
          res.write(`event: notification\ndata: ${message}\n\n`);
        }
      });
    }
    return this.subscriber;
  }

  async add(userId: string, res: Response): Promise<void> {
    let set = this.listeners.get(userId);
    if (!set) {
      set = new Set();
      this.listeners.set(userId, set);
      await this.getSubscriber().subscribe(notificationChannel(userId));
    }
    set.add(res);
  }

  async remove(userId: string, res: Response): Promise<void> {
    const set = this.listeners.get(userId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) {
      this.listeners.delete(userId);
      await this.subscriber?.unsubscribe(notificationChannel(userId)).catch((err: unknown) => logger.warn({ err }, 'unsubscribe failed'));
    }
  }

  async close(): Promise<void> {
    for (const set of this.listeners.values()) for (const res of set) res.end();
    this.listeners.clear();
    if (this.subscriber) await this.subscriber.quit().catch(() => undefined);
    this.subscriber = null;
  }
}

export const notificationHub = new NotificationStreamHub();
