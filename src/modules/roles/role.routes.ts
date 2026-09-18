import { Router } from 'express';
import { authenticate, requirePermission } from '../../common/middleware/authenticate';
import { P } from '../permissions/permission-catalog';
import { roleController } from './role.controller';

export const roleRouter = Router();

roleRouter.use(authenticate);
roleRouter.get('/', requirePermission(P['roles.view']), roleController.list);
roleRouter.post('/', requirePermission(P['roles.create']), roleController.create);
roleRouter.get('/:id', requirePermission(P['roles.view']), roleController.get);
roleRouter.get('/:id/users', requirePermission(P['roles.view']), roleController.users);
roleRouter.patch('/:id', requirePermission(P['roles.update']), roleController.update);
roleRouter.delete('/:id', requirePermission(P['roles.delete']), roleController.remove);
