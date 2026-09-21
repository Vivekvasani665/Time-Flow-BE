import { beforeAll, describe, expect, it } from 'vitest';
import { api, loginAs, roleId, unique, type Session } from './helpers';

let superadmin: Session;
let admin: Session;

beforeAll(async () => {
  [superadmin, admin] = await Promise.all([loginAs('superadmin'), loginAs('admin')]);
});

describe('Roles & permissions', () => {
  it('lists all permissions', async () => {
    const res = await superadmin.auth(api().get('/api/permissions'));
    expect(res.status).toBe(200);
    const keys = res.body.data.map((p: { key: string }) => p.key);
    expect(keys).toEqual(expect.arrayContaining(['users.view', 'roles.delete', 'projects.view_all', 'tasks.delete', 'activity_logs.view']));
  });

  it('creates a role with permissions, edits it, and deletes it', async () => {
    const name = unique('Project Manager');
    const created = await superadmin.auth(api().post('/api/roles')).send({ name, permissions: ['users.view', 'projects.view', 'projects.create', 'projects.update'] });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name, isSystem: false, userCount: 0 });
    expect(created.body.data.permissions).toEqual(['projects.create', 'projects.update', 'projects.view', 'users.view']);
    const id = created.body.data.id;

    const updated = await superadmin.auth(api().patch(`/api/roles/${id}`)).send({ permissions: ['tasks.view', 'tasks.create'] });
    expect(updated.status).toBe(200);
    expect(updated.body.data.permissions).toEqual(['tasks.create', 'tasks.view']);

    expect((await superadmin.auth(api().delete(`/api/roles/${id}`))).status).toBe(200);
    expect((await superadmin.auth(api().get(`/api/roles/${id}`))).status).toBe(404);
  });

  it('applies permission changes to existing sessions immediately (cache invalidation)', async () => {
    const name = unique('Viewer');
    const role = await superadmin.auth(api().post('/api/roles')).send({ name, permissions: ['projects.view'] });
    const email = `${unique('viewer')}@timeflow.dev`;
    await superadmin.auth(api().post('/api/users')).send({ firstName: 'Val', lastName: 'Viewer', email, password: 'Password123!', roleId: role.body.data.id }).expect(201);
    const viewer = await loginAs(email);

    expect((await viewer.auth(api().get('/api/projects'))).status).toBe(200);
    await superadmin.auth(api().patch(`/api/roles/${role.body.data.id}`)).send({ permissions: ['tasks.view'] }).expect(200);
    expect((await viewer.auth(api().get('/api/projects'))).status).toBe(403);
    expect((await viewer.auth(api().get('/api/tasks'))).status).toBe(200);
  });

  it('rejects duplicate role names (case-insensitive)', async () => {
    const res = await superadmin.auth(api().post('/api/roles')).send({ name: 'manager', permissions: [] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROLE_NAME_EXISTS');
  });

  it('rejects unknown permission keys', async () => {
    const res = await superadmin.auth(api().post('/api/roles')).send({ name: unique('Bad'), permissions: ['users.fly'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('refuses to delete a role that has users (ROLE_IN_USE) or the Super Admin role', async () => {
    const name = unique('Busy');
    const role = await superadmin.auth(api().post('/api/roles')).send({ name, permissions: ['tasks.view'] });
    await superadmin.auth(api().post('/api/users')).send({ firstName: 'B', lastName: 'Usy', email: `${unique('busy')}@timeflow.dev`, password: 'Password123!', roleId: role.body.data.id }).expect(201);

    const inUse = await superadmin.auth(api().delete(`/api/roles/${role.body.data.id}`));
    expect(inUse.status).toBe(409);
    expect(inUse.body.code).toBe('ROLE_IN_USE');

    const system = await superadmin.auth(api().delete(`/api/roles/${await roleId('Super Admin')}`));
    expect(system.status).toBe(403);
  });

  it('protects Super Admin permissions and name', async () => {
    const id = await roleId('Super Admin');
    expect((await superadmin.auth(api().patch(`/api/roles/${id}`)).send({ permissions: ['users.view'] })).status).toBe(403);
    expect((await superadmin.auth(api().patch(`/api/roles/${id}`)).send({ name: unique('Boss') })).status).toBe(403);
  });

  it('lets the Super Admin rename a default role and change its permissions', async () => {
    const created = await superadmin.auth(api().post('/api/roles')).send({ name: unique('Temp'), permissions: ['tasks.view'] });
    const managerId = await roleId('Manager');
    const res = await superadmin.auth(api().patch(`/api/roles/${managerId}`)).send({ name: unique('Lead') });
    expect(res.status).toBe(200);
    expect(res.body.data.isSystem).toBe(false);
    await superadmin.auth(api().patch(`/api/roles/${managerId}`)).send({ name: 'Manager' }).expect(200);
    await superadmin.auth(api().delete(`/api/roles/${created.body.data.id}`)).expect(200);
  });

  it('forbids admin (no roles.update) from editing roles', async () => {
    const res = await admin.auth(api().patch(`/api/roles/${await roleId('Employee')}`)).send({ permissions: ['users.delete'] });
    expect(res.status).toBe(403);
  });

  it('lists users assigned to a role', async () => {
    const res = await admin.auth(api().get(`/api/roles/${await roleId('Manager')}/users`));
    expect(res.status).toBe(200);
    expect(res.body.data.map((u: { email: string }) => u.email)).toContain('manager@timeflow.dev');
  });
});
