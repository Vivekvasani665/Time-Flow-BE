import { Queue, type DefaultJobOptions } from 'bullmq';
import { getProducerConnection } from './connection';
import type { ActivityJobData, DeadLetterJobData, EmailJobData, InboxSyncJobData } from './job-types';

export const QUEUE_NAMES = {
  email: 'email',
  activity: 'activity',
  emailDeadLetter: 'email-dead-letter',
  inbox: 'inbox-sync',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const EMAIL_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 5,
  // 2s, 4s, 8s, 16s between attempts
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
};

export const ACTIVITY_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

let queues: {
  email: Queue<EmailJobData>;
  activity: Queue<ActivityJobData>;
  emailDeadLetter: Queue<DeadLetterJobData>;
  inbox: Queue<InboxSyncJobData>;
} | null = null;

export function getQueues() {
  if (!queues) {
    const connection = getProducerConnection();
    queues = {
      email: new Queue<EmailJobData>(QUEUE_NAMES.email, { connection, defaultJobOptions: EMAIL_JOB_OPTIONS }),
      activity: new Queue<ActivityJobData>(QUEUE_NAMES.activity, { connection, defaultJobOptions: ACTIVITY_JOB_OPTIONS }),
      emailDeadLetter: new Queue<DeadLetterJobData>(QUEUE_NAMES.emailDeadLetter, {
        connection,
        defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
      }),
      // A failed poll is simply retried on the next tick, so nothing is kept for long.
      inbox: new Queue<InboxSyncJobData>(QUEUE_NAMES.inbox, {
        connection,
        defaultJobOptions: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { age: 24 * 3600, count: 200 } },
      }),
    };
  }
  return queues;
}

export function getQueueByName(name: string): Queue | null {
  const all = getQueues();
  switch (name) {
    case QUEUE_NAMES.email:
      return all.email;
    case QUEUE_NAMES.activity:
      return all.activity;
    case QUEUE_NAMES.emailDeadLetter:
      return all.emailDeadLetter;
    case QUEUE_NAMES.inbox:
      return all.inbox;
    default:
      return null;
  }
}

export async function closeQueues(): Promise<void> {
  if (!queues) return;
  await Promise.allSettled(Object.values(queues).map((q) => q.close()));
  queues = null;
}
