import { Router } from 'express';
import { authenticate, requireSuperAdmin } from '../../common/middleware/authenticate';
import { rateLimit } from '../../common/middleware/rate-limit';
import { passwordResetController } from './password-reset.controller';

// Each send emails a real inbox, so it is budgeted per admin rather than per IP.
const sendLimiter = rateLimit({
  name: 'password-reset-send',
  limit: 10,
  windowSeconds: 10 * 60,
  message: 'Too many password reset emails sent. Please wait a few minutes and try again.',
  identify: (req) => req.auth?.id ?? req.ip ?? 'unknown',
});

// Tokens are 256-bit, so this is about noise rather than guessing.
const verifyLimiter = rateLimit({ name: 'password-reset-verify', limit: 30, windowSeconds: 60 });

const completeLimiter = rateLimit({
  name: 'password-reset-complete',
  limit: 10,
  windowSeconds: 15 * 60,
  message: 'Too many password reset attempts. Please wait a few minutes and try again.',
});

/** Super Admin only — mounted at /api/admin. */
export const adminPasswordResetRouter = Router();
adminPasswordResetRouter.use(authenticate, requireSuperAdmin);
adminPasswordResetRouter.get('/password-reset-requests', passwordResetController.latestForUsers);
adminPasswordResetRouter.get('/users/:userId/password-reset', passwordResetController.latestForUser);
adminPasswordResetRouter.post('/users/:userId/password-reset', sendLimiter, passwordResetController.request);

/** Public: the member holds a link, not a session. Mounted under /api/auth. */
export const publicPasswordResetRouter = Router();
publicPasswordResetRouter.get('/verify', verifyLimiter, passwordResetController.verify);
publicPasswordResetRouter.post('/', completeLimiter, passwordResetController.complete);
