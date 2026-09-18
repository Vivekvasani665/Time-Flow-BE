import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { getQueues } from './queues';
import { renderEmail } from './templates';
import type { ActivityJobData, EmailTemplate } from './job-types';

type EnqueueInput = {
  template: EmailTemplate;
  /** `id` is null for an address that belongs to no app user — SMTP only. */
  to: { id: string | null; email: string };
  /** Whoever triggered the send; owns the row in their Sent folder. */
  fromUserId?: string | null;
  variables: Record<string, string>;
  /**
   * Stable id for a trigger that can legitimately replay (a retried API call,
   * a double-submit), so the same event reuses one job instead of sending twice.
   */
  jobId?: string;
  replyToId?: string | null;
};

/**
 * Writes the outbox row, then enqueues delivery.
 *
 * The body is rendered here rather than in the processor so the message is
 * readable in the mailbox while still QUEUED — or after it has FAILED. Throws
 * if the job cannot be queued; `enqueueQuietly` is the non-throwing variant.
 */
async function enqueue(input: EnqueueInput): Promise<{ id: string }> {
  const queue = getQueues().email;

  // Checked before the row is written, so a duplicate trigger leaves no trace.
  if (input.jobId && (await queue.getJob(input.jobId))) {
    logger.info({ jobId: input.jobId, template: input.template }, 'email already queued; skipping duplicate');
    const existing = await prisma.emailLog.findFirst({ where: { jobId: input.jobId }, select: { id: true } });
    if (existing) return existing;
  }

  const rendered = renderEmail(input.template, input.to.email, input.variables);
  const log = await prisma.emailLog.create({
    data: {
      to: input.to.email,
      fromAddress: env.SMTP_FROM,
      subject: rendered.subject,
      template: input.template,
      bodyHtml: rendered.html,
      bodyText: rendered.text,
      toUserId: input.to.id,
      fromUserId: input.fromUserId ?? null,
      replyToId: input.replyToId ?? null,
    },
    select: { id: true },
  });

  let job;
  try {
    job = await queue.add(
      input.template,
      { emailLogId: log.id, template: input.template, to: input.to.email, variables: input.variables },
      { jobId: input.jobId ?? log.id },
    );
  } catch (err) {
    // The outbox row is already committed. Without this it would sit QUEUED
    // forever with no job behind it — invisible to retries and inflating the
    // System Monitor's queued counter.
    await prisma.emailLog
      .update({ where: { id: log.id }, data: { status: 'FAILED', lastError: 'Could not be queued for delivery' } })
      .catch(() => undefined);
    throw err;
  }

  // Delivery is queued at this point. Storing the job id is bookkeeping for the
  // System Monitor, so a failure here must not mark a live send as failed.
  await prisma.emailLog
    .update({ where: { id: log.id }, data: { jobId: job.id ?? null } })
    .catch((err: unknown) => logger.warn({ err, jobId: job?.id, emailLogId: log.id }, 'could not record the job id against the outbox row'));

  logger.info({ jobId: job.id, queue: 'email', template: input.template, toUserId: input.to.id }, 'email enqueued');
  return log;
}

/** For transactional mail: a mail problem must never fail a write that committed. */
async function enqueueQuietly(input: EnqueueInput, context: Record<string, unknown>): Promise<void> {
  try {
    await enqueue(input);
  } catch (err) {
    logger.error({ err, template: input.template, ...context }, 'failed to enqueue email');
  }
}

/**
 * Producers. Every call happens *after* the triggering DB transaction commits,
 * so a worker never picks up a job for data that was rolled back.
 */
export const producers = {
  async welcomeEmail(user: { id: string; email: string; firstName: string }, actorId?: string | null): Promise<void> {
    await enqueueQuietly(
      {
        template: 'welcome',
        to: { id: user.id, email: user.email },
        fromUserId: actorId ?? null,
        variables: { firstName: user.firstName },
      },
      { userId: user.id },
    );
  },

  /**
   * A message one user composed for another in the Mailbox. Unlike the
   * transactional mail here this is user-initiated, so failures must surface:
   * it returns the outbox row and throws if it cannot be queued.
   */
  async userMessage(input: {
    from: { id: string; name: string };
    to: { id: string | null; email: string };
    subject: string;
    body: string;
    /** Set when composed as a reply, to thread it under the original. */
    replyToId?: string | null;
  }): Promise<{ id: string }> {
    return enqueue({
      template: 'message',
      to: input.to,
      fromUserId: input.from.id,
      replyToId: input.replyToId ?? null,
      variables: { senderName: input.from.name, subject: input.subject, body: input.body },
    });
  },

  /** Notifies an assignee that a task is now theirs. */
  async taskAssignedEmail(input: {
    task: { id: string; title: string; description: string | null; dueDate: Date | null; priority: string };
    project: { name: string } | null;
    assignee: { id: string; email: string; firstName: string };
    assignedBy: string;
  }): Promise<void> {
    await enqueueQuietly(
      {
        template: 'task_assigned',
        to: { id: input.assignee.id, email: input.assignee.email },
        jobId: `task-assigned:${input.task.id}:${input.assignee.id}`,
        variables: {
          recipientName: input.assignee.firstName,
          taskId: input.task.id,
          taskTitle: input.task.title,
          assignedBy: input.assignedBy,
          priority: input.task.priority,
          ...(input.task.description ? { description: input.task.description } : {}),
          ...(input.project ? { projectName: input.project.name } : {}),
          ...(input.task.dueDate ? { dueDate: input.task.dueDate.toISOString().slice(0, 10) } : {}),
        },
      },
      { taskId: input.task.id, assigneeId: input.assignee.id },
    );
  },

  /**
   * Tells whoever is watching a task that it moved. The job id carries the new
   * status, so a bounce between two statuses still mails each transition once.
   */
  async taskStatusChangedEmail(input: {
    task: { id: string; title: string };
    project: { name: string } | null;
    recipient: { id: string; email: string; firstName: string };
    fromStatus: string;
    toStatus: string;
    changedBy: string;
  }): Promise<void> {
    await enqueueQuietly(
      {
        template: 'task_status_changed',
        to: { id: input.recipient.id, email: input.recipient.email },
        jobId: `task-status:${input.task.id}:${input.recipient.id}:${input.toStatus}`,
        variables: {
          recipientName: input.recipient.firstName,
          taskId: input.task.id,
          taskTitle: input.task.title,
          fromStatus: input.fromStatus,
          toStatus: input.toStatus,
          changedBy: input.changedBy,
          ...(input.project ? { projectName: input.project.name } : {}),
        },
      },
      { taskId: input.task.id, recipientId: input.recipient.id },
    );
  },

  /** Tells a user they were added to a project. One mail per member added. */
  async projectInvitationEmail(input: {
    project: { id: string; name: string; description: string | null; status: string; startDate: Date; endDate: Date | null };
    manager: { name: string } | null;
    member: { id: string; email: string; firstName: string };
    invitedBy: string;
  }): Promise<void> {
    await enqueueQuietly(
      {
        template: 'project_invitation',
        to: { id: input.member.id, email: input.member.email },
        jobId: `project-invite:${input.project.id}:${input.member.id}`,
        variables: {
          recipientName: input.member.firstName,
          projectId: input.project.id,
          projectName: input.project.name,
          invitedBy: input.invitedBy,
          status: input.project.status,
          startDate: input.project.startDate.toISOString().slice(0, 10),
          ...(input.project.endDate ? { endDate: input.project.endDate.toISOString().slice(0, 10) } : {}),
          ...(input.project.description ? { description: input.project.description } : {}),
          ...(input.manager ? { managerName: input.manager.name } : {}),
        },
      },
      { projectId: input.project.id, memberId: input.member.id },
    );
  },

  /** Throws when Redis is unavailable — the caller decides how to degrade. */
  async activity(data: ActivityJobData): Promise<void> {
    await getQueues().activity.add(data.action, data, { jobId: data.id });
  },
};
