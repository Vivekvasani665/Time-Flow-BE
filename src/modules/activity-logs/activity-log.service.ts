import type { Prisma } from '@prisma/client';
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
