import type { Request, Response } from 'express';
import { created, ok, paginated } from '../../common/http/response';
import { getRequestContext } from '../../common/utils/request-context';
import { uuidParam } from '../../common/utils/validation';
import {
  createUserSchema,
  listUsersQuerySchema,
  updateUserSchema,
  updateUserStatusSchema,
  userOptionsQuerySchema,
} from './user.schemas';
import { userService } from './user.service';

export const userController = {
  async list(req: Request, res: Response) {
    const query = listUsersQuerySchema.parse(req.query);
    const { items, meta } = await userService.list(query);
    return paginated(res, items, meta);
  },

  async options(req: Request, res: Response) {
    const { search } = userOptionsQuerySchema.parse(req.query);
    return ok(res, await userService.options(search));
  },

  async get(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    return ok(res, await userService.get(id));
  },

  async create(req: Request, res: Response) {
    const input = createUserSchema.parse(req.body);
    const user = await userService.create(getRequestContext(req), input);
    return created(res, user, 'User created successfully');
  },

  async resetTwoFactor(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    await userService.resetTwoFactor(getRequestContext(req), id);
    return ok(res, null, 'Two-factor authentication reset');
  },

  async update(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    const input = updateUserSchema.parse(req.body);
    return ok(res, await userService.update(getRequestContext(req), id, input), 'User updated successfully');
  },

  async updateStatus(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    const { status } = updateUserStatusSchema.parse(req.body);
    const user = await userService.update(getRequestContext(req), id, { status });
    return ok(res, user, status === 'ACTIVE' ? 'User activated' : 'User deactivated');
  },

  async remove(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    await userService.remove(getRequestContext(req), id);
    return ok(res, null, 'User deleted successfully');
  },
};
