import { Router } from 'express';
import { authenticate } from '../../common/middleware/authenticate';
import { chatController } from './chat.controller';

/** Global chat is open to every signed-in, active user; ownership is checked per message in the service. */
export const chatRouter = Router();

chatRouter.use(authenticate);
chatRouter.get('/messages', chatController.list);
chatRouter.post('/messages', chatController.create);
chatRouter.get('/messages/:id/replies', chatController.replies);
chatRouter.patch('/messages/:id', chatController.update);
chatRouter.delete('/messages/:id', chatController.remove);
chatRouter.post('/messages/:id/reactions', chatController.addReaction);
chatRouter.delete('/messages/:id/reactions/:emoji', chatController.removeReaction);
chatRouter.get('/unread', chatController.unread);
chatRouter.post('/read', chatController.markRead);
chatRouter.get('/online', chatController.online);
