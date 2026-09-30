import Groq from 'groq-sdk';
import { Router, type Request, type Response } from 'express';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { AppError, BadRequestError } from '../../common/errors';
import { ok } from '../../common/http/response';
import { authenticate } from '../../common/middleware/authenticate';
import { getRequestContext } from '../../common/utils/request-context';
import { attachmentUpload, readDocument } from './assistant.attachments';
import { ASSISTANT_DISABLED_MESSAGE, ASSISTANT_NAME, assistantChatSchema, assistantService, type AssistantEvent } from './assistant.service';

export const assistantRouter = Router();
assistantRouter.use(authenticate);

/**
 * Reads the text out of a document for the next question. Nothing is kept:
 * the client holds the text and sends it with the conversation.
 */
assistantRouter.post('/attachments', attachmentUpload.single('file'), async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) throw new BadRequestError('No file uploaded', 'VALIDATION_ERROR', [{ path: 'file', message: 'File is required' }]);
  // Multer decodes multipart filenames as Latin-1; browsers send UTF-8.
  const originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
  return ok(res, await readDocument({ originalname, buffer: file.buffer }));
});

assistantRouter.get('/status', (_req: Request, res: Response) => {
  return ok(res, { enabled: assistantService.enabled(), name: ASSISTANT_NAME, model: env.ASSISTANT_MODEL });
});

/** Friendly text for a failure after streaming has started (the status code is already sent). */
function describe(err: unknown): string {
  // Groq's free tier has per-minute limits; this is the usual cause of a refusal.
  if (err instanceof Groq.RateLimitError) return 'The assistant is busy right now (usage limit reached). Please try again in a minute.';
  if (err instanceof Groq.AuthenticationError) return "The assistant's Groq API key is invalid or revoked. Please tell an administrator.";
  // Groq answers 413 when a request is over the plan's tokens-per-minute size, usually a big attached file.
  if (err instanceof Groq.APIError && err.status === 413) return 'That was too much text for the assistant at once. Try a shorter file, or ask about one part of it.';
  if (err instanceof Groq.APIConnectionError) return "The assistant couldn't be reached. Please try again.";
  if (err instanceof Groq.APIError && (err.status ?? 0) >= 500) return 'The assistant is having trouble right now. Please try again shortly.';
  return 'Something went wrong while answering. Please try again.';
}

/**
 * One assistant turn, streamed as Server-Sent Events: `delta` text chunks,
 * `status` lines while tools run, then `done` (or `error`). Validation, the
 * disabled check and the rate limit are answered as normal JSON errors first.
 */
assistantRouter.post('/chat', async (req: Request, res: Response) => {
  const ctx = getRequestContext(req);
  const { actor } = ctx;
  const input = assistantChatSchema.parse(req.body);
  if (!assistantService.enabled()) {
    throw new AppError(503, 'ASSISTANT_DISABLED', ASSISTANT_DISABLED_MESSAGE);
  }
  await assistantService.assertWithinBudget(actor);

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Stop paying for tokens nobody will read once the user leaves.
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });
  const emit = (event: AssistantEvent) => {
    if (!res.writableEnded) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  try {
    await assistantService.reply(ctx, input, emit, abort.signal);
  } catch (err) {
    if (abort.signal.aborted) return;
    logger.error({ err, userId: actor.id }, 'assistant reply failed');
    emit({ type: 'error', message: describe(err) });
    emit({ type: 'done' });
  } finally {
    res.end();
  }
});
