import path from 'node:path';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { env, isTest } from './config/env';
import { httpLogger } from './common/middleware/http-logger';
import { errorHandler, notFoundHandler } from './common/middleware/error-handler';
import { rateLimit } from './common/middleware/rate-limit';
import { authenticate, requirePermission } from './common/middleware/authenticate';
import { openApiDocument } from './docs/openapi';
import { BULL_BOARD_PATH, createBullBoardRouter } from './admin/bull-board';
import { healthRouter } from './modules/health/health.routes';
import { authRouter } from './modules/auth/auth.routes';
import { userRouter } from './modules/users/user.routes';
import { roleRouter } from './modules/roles/role.routes';
import { permissionRouter } from './modules/permissions/permission.routes';
import { projectRouter } from './modules/projects/project.routes';
import { taskRouter } from './modules/tasks/task.routes';
import { activityLogRouter } from './modules/activity-logs/activity-log.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { notificationRouter } from './modules/notifications/notification.routes';
import { uploadRouter } from './modules/uploads/upload.routes';
import { queueRouter } from './modules/queues/queue.routes';
import { emailRouter } from './modules/emails/email.routes';
import { mailSettingsRouter } from './modules/emails/mail-settings.routes';
import { adminPasswordResetRouter, publicPasswordResetRouter } from './modules/password-resets/password-reset.routes';
import { P } from './modules/permissions/permission-catalog';

export type AppOptions = { enableBullBoard?: boolean };

export function createApp({ enableBullBoard = !isTest }: AppOptions = {}): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(httpLogger);
  app.use('/health', healthRouter);

  // Browser-rendered tooling needs inline scripts/styles; everything else gets strict defaults.
  const relaxedHelmet = helmet({ contentSecurityPolicy: false });
  app.use('/api/docs', relaxedHelmet, swaggerUi.serve, swaggerUi.setup(openApiDocument, { customSiteTitle: 'TimeFlow API' }));
  app.get('/api/docs.json', (_req, res) => {
    res.json(openApiDocument);
  });
  if (enableBullBoard) {
    app.use(BULL_BOARD_PATH, relaxedHelmet, cookieParser(), authenticate, requirePermission(P['queues.view']), createBullBoardRouter());
  }

  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || env.CORS_ORIGINS.includes(origin)),
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'X-Cache', 'X-Session-Expires-At', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use(
    '/uploads',
    helmet.crossOriginResourcePolicy({ policy: 'cross-origin' }),
    express.static(path.resolve(env.UPLOAD_DIR), { index: false, dotfiles: 'deny', maxAge: '7d', fallthrough: false }),
  );

  app.use('/api', rateLimit({ name: 'api', limit: env.RATE_LIMIT_API_MAX, windowSeconds: env.RATE_LIMIT_API_WINDOW_SECONDS }));
  app.use('/api/auth/password-reset', publicPasswordResetRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminPasswordResetRouter);
  app.use('/api/users', userRouter);
  app.use('/api/roles', roleRouter);
  app.use('/api/permissions', permissionRouter);
  app.use('/api/projects', projectRouter);
  app.use('/api/tasks', taskRouter);
  app.use('/api/activity-logs', activityLogRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/notifications', notificationRouter);
  app.use('/api/uploads', uploadRouter);
  app.use('/api/queues', queueRouter);
  // Before /api/emails so the literal path is not eaten by /:id.
  app.use('/api/mail-settings', mailSettingsRouter);
  app.use('/api/emails', emailRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
