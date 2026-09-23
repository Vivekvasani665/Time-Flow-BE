import type { Request, Response } from 'express';
import { ok } from '../../common/http/response';
import { getRequestContext } from '../../common/utils/request-context';
import type { ActivityOrigin } from '../activity-logs/activity.service';
import { completeResetSchema, listLatestQuerySchema, userIdParam, verifyTokenQuerySchema } from './password-reset.schemas';
import { passwordResetService } from './password-reset.service';

const originOf = (req: Request): ActivityOrigin => ({ actorId: null, ip: req.ip ?? null, userAgent: req.get('user-agent')?.slice(0, 255) ?? null });

export const passwordResetController = {
  async request(req: Request, res: Response) {
    const { userId } = userIdParam.parse(req.params);
    const summary = await passwordResetService.request(getRequestContext(req), userId);
    return ok(res, summary, 'Password reset link sent successfully.');
  },

  async latestForUser(req: Request, res: Response) {
    const { userId } = userIdParam.parse(req.params);
    return ok(res, await passwordResetService.latestForUser(userId));
  },

  async latestForUsers(req: Request, res: Response) {
    const { userIds } = listLatestQuerySchema.parse(req.query);
    return ok(res, await passwordResetService.latestForUsers(userIds));
  },

  async verify(req: Request, res: Response) {
    const { token } = verifyTokenQuerySchema.parse(req.query);
    return ok(res, await passwordResetService.verify(token, originOf(req)));
  },

  async complete(req: Request, res: Response) {
    const { token, newPassword } = completeResetSchema.parse(req.body);
    await passwordResetService.complete(token, newPassword, originOf(req));
    return ok(res, null, 'Password reset successfully.');
  },
};
