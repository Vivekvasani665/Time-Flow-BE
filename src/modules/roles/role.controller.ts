import type { Request, Response } from 'express';
import { created, ok, paginated } from '../../common/http/response';
import { getRequestContext } from '../../common/utils/request-context';
import { uuidParam } from '../../common/utils/validation';
import { createRoleSchema, listRolesQuerySchema, roleUsersQuerySchema, updateRoleSchema } from './role.schemas';
import { roleService } from './role.service';

export const roleController = {
  async list(req: Request, res: Response) {
    const { items, meta } = await roleService.list(listRolesQuerySchema.parse(req.query));
    return paginated(res, items, meta);
  },
  async get(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    return ok(res, await roleService.get(id));
  },
  async users(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    const { items, meta } = await roleService.users(id, roleUsersQuerySchema.parse(req.query));
    return paginated(res, items, meta);
  },
  async create(req: Request, res: Response) {
    const input = createRoleSchema.parse(req.body);
    return created(res, await roleService.create(getRequestContext(req), input), 'Role created successfully');
  },
  async update(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    const input = updateRoleSchema.parse(req.body);
    return ok(res, await roleService.update(getRequestContext(req), id, input), 'Role updated successfully');
  },
  async remove(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    await roleService.remove(getRequestContext(req), id);
    return ok(res, null, 'Role deleted successfully');
  },
};
