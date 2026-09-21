import type { Request, Response } from 'express';
import { created, ok, paginated } from '../../common/http/response';
import { getRequestContext, requireAuth } from '../../common/utils/request-context';
import { uuidParam } from '../../common/utils/validation';
import { createProjectSchema, listProjectsQuerySchema, updateProjectSchema } from './project.schemas';
import { projectService } from './project.service';

export const projectController = {
  async list(req: Request, res: Response) {
    const query = listProjectsQuerySchema.parse(req.query);
    const { value, hit } = await projectService.list(requireAuth(req), query);
    res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
    return paginated(res, value.items, value.meta);
  },
  async stats(req: Request, res: Response) {
    const { value, hit } = await projectService.stats(requireAuth(req));
    res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
    return ok(res, value);
  },
  async get(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    return ok(res, await projectService.get(requireAuth(req), id));
  },
  async create(req: Request, res: Response) {
    const input = createProjectSchema.parse(req.body);
    return created(res, await projectService.create(getRequestContext(req), input), 'Project created successfully');
  },
  async update(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    const input = updateProjectSchema.parse(req.body);
    return ok(res, await projectService.update(getRequestContext(req), id, input), 'Project updated successfully');
  },
  async remove(req: Request, res: Response) {
    const { id } = uuidParam.parse(req.params);
    await projectService.remove(getRequestContext(req), id);
    return ok(res, null, 'Project deleted successfully');
  },
};
