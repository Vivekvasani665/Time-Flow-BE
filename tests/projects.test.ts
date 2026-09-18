import { beforeAll, describe, expect, it } from 'vitest';
import { api, loginAs, unique, userId, type Session } from './helpers';

let superadmin: Session;
let manager: Session;
let employee: Session;
let zoeId: string;

beforeAll(async () => {
  [superadmin, manager, employee] = await Promise.all([loginAs('superadmin'), loginAs('manager'), loginAs('employee')]);
  zoeId = await userId('zoe.chen@timeflow.dev');
});

const newProject = (overrides: Record<string, unknown> = {}) => ({
  name: unique('Quest'),
  description: 'Boss level',
  status: 'ACTIVE',
  priority: 'HIGH',
  startDate: '2026-10-01',
  endDate: '2026-12-31',
  managerId: manager.userId,
  memberIds: [employee.userId],
  ...overrides,
});

describe('Project CRUD', () => {
  it('creates, reads, updates and deletes a project', async () => {
    const created = await superadmin.auth(api().post('/api/projects')).send(newProject());
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'ACTIVE', priority: 'HIGH', manager: { id: manager.userId }, taskStats: { total: 0, completed: 0 } });
    expect(created.body.data.members.map((m: { id: string }) => m.id)).toEqual([employee.userId]);
    const id = created.body.data.id;

    expect((await superadmin.auth(api().get(`/api/projects/${id}`))).body.data.name).toBe(created.body.data.name);

    const updated = await manager.auth(api().patch(`/api/projects/${id}`)).send({ status: 'ON_HOLD', memberIds: [employee.userId, zoeId] });
    expect(updated.status).toBe(200);
    expect(updated.body.data.status).toBe('ON_HOLD');
    expect(updated.body.data.members).toHaveLength(2);

    expect((await superadmin.auth(api().delete(`/api/projects/${id}`))).status).toBe(200);
    expect((await superadmin.auth(api().get(`/api/projects/${id}`))).status).toBe(404);
  });

  it('validates date ordering and required fields', async () => {
    const res = await superadmin.auth(api().post('/api/projects')).send(newProject({ startDate: '2026-12-01', endDate: '2026-01-01' }));
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe('endDate');

    const missing = await superadmin.auth(api().post('/api/projects')).send({ name: 'x' });
    expect(missing.status).toBe(400);
  });

  it('filters, searches, sorts and paginates', async () => {
    const res = await superadmin.auth(api().get('/api/projects')).query({ status: 'ACTIVE', sortBy: 'name', sortOrder: 'asc', limit: 2 });
    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBe(2);
    expect(res.body.data.every((p: { status: string }) => p.status === 'ACTIVE')).toBe(true);
  });
});

describe('Project scoping & authorization', () => {
  it('employees only see projects they belong to', async () => {
    const res = await employee.auth(api().get('/api/projects')).query({ limit: 100 });
    expect(res.status).toBe(200);
    const names = res.body.data.map((p: { name: string }) => p.name);
    expect(names).toContain('Website Redesign');
    expect(names).not.toContain('Mobile App Launch');

    const hidden = await superadmin.auth(api().get('/api/projects')).query({ search: 'Mobile App Launch' });
    expect((await employee.auth(api().get(`/api/projects/${hidden.body.data[0].id}`))).status).toBe(404);
  });

  it('employees cannot create projects', async () => {
    expect((await employee.auth(api().post('/api/projects')).send(newProject())).status).toBe(403);
  });

  it('a manager cannot modify a project they do not manage', async () => {
    const other = await superadmin.auth(api().post('/api/projects')).send(newProject({ managerId: superadmin.userId, memberIds: [manager.userId] }));
    const res = await manager.auth(api().patch(`/api/projects/${other.body.data.id}`)).send({ name: 'Mine now' });
    expect(res.status).toBe(403);
  });
});

describe('Project list caching (Redis)', () => {
  it('serves MISS then HIT, and invalidates on create/update/delete', async () => {
    const q = { search: 'Quest', limit: 50 };
    const first = await superadmin.auth(api().get('/api/projects')).query(q);
    const second = await superadmin.auth(api().get('/api/projects')).query(q);
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body.meta.total).toBe(first.body.meta.total);

    const created = await superadmin.auth(api().post('/api/projects')).send(newProject());
    const afterCreate = await superadmin.auth(api().get('/api/projects')).query(q);
    expect(afterCreate.headers['x-cache']).toBe('MISS');
    expect(afterCreate.body.meta.total).toBe(first.body.meta.total + 1);

    await superadmin.auth(api().get('/api/projects')).query(q).expect('X-Cache', 'HIT');
    await superadmin.auth(api().patch(`/api/projects/${created.body.data.id}`)).send({ priority: 'LOW' }).expect(200);
    const afterUpdate = await superadmin.auth(api().get('/api/projects')).query(q);
    expect(afterUpdate.headers['x-cache']).toBe('MISS');

    await superadmin.auth(api().delete(`/api/projects/${created.body.data.id}`)).expect(200);
    const afterDelete = await superadmin.auth(api().get('/api/projects')).query(q);
    expect(afterDelete.headers['x-cache']).toBe('MISS');
    expect(afterDelete.body.meta.total).toBe(first.body.meta.total);
  });

  it('keeps cache entries separate per data scope', async () => {
    const all = await superadmin.auth(api().get('/api/projects')).query({ limit: 100 });
    const scoped = await employee.auth(api().get('/api/projects')).query({ limit: 100 });
    expect(scoped.body.meta.total).toBeLessThan(all.body.meta.total);
  });
});
