import { Router, type Request, type Response } from 'express';
import { ok, paginated } from '../../common/http/response';
import { authenticate, requirePermission } from '../../common/middleware/authenticate';
import { fullName, getRequestContext } from '../../common/utils/request-context';
import { P } from '../permissions/permission-catalog';
import { exportActivityQuerySchema, listActivityQuerySchema } from './activity-log.schemas';
import { activityLogService } from './activity-log.service';
import { activityService } from './activity.service';

export const activityLogRouter = Router();

activityLogRouter.use(authenticate);

activityLogRouter.get('/', requirePermission(P['activity_logs.view']), async (req: Request, res: Response) => {
  const { items, meta } = await activityLogService.list(listActivityQuerySchema.parse(req.query));
  return paginated(res, items, meta);
});

activityLogRouter.get('/stats', requirePermission(P['activity_logs.view']), async (req: Request, res: Response) => {
  return ok(res, await activityLogService.stats(exportActivityQuerySchema.parse(req.query)));
});

activityLogRouter.get('/export', requirePermission(P['activity_logs.export']), async (req: Request, res: Response) => {
  const filters = exportActivityQuerySchema.parse(req.query);
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="activity-logs-${date}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  const rows = await activityLogService.exportCsv(filters, res);
  res.end();
  const ctx = getRequestContext(req);
  void activityService.record(ctx, {
    action: 'activity_logs.exported',
    entity: 'activity_log',
    description: `${fullName(ctx.actor)} exported ${rows} activity log rows`,
    metadata: { rows, filters },
  });
});
