/**
 * `message` is a person-to-person mail composed in the app's Mailbox; the rest
 * are transactional, fired by a write elsewhere in the system.
 */
export type EmailTemplate = 'welcome' | 'message' | 'task_assigned' | 'task_status_changed' | 'project_invitation';

export type EmailJobData = {
  emailLogId: string;
  template: EmailTemplate;
  to: string;
  variables: Record<string, string>;
};

/** Polls the sending account's inbox for replies. `manual` is a user's "check now". */
export type InboxSyncJobData = { reason: 'schedule' | 'manual' };

export type DeadLetterJobData = {
  sourceQueue: string;
  sourceJobId: string | undefined;
  name: string;
  data: EmailJobData;
  failedReason: string;
  attemptsMade: number;
  failedAt: string;
};

export type NotificationInput = {
  userId: string;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
};

export type ActivityJobData = {
  /** Pre-generated ActivityLog id — makes the job idempotent across retries. */
  id: string;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  description: string;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  occurredAt: string;
  notify: NotificationInput[];
};
