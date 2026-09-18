import { Router, type Request, type Response } from 'express';
import { prisma } from '../../lib/prisma';
import { ok } from '../../common/http/response';
import { authenticate, requirePermission } from '../../common/middleware/authenticate';
import { P } from './permission-catalog';

export const permissionRouter = Router();

permissionRouter.get('/', authenticate, requirePermission(P['roles.view']), async (_req: Request, res: Response) => {
  const permissions = await prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { action: 'asc' }] });
  return ok(res, permissions);
});
