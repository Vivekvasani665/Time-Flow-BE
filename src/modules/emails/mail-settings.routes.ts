import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ok } from '../../common/http/response';
import { authenticate, requirePermission } from '../../common/middleware/authenticate';
import { requireAuth } from '../../common/utils/request-context';
import { emailSchema } from '../../common/utils/validation';
import { P } from '../permissions/permission-catalog';
import { mailSettingsService } from './mail-settings.service';

/**
 * The organisation's outgoing mail account, configurable in the UI so nobody
 * has to edit .env on the server. Responses never include the password.
 */
const providerSchema = z.enum(['gmail']);

const saveSchema = z.object({
  provider: providerSchema.default('gmail'),
  username: emailSchema,
  // Absent on edit = keep the stored password. Gmail app passwords are 16 chars;
  // spaces are stripped because Google displays them in groups of four.
  password: z
    .string()
    .transform((v) => v.replace(/\s+/g, ''))
    .refine((v) => v.length === 0 || v.length === 16, 'An app password is 16 characters')
    .optional(),
  fromName: z.string().trim().min(1).max(80).default('TimeFlow'),
  enabled: z.boolean().default(true),
});

const testSchema = saveSchema.pick({ provider: true, username: true, password: true });

export const mailSettingsRouter = Router();

mailSettingsRouter.use(authenticate, requirePermission(P['emails.configure']));

mailSettingsRouter.get('/', async (_req: Request, res: Response) => ok(res, await mailSettingsService.get()));

mailSettingsRouter.post('/test', async (req: Request, res: Response) => {
  const input = testSchema.parse(req.body);
  const result = await mailSettingsService.test({ ...input, password: input.password || undefined });
  return ok(res, result, result.ok ? 'Connection successful' : 'Connection failed');
});

mailSettingsRouter.patch('/', async (req: Request, res: Response) => {
  const auth = requireAuth(req);
  const input = saveSchema.parse(req.body);
  const saved = await mailSettingsService.save({ ...input, password: input.password || undefined }, auth.id);
  return ok(res, saved, 'Email account saved');
});

mailSettingsRouter.delete('/', async (req: Request, res: Response) => {
  const auth = requireAuth(req);
  return ok(res, await mailSettingsService.disable(auth.id), 'Falling back to server configuration');
});
