import { Router } from 'express';
import { authenticate, requirePermission } from '../../common/middleware/authenticate';
import { P } from '../permissions/permission-catalog';
import { userController } from './user.controller';

export const userRouter = Router();

userRouter.use(authenticate);

// Declared before `/:id` so "options" is not parsed as an id.
userRouter.get('/options', userController.options);
userRouter.get('/', requirePermission(P['users.view']), userController.list);
userRouter.post('/', requirePermission(P['users.create']), userController.create);
userRouter.get('/:id', requirePermission(P['users.view']), userController.get);
userRouter.patch('/:id', requirePermission(P['users.update']), userController.update);
userRouter.patch('/:id/status', requirePermission(P['users.update']), userController.updateStatus);
userRouter.delete('/:id', requirePermission(P['users.delete']), userController.remove);
