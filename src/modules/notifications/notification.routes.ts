import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { NotFoundError } from '../../common/errors';
import { skipTake } from '../../common/http/pagination';
import { buildMeta, ok, paginated } from '../../common/http/response';
import { authenticate } from '../../common/middleware/authenticate';
import { requireAuth } from '../../common/utils/request-context';
import { boolQuery, uuidParam } from '../../common/utils/validation';
import { notificationHub } from './notification-stream';

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  unread: boolQuery.optional(),
});

const notificationSelect = { id: true, type: true, title: true, body: true, link: true, readAt: true, createdAt: true } as const;

export const notificationRouter = Router();
notificationRouter.use(authenticate);

notificationRouter.get('/', async (req: Request, res: Response) => {
  const { id: userId } = requireAuth(req);
  const q = listQuery.parse(req.query);
  const where = { userId, ...(q.unread ? { readAt: null } : {}) };
  const [items, total, unread] = await prisma.$transaction([
    prisma.notification.findMany({ where, select: notificationSelect, orderBy: { createdAt: 'desc' }, ...skipTake(q.page, q.limit) }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  return paginated(res, items, { ...buildMeta(q.page, q.limit, total), unread });
});

notificationRouter.post('/read-all', async (req: Request, res: Response) => {
  const { id: userId } = requireAuth(req);
  const { count } = await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  return ok(res, { updated: count }, 'All notifications marked as read');
});

notificationRouter.patch('/:id/read', async (req: Request, res: Response) => {
  const { id: userId } = requireAuth(req);
  const { id } = uuidParam.parse(req.params);
  const { count } = await prisma.notification.updateMany({ where: { id, userId }, data: { readAt: new Date() } });
  if (count === 0) throw new NotFoundError('Notification');
  return ok(res, null, 'Notification marked as read');
});

notificationRouter.get('/stream', async (req: Request, res: Response) => {
  const { id: userId } = requireAuth(req);
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 5000\n\nevent: ready\ndata: {}\n\n');

  await notificationHub.add(userId, res);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    void notificationHub.remove(userId, res);
  });
});
