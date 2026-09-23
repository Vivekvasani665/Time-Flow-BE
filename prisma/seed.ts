/**
 * Idempotent seed. Safe to run on every deploy:
 *  - permissions and system roles are synchronised to the catalog;
 *  - the first Super Admin is created from ADMIN_EMAIL / ADMIN_PASSWORD if set
 *    and missing.
 * No demo accounts or sample data are created.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, ALL_PERMISSION_KEYS, SUPER_ADMIN_ROLE, type PermissionKey } from '../src/modules/permissions/permission-catalog';
import { emailSchema, passwordSchema } from '../src/common/utils/validation';

const prisma = new PrismaClient();
const BCRYPT_COST = process.env.NODE_ENV === 'test' ? 4 : 12;

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

  // ── Roles (system roles are re-synchronised every run) ─────────
  const roleIds = new Map<string, string>();
  for (const r of ROLES) {
    const role = await prisma.role.upsert({
      where: { name: r.name },
      update: { description: r.description, isSystem: true },
      create: { name: r.name, description: r.description, isSystem: true },
    });
    roleIds.set(r.name, role.id);
    const existing = await prisma.rolePermission.count({ where: { roleId: role.id } });
    if (existing === 0 || r.name === SUPER_ADMIN_ROLE) {
      await prisma.$transaction([
        prisma.rolePermission.deleteMany({ where: { roleId: role.id } }),
        prisma.rolePermission.createMany({ data: r.permissions.map((key) => ({ roleId: role.id, permissionId: permissionIds.get(key)! })) }),
      ]);
    }
  }

  await bootstrapAdmin(roleIds.get(SUPER_ADMIN_ROLE)!);

  console.log('Seed complete — permissions and roles synchronised.');
}

/**
 * Creates the first real Super Admin so a fresh database is usable. Only ever creates: an existing account with that
 * email is left untouched, so rotating ADMIN_PASSWORD later changes nothing.
 */
async function bootstrapAdmin(superAdminRoleId: string) {
  const rawEmail = process.env.ADMIN_EMAIL?.trim();
  if (!rawEmail) {
    if ((await prisma.user.count({ where: { deletedAt: null } })) === 0) {
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
