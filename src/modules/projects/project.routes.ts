import { Router } from 'express';
import { authenticate, requirePermission } from '../../common/middleware/authenticate';
import { P } from '../permissions/permission-catalog';
import { projectController } from './project.controller';

export const projectRouter = Router();

projectRouter.use(authenticate);
projectRouter.get('/', requirePermission(P['projects.view']), projectController.list);
projectRouter.post('/', requirePermission(P['projects.create']), projectController.create);
projectRouter.get('/:id', requirePermission(P['projects.view']), projectController.get);
projectRouter.patch('/:id', requirePermission(P['projects.update']), projectController.update);
projectRouter.delete('/:id', requirePermission(P['projects.delete']), projectController.remove);
