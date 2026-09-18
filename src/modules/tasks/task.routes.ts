import { Router } from 'express';
import { authenticate, requirePermission } from '../../common/middleware/authenticate';
import { P } from '../permissions/permission-catalog';
import { taskController } from './task.controller';

export const taskRouter = Router();

taskRouter.use(authenticate);
taskRouter.get('/', requirePermission(P['tasks.view']), taskController.list);
taskRouter.post('/', requirePermission(P['tasks.create']), taskController.create);
taskRouter.get('/:id', requirePermission(P['tasks.view']), taskController.get);
taskRouter.patch('/:id', requirePermission(P['tasks.update']), taskController.update);
taskRouter.delete('/:id', requirePermission(P['tasks.delete']), taskController.remove);
