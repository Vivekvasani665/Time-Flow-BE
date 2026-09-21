/**
 * Idempotent seed. Safe to run on every deploy:
 *  - permissions and the Super Admin role are synchronised to the catalog;
 *  - the default Admin / Manager / Employee roles are created only on a fresh
 *    database; after that they are ordinary roles the Super Admin can rename,
 *    edit or delete, and the seed never recreates or resets them;
 *  - the first Super Admin is created from ADMIN_EMAIL / ADMIN_PASSWORD if set
 *    and missing;
 *  - the demo Super Admin is created only if missing (fixed id). It uses a
 *    published password, so it is skipped when NODE_ENV=production unless
 *    SEED_DEMO_DATA=true;
 *  - extra users for the automated tests are created only when NODE_ENV=test.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, ALL_PERMISSION_KEYS, SUPER_ADMIN_ROLE, type PermissionKey } from '../src/modules/permissions/permission-catalog';
import { emailSchema, passwordSchema } from '../src/common/utils/validation';

const prisma = new PrismaClient();
const DEMO_PASSWORD = 'Password123!';
const BCRYPT_COST = process.env.NODE_ENV === 'test' ? 4 : 12;
const SEED_DEMO_DATA = process.env.SEED_DEMO_DATA ? process.env.SEED_DEMO_DATA === 'true' : process.env.NODE_ENV !== 'production';

const except = (...excluded: PermissionKey[]) => ALL_PERMISSION_KEYS.filter((k) => !excluded.includes(k));

const ROLES: { name: string; description: string; permissions: PermissionKey[] }[] = [
  { name: SUPER_ADMIN_ROLE, description: 'Unrestricted access to every module', permissions: ALL_PERMISSION_KEYS },
  {
    name: 'Admin',
    description: 'Manages users, projects and tasks; cannot change roles',
    permissions: except('roles.create', 'roles.update', 'roles.delete', 'queues.manage', 'emails.configure'),
  },
  {
    name: 'Manager',
    description: 'Runs the projects they manage and their tasks',
    permissions: ['users.view', 'projects.view', 'projects.create', 'projects.update', 'tasks.view', 'tasks.create', 'tasks.update', 'tasks.delete', 'activity_logs.view', 'emails.view', 'emails.send'],
  },
  { name: 'Employee', description: 'Works on assigned projects and tasks', permissions: ['projects.view', 'tasks.view', 'tasks.update', 'emails.view', 'emails.send'] },
];

// Deterministic id keeps the seed idempotent.
const id = (group: number, n: number) => `00000000-0000-4000-8${group.toString().padStart(3, '0')}-${n.toString().padStart(12, '0')}`;

const DEMO_SUPER_ADMIN = { firstName: 'Ava', lastName: 'Sterling', email: 'superadmin@timeflow.dev', phone: '+1 415 555 0100' };

// Fixtures the test suite logs in as (tests/helpers.ts). Never seeded outside NODE_ENV=test.
const TEST_USERS = [
  { firstName: 'Marcus', lastName: 'Reed', email: 'admin@timeflow.dev', role: 'Admin', phone: '+1 415 555 0101' },
  { firstName: 'Priya', lastName: 'Nair', email: 'manager@timeflow.dev', role: 'Manager', phone: '+1 415 555 0102' },
  { firstName: 'Leo', lastName: 'Park', email: 'employee@timeflow.dev', role: 'Employee', phone: '+1 415 555 0103' },
  { firstName: 'Kai', lastName: 'Morgan', email: 'kai.morgan@timeflow.dev', role: 'Employee', phone: null },
  { firstName: 'Zoe', lastName: 'Chen', email: 'zoe.chen@timeflow.dev', role: 'Employee', phone: '+44 20 7946 0958' },
  { firstName: 'Diego', lastName: 'Alvarez', email: 'diego.alvarez@timeflow.dev', role: 'Manager', phone: null },
  { firstName: 'Nina', lastName: 'Volkova', email: 'nina.volkova@timeflow.dev', role: 'Employee', phone: null, status: 'INACTIVE' as const },
];

async function main() {
  // ── Permissions ─────────────────────────────────────────────
  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { module: p.module, action: p.action, description: p.description },
      create: p,
    });
  }
  const permissionIds = new Map((await prisma.permission.findMany({ select: { id: true, key: true } })).map((p) => [p.key, p.id]));

  // ── Roles ─────────────────────────────────────────────────────
  // Only Super Admin is a locked system role, re-synchronised every run. The
  // other defaults are created on a fresh database only, so renaming, editing
  // or deleting them is never undone by a later seed.
  const freshDatabase = (await prisma.role.count()) === 0;
  await prisma.role.updateMany({ where: { isSystem: true, name: { not: SUPER_ADMIN_ROLE } }, data: { isSystem: false } });

  let superAdminRoleId = '';
  for (const r of ROLES) {
    const isSuperAdmin = r.name === SUPER_ADMIN_ROLE;
    if (!isSuperAdmin && !freshDatabase) continue;
    const role = await prisma.role.upsert({
      where: { name: r.name },
      update: isSuperAdmin ? { description: r.description, isSystem: true } : {},
      create: { name: r.name, description: r.description, isSystem: isSuperAdmin },
    });
    if (isSuperAdmin) superAdminRoleId = role.id;
    await prisma.$transaction([
      prisma.rolePermission.deleteMany({ where: { roleId: role.id } }),
      prisma.rolePermission.createMany({ data: r.permissions.map((key) => ({ roleId: role.id, permissionId: permissionIds.get(key)! })) }),
    ]);
  }

  await bootstrapAdmin(superAdminRoleId);

  if (!SEED_DEMO_DATA) {
    console.log('Seed complete — permissions and Super Admin role synchronised; demo data skipped (set SEED_DEMO_DATA=true to include it).');
    return;
  }

  // ── Demo Super Admin ─────────────────────────────────────────
  // Reuse by fixed id (even if soft-deleted) or by live email; otherwise create.
  const found =
    (await prisma.user.findUnique({ where: { id: id(1, 1) }, select: { id: true } })) ??
    (await prisma.user.findFirst({ where: { email: DEMO_SUPER_ADMIN.email, deletedAt: null }, select: { id: true } }));
  if (!found) {
    await prisma.user.create({
      data: {
        id: id(1, 1),
        ...DEMO_SUPER_ADMIN,
        status: 'ACTIVE',
        roleId: superAdminRoleId,
        passwordHash: await bcrypt.hash(DEMO_PASSWORD, BCRYPT_COST),
      },
    });
  }

  if (process.env.NODE_ENV === 'test') await seedTestUsers();

  console.log(`Seed complete — demo login: ${DEMO_SUPER_ADMIN.email} (password "${DEMO_PASSWORD}")`);
}

async function seedTestUsers() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_COST);
  for (const [i, { role, ...u }] of TEST_USERS.entries()) {
    const { id: roleId } = await prisma.role.findUniqueOrThrow({ where: { name: role }, select: { id: true } });
    await prisma.user.upsert({
      where: { id: id(1, i + 2) },
      update: {},
      create: { id: id(1, i + 2), ...u, status: u.status ?? 'ACTIVE', roleId, passwordHash },
    });
  }
}

/**
 * Creates the first real Super Admin so a production database is usable
 * without the demo accounts. Only ever creates: an existing account with that
 * email is left untouched, so rotating ADMIN_PASSWORD later changes nothing.
 */
async function bootstrapAdmin(superAdminRoleId: string) {
  const rawEmail = process.env.ADMIN_EMAIL?.trim();
  if (!rawEmail) {
    if (!SEED_DEMO_DATA && (await prisma.user.count({ where: { deletedAt: null } })) === 0) {
      console.warn('No users exist and ADMIN_EMAIL is not set — set ADMIN_EMAIL and ADMIN_PASSWORD and re-run the seed to create the first Super Admin.');
    }
    return;
  }

  const email = emailSchema.parse(rawEmail);
  if (await prisma.user.findFirst({ where: { email, deletedAt: null }, select: { id: true } })) {
    console.log(`Admin ${email} already exists; left unchanged.`);
    return;
  }

  const password = passwordSchema.safeParse(process.env.ADMIN_PASSWORD ?? '');
  if (!password.success) throw new Error(`ADMIN_PASSWORD is invalid: ${password.error.issues.map((i) => i.message).join('; ')}`);

  await prisma.user.create({
    data: {
      firstName: process.env.ADMIN_FIRST_NAME?.trim() || 'Admin',
      lastName: process.env.ADMIN_LAST_NAME?.trim() || 'User',
      email,
      roleId: superAdminRoleId,
      passwordHash: await bcrypt.hash(password.data, BCRYPT_COST),
    },
  });
  console.log(`Created Super Admin ${email}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
