/**
 * Test-only fixtures: demo users, projects, tasks, activity and notifications
 * the test suites log in as and assert against. Run by tests/global-setup.ts
 * after prisma/seed.ts, against the test database only — never seeded into a
 * real database.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient, type Priority, type ProjectStatus, type TaskStatus } from '@prisma/client';
import { SUPER_ADMIN_ROLE } from '../src/modules/permissions/permission-catalog';

const prisma = new PrismaClient();
const DEMO_PASSWORD = 'Password123!';
const BCRYPT_COST = 4;

// Deterministic ids keep the seed idempotent and make demo URLs stable.
const id = (group: number, n: number) => `00000000-0000-4000-8${group.toString().padStart(3, '0')}-${n.toString().padStart(12, '0')}`;

const USERS = [
  { key: 'superadmin', firstName: 'Ava', lastName: 'Sterling', email: 'superadmin@timeflow.dev', role: SUPER_ADMIN_ROLE, phone: '+1 415 555 0100' },
  { key: 'admin', firstName: 'Marcus', lastName: 'Reed', email: 'admin@timeflow.dev', role: 'Admin', phone: '+1 415 555 0101' },
  { key: 'manager', firstName: 'Priya', lastName: 'Nair', email: 'manager@timeflow.dev', role: 'Manager', phone: '+1 415 555 0102' },
  { key: 'employee', firstName: 'Leo', lastName: 'Park', email: 'employee@timeflow.dev', role: 'Employee', phone: '+1 415 555 0103' },
  { key: 'kai', firstName: 'Kai', lastName: 'Morgan', email: 'kai.morgan@timeflow.dev', role: 'Employee', phone: null },
  { key: 'zoe', firstName: 'Zoe', lastName: 'Chen', email: 'zoe.chen@timeflow.dev', role: 'Employee', phone: '+44 20 7946 0958' },
  { key: 'diego', firstName: 'Diego', lastName: 'Alvarez', email: 'diego.alvarez@timeflow.dev', role: 'Manager', phone: null },
  { key: 'nina', firstName: 'Nina', lastName: 'Volkova', email: 'nina.volkova@timeflow.dev', role: 'Employee', phone: null, status: 'INACTIVE' as const },
] as const;

type UserKey = (typeof USERS)[number]['key'];

const day = (offset: number) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
};

const PROJECTS: {
  n: number; name: string; description: string; status: ProjectStatus; priority: Priority;
  start: number; end: number | null; manager: UserKey; members: UserKey[];
}[] = [
    { n: 1, name: 'Website Redesign', description: 'Rebuild the marketing site with the new neon design system, faster pages and a CMS.', status: 'ACTIVE', priority: 'HIGH', start: -30, end: 30, manager: 'manager', members: ['employee', 'kai', 'zoe'] },
    { n: 2, name: 'Mobile App Launch', description: 'Ship v1 of the iOS and Android companion apps with push notifications.', status: 'PLANNING', priority: 'CRITICAL', start: 7, end: 90, manager: 'diego', members: ['zoe', 'kai'] },
    { n: 3, name: 'Data Platform Migration', description: 'Move analytics workloads from the legacy warehouse to Postgres + dbt.', status: 'ON_HOLD', priority: 'MEDIUM', start: -60, end: 45, manager: 'manager', members: ['kai'] },
    { n: 4, name: 'Q3 Security Audit', description: 'Pen-test remediation, dependency upgrades and SOC 2 evidence collection.', status: 'COMPLETED', priority: 'HIGH', start: -120, end: -10, manager: 'admin', members: ['employee', 'diego'] },
    { n: 5, name: 'Customer Onboarding Revamp', description: 'Guided setup flow, in-app checklists and lifecycle emails.', status: 'ACTIVE', priority: 'LOW', start: -14, end: 60, manager: 'diego', members: ['employee', 'zoe'] },
  ];

const TASKS: { n: number; project: number; title: string; status: TaskStatus; priority: Priority; assignee: UserKey | null; due: number | null; creator: UserKey; description?: string }[] = [
  { n: 1, project: 1, title: 'Audit current site performance', status: 'COMPLETED', priority: 'MEDIUM', assignee: 'employee', due: -20, creator: 'manager' },
  { n: 2, project: 1, title: 'Design hero section concepts', status: 'REVIEW', priority: 'HIGH', assignee: 'zoe', due: -2, creator: 'manager' },
  { n: 3, project: 1, title: 'Build responsive navigation', status: 'IN_PROGRESS', priority: 'HIGH', assignee: 'employee', due: 3, creator: 'manager', description: 'Keyboard accessible, collapses below 768px.' },
  { n: 4, project: 1, title: 'Migrate blog content to CMS', status: 'TODO', priority: 'MEDIUM', assignee: 'kai', due: 12, creator: 'manager' },
  { n: 5, project: 1, title: 'Set up Lighthouse CI budget', status: 'TODO', priority: 'LOW', assignee: 'employee', due: 20, creator: 'manager' },
  { n: 6, project: 2, title: 'Define MVP feature scope', status: 'IN_PROGRESS', priority: 'CRITICAL', assignee: 'diego', due: 5, creator: 'diego' },
  { n: 7, project: 2, title: 'Push notification provider evaluation', status: 'TODO', priority: 'HIGH', assignee: 'kai', due: 14, creator: 'diego' },
  { n: 8, project: 2, title: 'App store listing copy', status: 'TODO', priority: 'LOW', assignee: 'zoe', due: 60, creator: 'diego' },
  { n: 9, project: 3, title: 'Inventory legacy ETL jobs', status: 'COMPLETED', priority: 'MEDIUM', assignee: 'kai', due: -40, creator: 'manager' },
  { n: 10, project: 3, title: 'Prototype dbt models', status: 'REVIEW', priority: 'MEDIUM', assignee: 'kai', due: -5, creator: 'manager' },
  { n: 11, project: 4, title: 'Remediate critical pen-test findings', status: 'COMPLETED', priority: 'CRITICAL', assignee: 'employee', due: -30, creator: 'admin' },
  { n: 12, project: 4, title: 'Rotate production secrets', status: 'COMPLETED', priority: 'HIGH', assignee: 'diego', due: -25, creator: 'admin' },
  { n: 13, project: 4, title: 'Collect SOC 2 evidence', status: 'COMPLETED', priority: 'MEDIUM', assignee: 'employee', due: -12, creator: 'admin' },
  { n: 14, project: 5, title: 'Map current onboarding funnel', status: 'COMPLETED', priority: 'MEDIUM', assignee: 'zoe', due: -7, creator: 'diego' },
  { n: 15, project: 5, title: 'Write lifecycle email sequence', status: 'IN_PROGRESS', priority: 'LOW', assignee: 'employee', due: 9, creator: 'diego' },
  { n: 16, project: 5, title: 'In-app checklist component', status: 'TODO', priority: 'MEDIUM', assignee: null, due: 25, creator: 'diego' },
];

async function main() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Demo fixtures are only for the test database.');
  const roleIds = new Map((await prisma.role.findMany({ select: { id: true, name: true } })).map((r) => [r.name, r.id]));

  // ── Users ─────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_COST);
  const userIds = new Map<UserKey, string>();
  for (const [i, u] of USERS.entries()) {
    // Reuse by fixed id (even if soft-deleted by a reviewer) or by live email; otherwise create.
    const found =
      (await prisma.user.findUnique({ where: { id: id(1, i + 1) }, select: { id: true } })) ??
      (await prisma.user.findFirst({ where: { email: u.email, deletedAt: null }, select: { id: true } }));
    if (found) {
      userIds.set(u.key, found.id);
      continue;
    }
    const created = await prisma.user.create({
      data: {
        id: id(1, i + 1),
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        phone: u.phone,
        status: 'status' in u ? u.status : 'ACTIVE',
        roleId: roleIds.get(u.role)!,
        passwordHash,
        createdAt: day(-150 + i * 3),
      },
      select: { id: true },
    });
    userIds.set(u.key, created.id);
  }
  const uid = (k: UserKey) => userIds.get(k)!;

  // ── Projects & members ────────────────────────────────────────
  for (const p of PROJECTS) {
    const projectId = id(2, p.n);
    await prisma.project.upsert({
      where: { id: projectId },
      update: {},
      create: {
        id: projectId,
        name: p.name,
        description: p.description,
        status: p.status,
        priority: p.priority,
        startDate: day(p.start),
        endDate: p.end === null ? null : day(p.end),
        managerId: uid(p.manager),
        createdById: uid('superadmin'),
        createdAt: day(p.start - 5),
      },
    });
    await prisma.projectMember.createMany({
      data: p.members.map((m) => ({ projectId, userId: uid(m) })),
      skipDuplicates: true,
    });
  }

  // ── Tasks ─────────────────────────────────────────────────────
  for (const t of TASKS) {
    await prisma.task.upsert({
      where: { id: id(3, t.n) },
      update: {},
      create: {
        id: id(3, t.n),
        title: t.title,
        description: t.description ?? null,
        projectId: id(2, t.project),
        assigneeId: t.assignee ? uid(t.assignee) : null,
        status: t.status,
        priority: t.priority,
        dueDate: t.due === null ? null : day(t.due),
        createdById: uid(t.creator),
        completedAt: t.status === 'COMPLETED' ? day((t.due ?? 0) - 1) : null,
        createdAt: day(-45 + t.n),
      },
    });
  }

  // ── Activity logs ─────────────────────────────────────────────
  const activities = [
    { user: 'superadmin', action: 'user.created', entity: 'user', entityId: uid('manager'), description: 'Ava Sterling created user Priya Nair', ago: 140 },
    { user: 'superadmin', action: 'role.permissions_changed', entity: 'role', entityId: roleIds.get('Manager')!, description: 'Ava Sterling changed permissions of role Manager', ago: 130, metadata: { added: ['activity_logs.view'], removed: [] } },
    { user: 'admin', action: 'project.created', entity: 'project', entityId: id(2, 4), description: 'Marcus Reed created project Q3 Security Audit', ago: 125 },
    { user: 'manager', action: 'project.created', entity: 'project', entityId: id(2, 1), description: 'Priya Nair created project Website Redesign', ago: 35 },
    { user: 'employee', action: 'task.status_changed', entity: 'task', entityId: id(3, 1), description: 'Leo Park changed task Audit current site performance status from In Progress to Completed', ago: 21, metadata: { from: 'IN_PROGRESS', to: 'COMPLETED' } },
    { user: 'admin', action: 'project.status_changed', entity: 'project', entityId: id(2, 4), description: 'Marcus Reed changed project Q3 Security Audit status from Active to Completed', ago: 10, metadata: { from: 'ACTIVE', to: 'COMPLETED' } },
    { user: 'diego', action: 'project.created', entity: 'project', entityId: id(2, 5), description: 'Diego Alvarez created project Customer Onboarding Revamp', ago: 15 },
    { user: 'manager', action: 'project.status_changed', entity: 'project', entityId: id(2, 3), description: 'Priya Nair changed project Data Platform Migration status from Active to On Hold', ago: 6, metadata: { from: 'ACTIVE', to: 'ON_HOLD' } },
    { user: 'zoe', action: 'task.status_changed', entity: 'task', entityId: id(3, 2), description: 'Zoe Chen changed task Design hero section concepts status from In Progress to Review', ago: 2, metadata: { from: 'IN_PROGRESS', to: 'REVIEW' } },
    { user: 'admin', action: 'user.status_changed', entity: 'user', entityId: uid('nina'), description: 'Marcus Reed deactivated user Nina Volkova', ago: 1, metadata: { from: 'ACTIVE', to: 'INACTIVE' } },
    { user: 'employee', action: 'task.status_changed', entity: 'task', entityId: id(3, 3), description: 'Leo Park changed task Build responsive navigation status from Todo to In Progress', ago: 0, metadata: { from: 'TODO', to: 'IN_PROGRESS' } },
  ] as const;

  await prisma.activityLog.createMany({
    skipDuplicates: true,
    data: activities.map((a, i) => ({
      id: id(4, i + 1),
      userId: uid(a.user),
      action: a.action,
      entity: a.entity,
      entityId: a.entityId,
      description: a.description,
      metadata: 'metadata' in a ? a.metadata : {},
      ipAddress: '127.0.0.1',
      createdAt: new Date(Date.now() - a.ago * 24 * 3600 * 1000 - (activities.length - i) * 60_000),
    })),
  });

  // Background activity for the last 60 days so the activity chart has a realistic
  // shape (busier weekdays, quiet weekends). Seeded PRNG + fixed ids keep it idempotent.
  let rng = 0x7f4a7c15;
  const rand = () => {
    rng = (rng + 0x6d2b79f5) | 0;
    let t = Math.imul(rng ^ (rng >>> 15), 1 | rng);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const nameOf = (k: UserKey) => {
    const u = USERS.find((x) => x.key === k)!;
    return `${u.firstName} ${u.lastName}`;
  };
  const activeUsers: UserKey[] = ['superadmin', 'admin', 'manager', 'employee', 'kai', 'zoe', 'diego'];
  const transitions = [['TODO', 'In Progress', 'Todo', 'IN_PROGRESS'], ['IN_PROGRESS', 'Review', 'In Progress', 'REVIEW'], ['REVIEW', 'Completed', 'Review', 'COMPLETED']] as const;
  const background: { id: string; userId: string; action: string; entity: string; entityId: string; description: string; metadata: object; ipAddress: string; createdAt: Date }[] = [];
  for (let ago = 59; ago >= 0; ago--) {
    const weekday = ![0, 6].includes(day(-ago).getUTCDay());
    const count = weekday ? 2 + Math.floor(rand() * 7) : Math.floor(rand() * 3);
    for (let e = 0; e < count; e++) {
      const who = pick(activeUsers);
      const actor = nameOf(who);
      const task = pick(TASKS);
      const project = PROJECTS.find((p) => p.n === task.project)!;
      const kind = rand();
      let event: { action: string; entity: string; entityId: string; description: string; metadata: object };
      if (kind < 0.3) {
        event = { action: 'auth.login', entity: 'auth', entityId: uid(who), description: `${actor} signed in`, metadata: {} };
      } else if (kind < 0.6) {
        event = { action: 'task.updated', entity: 'task', entityId: id(3, task.n), description: `${actor} updated task ${task.title}`, metadata: {} };
      } else if (kind < 0.8) {
        const [from, toLabel, fromLabel, to] = pick(transitions);
        event = { action: 'task.status_changed', entity: 'task', entityId: id(3, task.n), description: `${actor} changed task ${task.title} status from ${fromLabel} to ${toLabel}`, metadata: { from, to } };
      } else if (kind < 0.9) {
        event = { action: 'task.created', entity: 'task', entityId: id(3, task.n), description: `${actor} created task ${task.title} in ${project.name}`, metadata: {} };
      } else {
        event = { action: 'project.updated', entity: 'project', entityId: id(2, project.n), description: `${actor} updated project ${project.name}`, metadata: {} };
      }
      background.push({
        id: id(4, 1000 + background.length),
        userId: uid(who),
        ...event,
        ipAddress: '127.0.0.1',
        // Working hours, 08:00–18:00 UTC.
        createdAt: new Date(day(-ago).getTime() + (8 + rand() * 10) * 3600 * 1000),
      });
    }
  }
  // Today's events can't be in the future.
  await prisma.activityLog.createMany({ skipDuplicates: true, data: background.filter((b) => b.createdAt.getTime() <= Date.now()) });

  // ── Notifications ─────────────────────────────────────────────
  const notifications = [
    { user: 'employee', type: 'task.assigned', title: 'New task assigned: Build responsive navigation', body: 'Website Redesign', link: `/tasks/${id(3, 3)}`, read: false },
    { user: 'employee', type: 'task.assigned', title: 'New task assigned: Write lifecycle email sequence', body: 'Customer Onboarding Revamp', link: `/tasks/${id(3, 15)}`, read: false },
    { user: 'employee', type: 'project.member_added', title: 'You were added to project Website Redesign', body: null, link: `/projects/${id(2, 1)}`, read: true },
    { user: 'manager', type: 'task.status_changed', title: 'Design hero section concepts → Review', body: null, link: `/tasks/${id(3, 2)}`, read: false },
    { user: 'manager', type: 'project.manager_assigned', title: 'You now manage project Data Platform Migration', body: null, link: `/projects/${id(2, 3)}`, read: true },
    { user: 'admin', type: 'user.role_changed', title: 'Welcome to the admin console', body: 'Explore users, projects and activity.', link: '/dashboard', read: false },
    { user: 'superadmin', type: 'system', title: 'Queue monitor is live', body: 'Inspect background jobs under System → Queues.', link: '/queues', read: false },
  ] as const;
  await prisma.notification.createMany({
    skipDuplicates: true,
    data: notifications.map((n, i) => ({
      id: id(5, i + 1),
      userId: uid(n.user),
      type: n.type,
      title: n.title,
      body: n.body,
      link: n.link,
      readAt: n.read ? new Date() : null,
      createdAt: new Date(Date.now() - (notifications.length - i) * 3600_000),
    })),
  });

  const counts = await prisma.$transaction([prisma.user.count(), prisma.project.count(), prisma.task.count(), prisma.activityLog.count()]);
  console.log(`Fixtures loaded — users: ${counts[0]}, projects: ${counts[1]}, tasks: ${counts[2]}, activity logs: ${counts[3]}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
