import { describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { api, EMAILS, loginAs, nextIp, PASSWORD, unique } from './helpers';

const cookieValue = (setCookie: string[] | undefined, name: string) =>
  setCookie?.find((c) => c.startsWith(`${name}=`))?.split(';')[0]?.slice(name.length + 1) ?? null;

async function browserLogin(email: string = EMAILS.manager) {
  const res = await api().post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookies = res.headers['set-cookie'] as unknown as string[];
  return { res, access: cookieValue(cookies, 'tf_access')!, refresh: cookieValue(cookies, 'tf_refresh')! };
}

describe('POST /api/auth/login', () => {
  it('signs in with valid credentials and sets httpOnly cookies', async () => {
    const { res, access, refresh } = await browserLogin();
    expect(res.body).toMatchObject({ success: true, data: { user: { email: EMAILS.manager, role: { name: 'Manager' } } } });
    expect(res.body.data.user.permissions).toContain('projects.view');
    expect(res.body.data.user).not.toHaveProperty('passwordHash');
    expect(access).toBeTruthy();
    expect(refresh).toBeTruthy();
    const cookies = (res.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(cookies).toMatch(/tf_access=.*HttpOnly/);
    expect(cookies).toMatch(/tf_refresh=.*Path=\/api\/auth.*HttpOnly/);
    expect(cookies).toMatch(/tf_session=1;.*Path=\/;.*HttpOnly/);
  });

  it('advertises the access token expiry so clients can refresh before it lapses', async () => {
    const before = Date.now();
    const { res, access } = await browserLogin();
    const loginExpiry = Date.parse(res.headers['x-session-expires-at']);
    expect(loginExpiry - before).toBeGreaterThan(14 * 60 * 1000);
    expect(loginExpiry - before).toBeLessThanOrEqual(15 * 60 * 1000 + 5000);

    const me = await api().get('/api/auth/me').set('Cookie', `tf_access=${access}`);
    expect(me.status).toBe(200);
    // Derived from the JWT `exp` (second precision), so it matches the login value.
    expect(Math.abs(Date.parse(me.headers['x-session-expires-at']) - loginExpiry)).toBeLessThan(2000);
  });

  it('rejects a wrong password with INVALID_CREDENTIALS', async () => {
    const res = await api().post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email: EMAILS.admin, password: 'nope-nope-1' });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, code: 'INVALID_CREDENTIALS' });
  });

  it('returns the same error for unknown emails (no user enumeration)', async () => {
    const res = await api().post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email: 'ghost@timeflow.dev', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('blocks inactive accounts with ACCOUNT_INACTIVE', async () => {
    const res = await api().post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email: 'nina.volkova@timeflow.dev', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_INACTIVE');
  });

  it('validates the body', async () => {
    const res = await api().post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('rate limits to 5 attempts per minute per IP', async () => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await api().post('/api/auth/login').set('X-Forwarded-For', ip).send({ email: EMAILS.admin, password: 'wrong-pass-1' });
      statuses.push(res.status);
      if (res.status === 429) {
        expect(res.body.code).toBe('RATE_LIMITED');
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      }
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });
});

describe('POST /api/auth/register', () => {
  const register = (body: Record<string, unknown>) => api().post('/api/auth/register').set('X-Forwarded-For', nextIp()).send(body);
  const newUser = () => ({ firstName: 'Sam', lastName: 'Rivera', email: `${unique('signup')}@timeflow.dev`, password: 'Signup1234' });

  it('creates an active Employee, signs them in and sets session cookies', async () => {
    const body = newUser();
    const res = await register(body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, data: { user: { email: body.email, status: 'ACTIVE', role: { name: 'Employee' } } } });
    expect(res.body.data.user).not.toHaveProperty('passwordHash');
    const cookies = (res.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(cookies).toMatch(/tf_access=.*HttpOnly/);
    expect(cookies).toMatch(/tf_refresh=.*HttpOnly/);

    const login = await api().post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email: body.email, password: body.password });
    expect(login.status).toBe(200);
  });

  it('rejects an email that is already registered', async () => {
    const res = await register({ ...newUser(), email: EMAILS.manager });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('USER_EMAIL_EXISTS');
  });

  it('refuses a client-chosen role or status', async () => {
    const res = await register({ ...newUser(), roleId: '00000000-0000-0000-0000-000000000000', status: 'ACTIVE' });
    expect(res.status).toBe(400);
    expect(await prisma.user.count({ where: { firstName: 'Sam', role: { name: { not: 'Employee' } } } })).toBe(0);
  });

  it('validates the body', async () => {
    const res = await register({ firstName: '', lastName: 'X', email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    const paths = res.body.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['firstName', 'email', 'password']));
  });
});

describe('GET /api/auth/me', () => {
  it('returns the current user via cookie', async () => {
    const { access } = await browserLogin();
    const res = await api().get('/api/auth/me').set('Cookie', `tf_access=${access}`);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(EMAILS.manager);
  });

  it('returns the current user via bearer token', async () => {
    const s = await loginAs('employee');
    const res = await s.auth(api().get('/api/auth/me'));
    expect(res.status).toBe(200);
    expect(res.body.data.permissions).toEqual(['emails.send', 'emails.view', 'projects.view', 'tasks.update', 'tasks.view']);
  });

  it('401s without a token and with a tampered token', async () => {
    expect((await api().get('/api/auth/me')).body.code).toBe('UNAUTHENTICATED');
    const res = await api().get('/api/auth/me').set('Authorization', 'Bearer abc.def.ghi');
    expect(res.status).toBe(401);
  });

  it('invalidates outstanding access tokens when the user is deactivated', async () => {
    const admin = await loginAs('superadmin');
    const target = await prisma.user.findFirstOrThrow({ where: { email: 'kai.morgan@timeflow.dev' } });
    const kai = await loginAs('kai.morgan@timeflow.dev');
    expect((await kai.auth(api().get('/api/auth/me'))).status).toBe(200);

    await admin.auth(api().patch(`/api/users/${target.id}/status`)).send({ status: 'INACTIVE' }).expect(200);
    expect((await kai.auth(api().get('/api/auth/me'))).status).toBe(401);

    await admin.auth(api().patch(`/api/users/${target.id}/status`)).send({ status: 'ACTIVE' }).expect(200);
  });
});

describe('refresh token rotation', () => {
  it('rotates the refresh token and issues a new session', async () => {
    const { refresh } = await browserLogin();
    const res = await api().post('/api/auth/refresh').set('Cookie', `tf_refresh=${refresh}`);
    expect(res.status).toBe(200);
    const next = cookieValue(res.headers['set-cookie'] as unknown as string[], 'tf_refresh');
    expect(next).toBeTruthy();
    expect(next).not.toBe(refresh);

    const me = await api().get('/api/auth/me').set('Cookie', `tf_access=${cookieValue(res.headers['set-cookie'] as unknown as string[], 'tf_access')}`);
    expect(me.status).toBe(200);
  });

  it('detects reuse of a rotated token and revokes the whole family', async () => {
    const { refresh } = await browserLogin();
    const first = await api().post('/api/auth/refresh').set('Cookie', `tf_refresh=${refresh}`);
    const rotated = cookieValue(first.headers['set-cookie'] as unknown as string[], 'tf_refresh')!;

    // Move the original token's rotation outside the benign-race grace window.
    await prisma.refreshToken.updateMany({ where: { replacedBy: { not: null }, revokedAt: { not: null } }, data: { revokedAt: new Date(Date.now() - 60_000) } });

    const replay = await api().post('/api/auth/refresh').set('Cookie', `tf_refresh=${refresh}`);
    expect(replay.status).toBe(401);

    // The legitimate, newer token is now dead too.
    const legit = await api().post('/api/auth/refresh').set('Cookie', `tf_refresh=${rotated}`);
    expect(legit.status).toBe(401);
  });

  it('logout revokes the refresh token and clears cookies', async () => {
    const { refresh } = await browserLogin();
    const out = await api().post('/api/auth/logout').set('Cookie', `tf_refresh=${refresh}`);
    expect(out.status).toBe(200);
    expect((out.headers['set-cookie'] as unknown as string[]).join(';')).toMatch(/tf_access=;/);
    const res = await api().post('/api/auth/refresh').set('Cookie', `tf_refresh=${refresh}`);
    expect(res.status).toBe(401);
  });
});
