import type { Request, Response } from 'express';
import { ok } from '../../common/http/response';
import { requireAuth } from '../../common/utils/request-context';
import { callHistoryQuerySchema } from './call.schemas';
import { callService } from './call.service';

export const callController = {
  async history(req: Request, res: Response) {
    return ok(res, await callService.history(requireAuth(req), callHistoryQuerySchema.parse(req.query)));
  },
  async contacts(req: Request, res: Response) {
    return ok(res, await callService.contacts(requireAuth(req)));
  },
  iceServers(req: Request, res: Response) {
    // Per-user TURN credentials: never cache them in a shared cache.
    res.setHeader('Cache-Control', 'private, no-store');
    return ok(res, callService.iceServers(requireAuth(req)));
  },
};
