import { env } from '../config/env';
import type { EmailTemplate } from './job-types';
import type { MailMessage } from './mailer';

const escapeHtml = (v: string) =>
  v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** Author-written prose: escaped, then the line breaks they typed are kept. */
const prose = (v: string) => escapeHtml(v).replace(/\n/g, '<br>');

/** "IN_PROGRESS" → "In progress", for enum values shown to people. */
const pretty = (v: string | undefined) => (v ? v.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '');

type Row = { label: string; value: string };

type Layout = {
  /** Small uppercase line above the title. */
  kicker?: string;
  heading: string;
  /** One line of context under the heading. */
  intro?: string;
  /** Label/value pairs; entries with an empty value are dropped. */
  rows?: Row[];
  /** Quoted block — a message body, a task description. */
  quote?: string;
  cta?: { label: string; url: string };
  footer?: string;
};

/**
 * The shared chrome for every email: a white card on a light grey page, one
 * accent colour, one CTA. Table-based and inline-styled, because that is what
 * mail clients reliably render. Templates below describe *what* to say; none of
 * them repeat this markup.
 */
const ACCENT = '#4f46e5';

function layout(l: Layout): string {
  const rows = (l.rows ?? []).filter((r) => r.value !== '');
  const rowsHtml = rows.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:4px 0 8px;border-top:1px solid #eef0f3">
${rows
  .map(
    (r) => `        <tr>
          <td style="padding:8px 16px 8px 0;border-bottom:1px solid #eef0f3;color:#6b7280;font-size:13px;white-space:nowrap;width:1%">${escapeHtml(r.label)}</td>
          <td style="padding:8px 0;border-bottom:1px solid #eef0f3;color:#111827;font-size:13px">${escapeHtml(r.value)}</td>
        </tr>`,
  )
  .join('\n')}
      </table>`
    : '';

  const quoteHtml = l.quote
    ? `<div style="background:#f9fafb;border:1px solid #eef0f3;border-radius:8px;padding:14px 16px;margin:16px 0;line-height:1.6;color:#374151;font-size:14px">${prose(l.quote)}</div>`
    : '';

  const ctaHtml = l.cta
    ? `<p style="margin:24px 0 4px"><a href="${l.cta.url}" style="display:inline-block;background:${ACCENT};color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">${escapeHtml(
        l.cta.label,
      )}</a></p>`
    : '';

  return `<div style="background:#f6f7f9;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="width:100%;max-width:560px;margin:0 auto;border-collapse:collapse">
    <tr>
      <td style="padding:0 4px 16px;font-size:15px;font-weight:600;color:#111827">
        <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${ACCENT};margin-right:8px"></span>TimeFlow
      </td>
    </tr>
    <tr>
      <td style="background:#ffffff;border:1px solid #e6e8ec;border-radius:12px;padding:28px">
      ${l.kicker ? `<p style="color:${ACCENT};font-size:12px;font-weight:600;margin:0 0 6px">${escapeHtml(l.kicker)}</p>` : ''}
      <h1 style="color:#111827;font-size:20px;line-height:1.3;font-weight:600;margin:0 0 ${l.intro ? '6px' : '16px'}">${escapeHtml(l.heading)}</h1>
      ${l.intro ? `<p style="color:#4b5563;font-size:14px;line-height:1.5;margin:0 0 16px">${escapeHtml(l.intro)}</p>` : ''}
      ${rowsHtml}
      ${quoteHtml}
      ${ctaHtml}
      </td>
    </tr>
    <tr>
      <td style="padding:16px 4px 0;color:#9ca3af;font-size:12px;line-height:1.5">${escapeHtml(l.footer ?? 'You received this because you have a TimeFlow account.')}</td>
    </tr>
  </table>
</div>`;
}

/** Plain-text twin of `layout`, so every email has a real text/plain part. */
function plain(l: Layout & { salutation?: string }): string {
  const rows = (l.rows ?? []).filter((r) => r.value !== '');
  return [
    l.salutation,
    l.heading,
    l.intro,
    rows.map((r) => `${r.label}: ${r.value}`).join('\n'),
    l.quote,
    l.cta ? `${l.cta.label}: ${l.cta.url}` : '',
    '— TimeFlow',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function renderEmail(template: EmailTemplate, to: string, vars: Record<string, string>): MailMessage {
  switch (template) {
    case 'welcome': {
      const l: Layout = {
        kicker: 'Welcome',
        heading: `Welcome to TimeFlow, ${vars.firstName ?? 'there'}`,
        intro: 'An account has been created for you on TimeFlow.',
        cta: { label: 'Sign in to TimeFlow', url: `${env.APP_URL}/login` },
        footer: 'Your administrator will share your initial password.',
      };
      return { to, subject: 'Welcome to TimeFlow', html: layout(l), text: plain({ ...l, salutation: `Hi ${vars.firstName ?? 'there'},` }) };
    }

    case 'message': {
      const l: Layout = {
        kicker: `Message from ${vars.senderName ?? 'A teammate'}`,
        heading: vars.subject ?? '(no subject)',
        quote: vars.body ?? '',
        cta: { label: 'Open your mailbox', url: `${env.APP_URL}/emails` },
        footer: `${vars.senderName ?? 'A teammate'} sent you this from TimeFlow. You can reply to this email directly.`,
      };
      return { to, subject: vars.subject ?? '(no subject)', html: layout(l), text: plain(l) };
    }

    case 'task_assigned': {
      const title = vars.taskTitle ?? 'a task';
      const l: Layout = {
        kicker: 'Task assigned',
        heading: title,
        intro: `Hi ${vars.recipientName ?? 'there'}, this is now yours.`,
        rows: [
          { label: 'Project', value: vars.projectName ?? '' },
          { label: 'Due', value: vars.dueDate ?? '' },
          { label: 'Priority', value: pretty(vars.priority) },
          { label: 'Assigned by', value: vars.assignedBy ?? '' },
        ],
        quote: vars.description,
        cta: { label: 'Open the task', url: `${env.APP_URL}/tasks/${vars.taskId ?? ''}` },
        footer: 'You received this because you were assigned this task in TimeFlow.',
      };
      return { to, subject: `Task assigned: ${title}`, html: layout(l), text: plain(l) };
    }

    case 'task_status_changed': {
      const title = vars.taskTitle ?? 'a task';
      const status = vars.toStatus ? pretty(vars.toStatus) : 'updated';
      const l: Layout = {
        kicker: 'Status changed',
        heading: title,
        intro: `Hi ${vars.recipientName ?? 'there'}, ${vars.changedBy ?? 'someone'} moved this task to ${status}.`,
        rows: [
          { label: 'Project', value: vars.projectName ?? '' },
          { label: 'From', value: pretty(vars.fromStatus) },
          { label: 'To', value: status },
          { label: 'Changed by', value: vars.changedBy ?? '' },
        ],
        cta: { label: 'Open the task', url: `${env.APP_URL}/tasks/${vars.taskId ?? ''}` },
        footer: 'You received this because you created or were assigned this task.',
      };
      return { to, subject: `${title} → ${status}`, html: layout(l), text: plain(l) };
    }

    case 'project_invitation': {
      const project = vars.projectName ?? 'a project';
      const l: Layout = {
        kicker: 'Project invitation',
        heading: `You have been added to ${project}`,
        intro: `Hi ${vars.recipientName ?? 'there'}, ${vars.invitedBy ?? 'a manager'} added you to this project.`,
        rows: [
          { label: 'Manager', value: vars.managerName ?? '' },
          { label: 'Status', value: pretty(vars.status) },
          { label: 'Starts', value: vars.startDate ?? '' },
          { label: 'Due', value: vars.endDate ?? '' },
        ],
        quote: vars.description,
        cta: { label: 'Open the project', url: `${env.APP_URL}/projects/${vars.projectId ?? ''}` },
        footer: 'You received this because you were added to this project in TimeFlow.',
      };
      return { to, subject: `You have been added to ${project}`, html: layout(l), text: plain(l) };
    }

    default: {
      const exhaustive: never = template;
      throw new Error(`Unknown email template: ${String(exhaustive)}`);
    }
  }
}

/**
 * Sent directly rather than through the queue: the queue keeps a copy of every
 * message in email_logs, and a live reset link must never be stored in clear.
 */
export function renderPasswordResetEmail(to: string, vars: { firstName: string; resetUrl: string; minutes: number }): MailMessage {
  const l: Layout = {
    kicker: 'Password reset',
    heading: 'Reset your TimeFlow password',
    intro: `Hi ${vars.firstName || 'there'}, an administrator requested a password reset for your TimeFlow account. Use the button below to choose a new password.`,
    rows: [{ label: 'Link expires in', value: `${vars.minutes} minutes` }],
    cta: { label: 'Reset password', url: vars.resetUrl },
    footer:
      'The link works once. If you did not expect this request, contact your administrator. TimeFlow staff will never ask you for your password.',
  };
  return {
    to,
    subject: 'Reset Your Time-Flow Password',
    html: layout(l),
    text: [plain({ ...l, salutation: `Hi ${vars.firstName || 'there'},` }), l.footer].join('\n\n'),
  };
}
