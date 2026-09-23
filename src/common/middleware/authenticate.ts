import type { RequestHandler } from 'express';
import { SESSION_EXPIRES_HEADER, tokenService } from '../../modules/auth/token.service';
import { rbacService } from '../../modules/permissions/rbac.service';
import { SUPER_ADMIN_ROLE, type PermissionKey } from '../../modules/permissions/permission-catalog';
import { ForbiddenError, UnauthorizedError } from '../errors';

/**
 * Verifies the access token and attaches `req.auth`. Identity + permissions
 * come from Redis (falling back to Postgres), so deactivation, role changes
 * and password resets take effect on the very next request.
 */
export const authenticate: RequestHandler = async (req, res, next) => {
  const token = tokenService.extractAccessToken(req);
  if (!token) return next(new UnauthorizedError());

  const payload = tokenService.verifyAccessToken(token);
  if (!payload) return next(new UnauthorizedError('Session expired or invalid'));

  const context = await rbacService.buildAuthContext(payload.sub);
  if (!context || context.tokenVersion !== payload.tv) {
    return next(new UnauthorizedError('Session is no longer valid'));
  }
  if (context.status !== 'ACTIVE') return next(new UnauthorizedError('Account is inactive'));

  req.auth = context;
  res.setHeader(SESSION_EXPIRES_HEADER, new Date(payload.exp * 1000).toISOString());
  return next();
};

/** Requires ALL listed permissions. Must run after `authenticate`. */
export function requirePermission(...permissions: PermissionKey[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new UnauthorizedError());
    const missing = permissions.filter((p) => !req.auth!.permissions.has(p));
    if (missing.length > 0) {
      req.log?.info({ userId: req.auth.id, missing }, 'permission denied');
      return next(new ForbiddenError());
    }
    return next();
  };
}

/**
 * Restricts a route to the Super Admin role itself, not merely to a permission
 * set — for account-takeover-grade actions such as issuing password reset links.
 * The role's name is immutable (it is the system role). Must run after `authenticate`.
 */
export const requireSuperAdmin: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(new UnauthorizedError());
  if (req.auth.roleName !== SUPER_ADMIN_ROLE) return next(new ForbiddenError('Only a Super Admin can manage password resets'));
  return next();
};
