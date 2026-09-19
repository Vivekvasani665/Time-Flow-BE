import { Router } from 'express';
import { env } from '../../config/env';
import { authenticate } from '../../common/middleware/authenticate';
import { rateLimit } from '../../common/middleware/rate-limit';
import { authController } from './auth.controller';

const loginLimiter = rateLimit({
  name: 'login',
  limit: env.RATE_LIMIT_LOGIN_MAX,
  windowSeconds: env.RATE_LIMIT_LOGIN_WINDOW_SECONDS,
  message: 'Too many login attempts. Please wait a minute and try again.',
});

const registerLimiter = rateLimit({
  name: 'register',
  limit: env.RATE_LIMIT_LOGIN_MAX,
  windowSeconds: env.RATE_LIMIT_LOGIN_WINDOW_SECONDS,
  message: 'Too many sign-up attempts. Please wait a minute and try again.',
});

const refreshLimiter = rateLimit({ name: 'refresh', limit: 30, windowSeconds: 60 });

export const authRouter = Router();

authRouter.post('/login', loginLimiter, authController.login);
authRouter.post('/register', registerLimiter, authController.register);
authRouter.post('/refresh', refreshLimiter, authController.refresh);
authRouter.post('/logout', authController.logout);
authRouter.get('/me', authenticate, authController.me);
// Your own UI settings — no permission, every signed-in user has them.
authRouter.patch('/me/preferences', authenticate, authController.updatePreferences);
// Sessions: your own signed-in devices. No permission — these are yours.
authRouter.get('/me/sessions', authenticate, authController.listSessions);
authRouter.post('/me/sessions/revoke-others', authenticate, authController.revokeOtherSessions);
authRouter.delete('/me/sessions/:id', authenticate, authController.revokeSession);
