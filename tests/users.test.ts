import { beforeAll, describe, expect, it } from 'vitest';
import { producers } from '../src/queue/producers';
import { api, loginAs, roleId, unique, uniquePhone, type Session } from './helpers';

let superadmin: Session;
let admin: Session;
let employee: Session;
let employeeRoleId: string;

beforeAll(async () => {
  [superadmin, admin, employee] = await Promise.all([loginAs('superadmin'), loginAs('admin'), loginAs('employee')]);
  employeeRoleId = await roleId('Employee');
});

const newUser = (overrides: Record<string, unknown> = {}) => ({
  firstName: 'Jamie',
  lastName: 'Rivera',
  email: `${unique('jamie')}@timeflow.dev`,
  phone: uniquePhone(),
  password: 'Str0ngPass',
  roleId: employeeRoleId,
  ...overrides,
});

describe('User CRUD', () => {
  it('creates, reads, updates and deletes a user', async () => {
    const body = newUser();
    const created = await admin.auth(api().post('/api/users')).send(body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ success: true, message: 'User created successfully', data: { email: body.email, status: 'ACTIVE', role: { name: 'Employee' } } });
    expect(created.body.data).not.toHaveProperty('passwordHash');
    // Second argument is the acting admin — it owns the message in their Sent folder.
    expect(producers.welcomeEmail).toHaveBeenCalledWith(expect.objectContaining({ email: body.email }), expect.any(String));
    const id = created.body.data.id as string;

    const fetched = await admin.auth(api().get(`/api/users/${id}`));
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.stats).toEqual({ assignedTasks: 0, completedTasks: 0, projects: 0 });

    const updated = await admin.auth(api().patch(`/api/users/${id}`)).send({ firstName: 'Jordan', status: 'INACTIVE' });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ firstName: 'Jordan', status: 'INACTIVE' });

    expect((await admin.auth(api().delete(`/api/users/${id}`))).status).toBe(200);
    expect((await admin.auth(api().get(`/api/users/${id}`))).status).toBe(404);
  });

  it('normalises email case and rejects duplicates with USER_EMAIL_EXISTS', async () => {
    const email = `${unique('dup')}@timeflow.dev`;
    await admin.auth(api().post('/api/users')).send(newUser({ email })).expect(201);
    const res = await admin.auth(api().post('/api/users')).send(newUser({ email: email.toUpperCase() }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'USER_EMAIL_EXISTS', message: 'Email already exists' });
  });

  it('allows re-using the email of a soft-deleted user', async () => {
    const email = `${unique('reuse')}@timeflow.dev`;
    const first = await admin.auth(api().post('/api/users')).send(newUser({ email }));
    await admin.auth(api().delete(`/api/users/${first.body.data.id}`)).expect(200);
    await admin.auth(api().post('/api/users')).send(newUser({ email })).expect(201);
  });

  it('returns field-level validation errors', async () => {
    const res = await admin.auth(api().post('/api/users')).send({ firstName: '', email: 'bad', password: 'short', roleId: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    const paths = res.body.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['firstName', 'lastName', 'email', 'password', 'roleId']));
  });

  it('rejects unknown fields (mass assignment protection)', async () => {
    const res = await admin.auth(api().post('/api/users')).send(newUser({ passwordHash: 'x', tokenVersion: 99 }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('lists with search, filter, sort and pagination', async () => {
    const res = await admin.auth(api().get('/api/users')).query({ search: 'timeflow.dev', status: 'ACTIVE', sortBy: 'email', sortOrder: 'asc', page: 1, limit: 3 });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 3 });
    expect(res.body.meta.total).toBeGreaterThanOrEqual(3);
    const emails = res.body.data.map((u: { email: string }) => u.email);
    expect([...emails].sort()).toEqual(emails);
    expect(res.body.data.every((u: { status: string }) => u.status === 'ACTIVE')).toBe(true);
  });
});

describe('User authorization', () => {
  it('forbids an employee from listing or deleting users (backend-enforced)', async () => {
    expect((await employee.auth(api().get('/api/users'))).status).toBe(403);
    const res = await employee.auth(api().delete(`/api/users/${admin.userId}`));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('prevents privilege escalation: admin cannot create a Super Admin', async () => {
    const res = await admin.auth(api().post('/api/users')).send(newUser({ roleId: await roleId('Super Admin') }));
    expect(res.status).toBe(403);
  });

  it('prevents admin from modifying a higher-privileged user', async () => {
    const res = await admin.auth(api().patch(`/api/users/${superadmin.userId}`)).send({ firstName: 'Hacked' });
    expect(res.status).toBe(403);
  });

  it('prevents users from deleting or deactivating themselves', async () => {
    expect((await superadmin.auth(api().delete(`/api/users/${superadmin.userId}`))).status).toBe(403);
    expect((await superadmin.auth(api().patch(`/api/users/${superadmin.userId}/status`)).send({ status: 'INACTIVE' })).status).toBe(403);
  });
});

describe('User mobile numbers', () => {
  it('refuses a number another user already has, whatever its formatting', async () => {
    const admin = await loginAs('admin');
    const role = await roleId('Employee');
    const body = (phone: string) => ({ firstName: 'Pat', lastName: 'Lee', email: `${unique('phone')}@timeflow.dev`, password: 'Str0ngPass', roleId: role, phone });
    const phone = uniquePhone();
    await admin.auth(api().post('/api/users')).send(body(phone)).expect(201);
    const dup = await admin.auth(api().post('/api/users')).send(body(`${phone.slice(0, 3)} ${phone.slice(3)}`));
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('USER_PHONE_EXISTS');
  });
});
