import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { statsRange } from '../src/modules/activity-logs/activity-log.service';
import { api, loginAs, type Session } from './helpers';

let superadmin: Session;
let employee: Session;

beforeAll(async () => {
  [superadmin, employee] = await Promise.all([loginAs('superadmin'), loginAs('employee')]);
  const at = (iso: string) => new Date(iso);
  await prisma.activityLog.createMany({
    data: [
      { action: 'stats.a', entity: 'stats_probe', description: '100% done', createdAt: at('2025-03-01T08:00:00Z') },
      { action: 'stats.a', entity: 'stats_probe', description: 'plain', createdAt: at('2025-03-01T23:59:00Z') },
      { action: 'stats.b', entity: 'stats_probe', description: 'plain', createdAt: at('2025-03-03T00:00:00Z') },
      { action: 'stats.b', entity: 'stats_other', description: 'plain', createdAt: at('2025-03-03T12:00:00Z') },
    ],
  });
});

describe('GET /api/activity-logs/stats', () => {
  it('counts per UTC day with gaps zero-filled, and per entity', async () => {
    const res = await superadmin.auth(api().get('/api/activity-logs/stats')).query({ from: '2025-03-01', to: '2025-03-04' });
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).toMatchObject({ from: '2025-03-01', to: '2025-03-04', total: 4 });
    expect(data.days).toEqual([
      { date: '2025-03-01', count: 2 },
      { date: '2025-03-02', count: 0 },
      { date: '2025-03-03', count: 2 },
      { date: '2025-03-04', count: 0 },
    ]);
    expect(data.byEntity).toEqual([
      { entity: 'stats_probe', count: 3 },
      { entity: 'stats_other', count: 1 },
    ]);
  });

  it('applies the same filters as the list, treating % in search literally', async () => {
    const byEntity = await superadmin.auth(api().get('/api/activity-logs/stats')).query({ from: '2025-03-01', to: '2025-03-04', entity: 'stats_other' });
    expect(byEntity.body.data.total).toBe(1);

    const bySearch = await superadmin.auth(api().get('/api/activity-logs/stats')).query({ from: '2025-03-01', to: '2025-03-04', search: '100%' });
    expect(bySearch.body.data.total).toBe(1);
  });

  it('requires activity_logs.view', async () => {
    expect((await employee.auth(api().get('/api/activity-logs/stats'))).status).toBe(403);
  });
});

describe('statsRange', () => {
  it('defaults to the last 30 days and caps long ranges at 366 days', () => {
    const { from, to } = statsRange({});
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBe(29);
    expect(statsRange({ from: '2020-01-01', to: '2025-03-04' })).toEqual({ from: '2024-03-04', to: '2025-03-04' });
  });
});
