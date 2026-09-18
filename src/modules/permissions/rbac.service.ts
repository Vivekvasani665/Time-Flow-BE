import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { logger } from '../../lib/logger';
import { ForbiddenError } from '../../common/errors';
import type { AuthContext, CachedUser } from '../auth/auth.types';

const USER_TTL_SECONDS = 300;
const ROLE_PERMS_TTL_SECONDS = 600;

const userKey = (id: string) => `auth:user:${id}`;
const rolePermsKey = (roleId: string) => `rbac:role:${roleId}:perms`;

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch (err) {
    logger.warn({ err, key }, 'auth cache read failed');
    return null;
  }
}

function writeJson(key: string, value: unknown, ttl: number): void {
  redis.set(key, JSON.stringify(value), 'EX', ttl).catch((err: unknown) => logger.warn({ err, key }, 'auth cache write failed'));
}

export const rbacService = {
  /** Identity snapshot for a live (non-deleted) user, cached in Redis. */
  async getCachedUser(userId: string): Promise<CachedUser | null> {
    const cached = await readJson<CachedUser>(userKey(userId));
    if (cached) return cached;

    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        status: true,
        roleId: true,
        tokenVersion: true,
        role: { select: { name: true } },
      },
    });
    if (!user) return null;

    const snapshot: CachedUser = {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      roleId: user.roleId,
      roleName: user.role.name,
      tokenVersion: user.tokenVersion,
    };
    writeJson(userKey(userId), snapshot, USER_TTL_SECONDS);
    return snapshot;
  },

  async getRolePermissions(roleId: string): Promise<string[]> {
    const cached = await readJson<string[]>(rolePermsKey(roleId));
    if (cached) return cached;

    const rows = await prisma.rolePermission.findMany({
      where: { roleId },
      select: { permission: { select: { key: true } } },
    });
    const keys = rows.map((r) => r.permission.key).sort();
    writeJson(rolePermsKey(roleId), keys, ROLE_PERMS_TTL_SECONDS);
    return keys;
  },

  async buildAuthContext(userId: string): Promise<AuthContext | null> {
    const user = await this.getCachedUser(userId);
    if (!user) return null;
    const permissions = await this.getRolePermissions(user.roleId);
    return { ...user, permissions: new Set(permissions) };
  },

  async invalidateUser(...userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await redis.del(...userIds.map(userKey)).catch((err: unknown) => logger.error({ err }, 'auth cache invalidation failed'));
  },

  async invalidateRole(roleId: string): Promise<void> {
    await redis.del(rolePermsKey(roleId)).catch((err: unknown) => logger.error({ err }, 'rbac cache invalidation failed'));
  },

  /** Privilege-escalation guard: the actor must already hold every permission in `keys`. */
  assertHoldsAll(actor: AuthContext, keys: Iterable<string>, message: string): void {
    const missing = [...keys].filter((k) => !actor.permissions.has(k));
    if (missing.length > 0) throw new ForbiddenError(`${message} (missing: ${missing.join(', ')})`);
  },

  /** Actor may assign/manage a role only if its permissions are a subset of theirs. */
  async assertCanManageRole(actor: AuthContext, roleId: string, message: string): Promise<void> {
    const perms = await this.getRolePermissions(roleId);
    this.assertHoldsAll(actor, perms, message);
  },
};

export function can(actor: AuthContext, permission: string): boolean {
  return actor.permissions.has(permission);
}
