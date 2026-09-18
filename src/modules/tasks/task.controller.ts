import type { Request, Response } from 'express';
import { created, ok, paginated } from '../../common/http/response';
import { getRequestContext, requireAuth } from '../../common/utils/request-context';
import { uuidParam } from '../../common/utils/validation';
import { createTaskSchema, listTasksQuerySchema, updateTaskSchema } from './task.schemas';
import { taskService } from './task.service';

export const taskController = {
  async list(req: Request, res: Response) {
    const { items, meta } = await taskService.list(requireAuth(req), listTasksQuerySchema.parse(req.query));
    return paginated(res, items, meta);
  },
  async get(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    return ok(res, await taskService.get(requireAuth(req), id));
  },
  async create(req: Request, res: Response) {
    const input = createTaskSchema.parse(req.body);
    return created(res, await taskService.create(getRequestContext(req), input), 'Task created successfully');
  },
  async update(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    const input = updateTaskSchema.parse(req.body);
    return ok(res, await taskService.update(getRequestContext(req), id, input), 'Task updated successfully');
  },
  async remove(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    await taskService.remove(getRequestContext(req), id);
    return ok(res, null, 'Task deleted successfully');
  },
};
