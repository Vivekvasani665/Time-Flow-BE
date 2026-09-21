import { Prisma } from '@prisma/client';
import type { Writable } from 'node:stream';
import { prisma } from '../../lib/prisma';
import { skipTake } from '../../common/http/pagination';
import { buildMeta } from '../../common/http/response';
import { userRefSelect } from '../../common/http/selects';
import type { ActivityFilters, ListActivityQuery } from './activity-log.schemas';

const activitySelect = {
  id: true,
  action: true,
  entity: true,
  entityId: true,
  description: true,
  metadata: true,
  ipAddress: true,
  createdAt: true,
  user: { select: userRefSelect },
} satisfies Prisma.ActivityLogSelect;

/** `to` given as a bare date means "through the end of that day". */
function parseBoundary(value: string, endOfDay: boolean): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  }
  return new Date(value);
}

export function buildActivityWhere(f: ActivityFilters): Prisma.ActivityLogWhereInput {
  const where: Prisma.ActivityLogWhereInput = {};
  if (f.entity) where.entity = f.entity;
  if (f.action) where.action = f.action;
  if (f.userId) where.userId = f.userId;
  if (f.from || f.to) {
    where.createdAt = {
      ...(f.from ? { gte: parseBoundary(f.from, false) } : {}),
      ...(f.to ? { lte: parseBoundary(f.to, true) } : {}),
    };
  }
  if (f.search) where.description = { contains: f.search, mode: 'insensitive' };
  return where;
}

/** Neutralises spreadsheet formula injection and escapes CSV metacharacters. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const DAY_MS = 24 * 3600 * 1000;
const STATS_DEFAULT_DAYS = 30;
const STATS_MAX_DAYS = 366;

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The day range a chart covers: the filter's from/to when given, else the last
 * 30 days. Capped at a year (counted back from `to`) so a bar per day stays readable.
 */
export function statsRange(f: ActivityFilters): { from: string; to: string } {
  const to = f.to ? utcDay(parseBoundary(f.to, true)) : utcDay(new Date());
  const toMs = Date.parse(`${to}T00:00:00Z`);
  const earliest = toMs - (STATS_MAX_DAYS - 1) * DAY_MS;
  const fromMs = f.from ? Date.parse(`${utcDay(parseBoundary(f.from, false))}T00:00:00Z`) : toMs - (STATS_DEFAULT_DAYS - 1) * DAY_MS;
  return { from: utcDay(new Date(Math.min(toMs, Math.max(fromMs, earliest)))), to };
}

const EXPORT_BATCH = 500;
const EXPORT_MAX_ROWS = 50_000;

export const activityLogService = {
  async list(query: ListActivityQuery) {
    const where = buildActivityWhere(query);
    const [items, total] = await prisma.$transaction([
      prisma.activityLog.findMany({
        where,
        select: activitySelect,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'desc' }],
        ...skipTake(query.page, query.limit),
      }),
      prisma.activityLog.count({ where }),
    ]);
    return { items, meta: buildMeta(query.page, query.limit, total) };
  },

  /** Events per UTC day (zero-filled) and per entity, for the same filters as the list. */
  async stats(filters: ActivityFilters) {
    const range = statsRange(filters);
    const where = buildActivityWhere({ ...filters, from: range.from, to: range.to });

    const conditions: Prisma.Sql[] = [
      Prisma.sql`created_at >= ${parseBoundary(range.from, false)}`,
      Prisma.sql`created_at <= ${parseBoundary(range.to, true)}`,
    ];
    if (filters.entity) conditions.push(Prisma.sql`entity = ${filters.entity}`);
    if (filters.action) conditions.push(Prisma.sql`action = ${filters.action}`);
    if (filters.userId) conditions.push(Prisma.sql`user_id = ${filters.userId}::uuid`);
    if (filters.search) {
      const pattern = `%${filters.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(Prisma.sql`description ILIKE ${pattern}`);
    }

    const [daily, byEntity, byAction] = await Promise.all([
      prisma.$queryRaw<{ day: string; count: number }[]>`
        SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
        FROM activity_logs
        WHERE ${Prisma.join(conditions, ' AND ')}
        GROUP BY day`,
      prisma.activityLog.groupBy({ by: ['entity'], where, _count: { _all: true } }),
      prisma.activityLog.groupBy({ by: ['action'], where, _count: { _all: true } }),
    ]);

    const counts = new Map(daily.map((d) => [d.day, d.count]));
    const days: { date: string; count: number }[] = [];
    for (let t = Date.parse(`${range.from}T00:00:00Z`); t <= Date.parse(`${range.to}T00:00:00Z`); t += DAY_MS) {
      const date = utcDay(new Date(t));
      days.push({ date, count: counts.get(date) ?? 0 });
    }

    return {
      from: range.from,
      to: range.to,
      total: days.reduce((sum, d) => sum + d.count, 0),
      days,
      byEntity: byEntity.map((e) => ({ entity: e.entity, count: e._count._all })).sort((a, b) => b.count - a.count),
      byAction: byAction.map((e) => ({ action: e.action, count: e._count._all })).sort((a, b) => b.count - a.count),
    };
  },

  /** Streams CSV using keyset pagination so memory stays flat for large exports. */
  async exportCsv(filters: ActivityFilters, out: Writable): Promise<number> {
    const where = buildActivityWhere(filters);
    out.write(['timestamp', 'user', 'email', 'action', 'entity', 'entity_id', 'description', 'ip_address', 'metadata'].join(',') + '\n');

    let cursor: string | undefined;
    let written = 0;
    while (written < EXPORT_MAX_ROWS) {
      const batch = await prisma.activityLog.findMany({
        where,
        select: activitySelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: EXPORT_BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (batch.length === 0) break;
      for (const row of batch) {
        const line = [
          row.createdAt.toISOString(),
          row.user ? `${row.user.firstName} ${row.user.lastName}` : 'System',
          row.user?.email ?? '',
          row.action,
          row.entity,
          row.entityId ?? '',
          row.description,
          row.ipAddress ?? '',
          row.metadata,
        ]
          .map(csvCell)
          .join(',');
        if (!out.write(line + '\n')) await new Promise((resolve) => out.once('drain', resolve));
      }
      written += batch.length;
      cursor = batch[batch.length - 1]?.id;
      if (batch.length < EXPORT_BATCH) break;
    }
    return written;
  },
};
