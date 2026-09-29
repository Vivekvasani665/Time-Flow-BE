import type { Request, Response } from 'express';
import { created, cursorPaginated, ok } from '../../common/http/response';
import { requireAuth } from '../../common/utils/request-context';
import { uuidParam } from '../../common/utils/validation';
import { chatRealtime } from './chat.realtime';
import { createMessageSchema, listMessagesQuerySchema, reactionParams, reactionSchema, updateMessageSchema } from './chat.schemas';
import { chatService } from './chat.service';

export const chatController = {
  async list(req: Request, res: Response) {
    const query = listMessagesQuerySchema.parse(req.query);
    const { items, hasMore, nextCursor } = await chatService.list(query);
    return cursorPaginated(res, items, { limit: query.limit, hasMore, nextCursor });
  },
  async replies(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    return ok(res, await chatService.replies(id));
  },
  async create(req: Request, res: Response) {
    const input = createMessageSchema.parse(req.body);
    return created(res, await chatService.create(requireAuth(req), input), 'Message sent');
  },
  async update(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    const { content } = updateMessageSchema.parse(req.body);
    return ok(res, await chatService.update(requireAuth(req), id, content), 'Message updated');
  },
  async remove(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    return ok(res, await chatService.remove(requireAuth(req), id), 'Message deleted');
  },
  async addReaction(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    const { emoji } = reactionSchema.parse(req.body);
    return ok(res, await chatService.addReaction(requireAuth(req), id, emoji));
  },
  async removeReaction(req: Request, res: Response) {
    const { id, emoji } = reactionParams.parse(req.params);
    return ok(res, await chatService.removeReaction(requireAuth(req), id, emoji));
  },
  async unread(req: Request, res: Response) {
    return ok(res, await chatService.unreadCount(requireAuth(req)));
  },
  async markRead(req: Request, res: Response) {
    return ok(res, await chatService.markRead(requireAuth(req)));
  },
  async online(_req: Request, res: Response) {
    return ok(res, await chatRealtime.onlineUsers());
  },
};
