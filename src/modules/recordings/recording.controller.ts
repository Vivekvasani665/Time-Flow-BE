import type { Request, Response } from 'express';
import { created, ok, paginated } from '../../common/http/response';
import { getRequestContext, requireAuth } from '../../common/utils/request-context';
import { uuidParam } from '../../common/utils/validation';
import { completeUploadSchema, createUploadSchema, listRecordingsQuerySchema } from './recording.schemas';
import { recordingService } from './recording.service';

/** Responses carry signed URLs scoped to the caller: never cache them in a shared cache. */
const privateNoStore = (res: Response) => res.setHeader('Cache-Control', 'private, no-store');

export const recordingController = {
  async list(req: Request, res: Response) {
    const query = listRecordingsQuerySchema.parse(req.query);
    const { items, meta } = await recordingService.list(requireAuth(req), query);
    privateNoStore(res);
    return paginated(res, items, meta);
  },
  async get(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    privateNoStore(res);
    return ok(res, await recordingService.get(requireAuth(req), id));
  },
  async createUpload(req: Request, res: Response) {
    const input = createUploadSchema.parse(req.body);
    privateNoStore(res);
    return created(res, await recordingService.createUpload(getRequestContext(req), input));
  },
  async completeUpload(req: Request, res: Response) {
    const input = completeUploadSchema.parse(req.body);
    privateNoStore(res);
    return created(res, await recordingService.completeUpload(getRequestContext(req), input), 'Recording saved');
  },
  async remove(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    await recordingService.remove(getRequestContext(req), id);
    return ok(res, null, 'Recording deleted');
  },
};
