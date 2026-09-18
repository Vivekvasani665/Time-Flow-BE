import { Router, type Request, type Response } from 'express';
import { ok } from '../../common/http/response';
import { authenticate } from '../../common/middleware/authenticate';
import { requireAuth } from '../../common/utils/request-context';
import { dashboardService } from './dashboard.service';

export const dashboardRouter = Router();

dashboardRouter.get('/', authenticate, async (req: Request, res: Response) => {
  const { value, hit } = await dashboardService.get(requireAuth(req));
  res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
  return ok(res, value);
});
