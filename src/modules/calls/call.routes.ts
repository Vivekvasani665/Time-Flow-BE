import { Router } from 'express';
import { authenticate } from '../../common/middleware/authenticate';
import { callController } from './call.controller';

/**
 * Call history and set-up data. Starting, answering and ending calls happens
 * over the chat socket (call.socket.ts); like the team-wide chat, calling is
 * open to every signed-in, active user.
 */
export const callRouter = Router();

callRouter.use(authenticate);
callRouter.get('/', callController.history);
callRouter.get('/contacts', callController.contacts);
callRouter.get('/ice-servers', callController.iceServers);
