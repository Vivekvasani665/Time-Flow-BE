/**
 * Single source of truth for permission keys. The seed upserts exactly this
 * list, and route guards reference the `P` constants so a typo is a compile
 * error rather than a silently-denied route.
 */
export const PERMISSION_CATALOG = {
  users: {
    view: 'View users',
    create: 'Create users',
    update: 'Update users, change status',
    delete: 'Delete users',
  },
  roles: {
    view: 'View roles and permissions',
    create: 'Create roles',
    update: 'Update roles and assign permissions',
    delete: 'Delete roles',
  },
  projects: {
    view: 'View projects you manage or belong to',
    create: 'Create projects',
    update: 'Update projects',
    delete: 'Delete projects',
    view_all: 'View and manage all projects (lifts data scoping)',
  },
  tasks: {
    view: 'View tasks assigned to you or in projects you manage',
    create: 'Create tasks',
    update: 'Update tasks',
    delete: 'Delete tasks',
    view_all: 'View and manage all tasks (lifts data scoping)',
  },
  activity_logs: {
    view: 'View activity logs',
    export: 'Export activity logs as CSV',
  },
  emails: {
    view: 'View your own mailbox (mail you received or triggered)',
    send: 'Compose and send mail to other team members',
    send_external: 'Send mail to addresses outside the team (uses the org sender identity)',
    configure: 'Configure the outgoing mail account',
    view_all: 'View every email in the system',
  },
  queues: {
    view: 'View background queues and email log',
    manage: 'Retry failed background jobs',
  },
} as const;

type Catalog = typeof PERMISSION_CATALOG;
export type PermissionKey = {
  [M in keyof Catalog]: `${M & string}.${keyof Catalog[M] & string}`;
}[keyof Catalog];

export const ALL_PERMISSIONS: { key: PermissionKey; module: string; action: string; description: string }[] =
  Object.entries(PERMISSION_CATALOG).flatMap(([module, actions]) =>
    Object.entries(actions).map(([action, description]) => ({
      key: `${module}.${action}` as PermissionKey,
      module,
      action,
      description,
    })),
  );

export const ALL_PERMISSION_KEYS: PermissionKey[] = ALL_PERMISSIONS.map((p) => p.key);

export const P = Object.fromEntries(ALL_PERMISSION_KEYS.map((k) => [k, k])) as { [K in PermissionKey]: K };

export const SUPER_ADMIN_ROLE = 'Super Admin';
