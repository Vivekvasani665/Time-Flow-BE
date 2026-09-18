import type { Request } from 'express';
import type { AuthContext } from '../../modules/auth/auth.types';
import { UnauthorizedError } from '../errors';

/** Who did what, from where — passed from controllers into services for auditing. */
export type RequestContext = {
  actor: AuthContext;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
};

export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw new UnauthorizedError();
  return req.auth;
}

export function getRequestContext(req: Request): RequestContext {
  return {
    actor: requireAuth(req),
    ip: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 255) ?? null,
    requestId: typeof req.id === 'string' ? req.id : req.id != null ? String(req.id) : null,
  };
}

export function fullName(u: { firstName: string; lastName: string }): string {
  return `${u.firstName} ${u.lastName}`.trim();
}
