import type { Request, Response } from 'express';
import { created, ok, paginated } from '../../common/http/response';
import { getRequestContext } from '../../common/utils/request-context';
import { uuidParam } from '../../common/utils/validation';
import type { ActivityOrigin } from '../activity-logs/activity.service';
import { acceptInvitationSchema, createInvitationSchema, listInvitationsQuerySchema, verifyInvitationQuerySchema } from './invitation.schemas';
import { invitationService } from './invitation.service';

const originOf = (req: Request): ActivityOrigin => ({ actorId: null, ip: req.ip ?? null, userAgent: req.get('user-agent')?.slice(0, 255) ?? null });

export const invitationController = {
  async create(req: Request, res: Response) {
    const input = createInvitationSchema.parse(req.body);
    return created(res, await invitationService.create(getRequestContext(req), input), 'Invitation link generated. Copy it and share it with the user.');
  },

  async list(req: Request, res: Response) {
    const query = listInvitationsQuerySchema.parse(req.query);
    const { items, meta } = await invitationService.list(query);
    return paginated(res, items, meta);
  },

  async revoke(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    return ok(res, await invitationService.revoke(getRequestContext(req), id), 'Invitation revoked.');
  },

  async verify(req: Request, res: Response) {
    const { token } = verifyInvitationQuerySchema.parse(req.query);
    return ok(res, await invitationService.verify(token, originOf(req)));
  },

  async accept(req: Request, res: Response) {
    const input = acceptInvitationSchema.parse(req.body);
    return ok(res, await invitationService.accept(input, originOf(req)), 'Password set successfully. You can now log in.');
  },
};
