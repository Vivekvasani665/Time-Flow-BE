import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { api, loginAs, type Session } from './helpers';

let employee: Session;

beforeAll(async () => {
  employee = await loginAs('employee');
});

describe('UI preferences', () => {
  it('ignores a stored legacy accent instead of resetting the other settings', async () => {
    await prisma.user.update({ where: { id: employee.userId }, data: { preferences: { theme: 'dark', accent: 'violet', density: 'compact' } } });

    const me = await employee.auth(api().get('/api/auth/me'));
    expect(me.status).toBe(200);
    expect(me.body.data.preferences).toEqual({ theme: 'dark', density: 'compact' });
  });

  it('drops the legacy accent from the database on the next save', async () => {
    const res = await employee.auth(api().patch('/api/auth/me/preferences')).send({ theme: 'light' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ theme: 'light', density: 'compact' });

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: employee.userId }, select: { preferences: true } });
    expect(stored.preferences).toEqual({ theme: 'light', density: 'compact' });
  });

  it('rejects accent on write', async () => {
    const res = await employee.auth(api().patch('/api/auth/me/preferences')).send({ accent: 'violet' });
    expect(res.status).toBe(400);
  });
});
