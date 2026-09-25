import { Router } from 'express';
import { authenticate, requireSuperAdmin } from '../../common/middleware/authenticate';
import { rateLimit } from '../../common/middleware/rate-limit';
import { invitationController } from './invitation.controller';

const createLimiter = rateLimit({
  name: 'invitation-create',
  limit: 30,
  windowSeconds: 10 * 60,
  message: 'Too many invitations generated. Please wait a few minutes and try again.',
  identify: (req) => req.auth?.id ?? req.ip ?? 'unknown',
});

// Tokens are 256-bit, so this is about noise rather than guessing.
const verifyLimiter = rateLimit({ name: 'invitation-verify', limit: 30, windowSeconds: 60 });

const acceptLimiter = rateLimit({
  name: 'invitation-accept',
  limit: 10,
  windowSeconds: 15 * 60,
  message: 'Too many attempts. Please wait a few minutes and try again.',
});

/** Super Admin only — mounted at /api/admin/invitations. */
export const adminInvitationRouter = Router();
adminInvitationRouter.use(authenticate, requireSuperAdmin);
adminInvitationRouter.get('/', invitationController.list);
adminInvitationRouter.post('/', createLimiter, invitationController.create);
adminInvitationRouter.delete('/:id', invitationController.revoke);

/** Public: the invitee holds a link, not a session. Mounted at /api/auth/invitations. */
export const publicInvitationRouter = Router();
publicInvitationRouter.get('/verify', verifyLimiter, invitationController.verify);
publicInvitationRouter.post('/accept', acceptLimiter, invitationController.accept);
