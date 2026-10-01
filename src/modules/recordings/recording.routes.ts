import { Router } from 'express';
import { authenticate } from '../../common/middleware/authenticate';
import { rateLimit } from '../../common/middleware/rate-limit';
import { recordingController } from './recording.controller';

/**
 * Screen and webcam recordings. Recording happens entirely in the browser; the
 * finished file goes straight to object storage through a signed URL, and only
 * metadata comes through here. Open to every signed-in user — what each person
 * can see and delete is scoped in the service.
 */
export const recordingRouter = Router();

recordingRouter.use(authenticate);
recordingRouter.get('/', recordingController.list);
recordingRouter.post(
  '/upload-url',
  // Each URL lets the caller write up to RECORDING_MAX_BYTES, so issuing them is metered per user.
  rateLimit({ name: 'recording-upload', limit: 30, windowSeconds: 3600, identify: (req) => req.auth?.id ?? req.ip ?? 'unknown' }),
  recordingController.createUpload,
);
recordingRouter.post('/complete', recordingController.completeUpload);
recordingRouter.get('/:id', recordingController.get);
recordingRouter.delete('/:id', recordingController.remove);
