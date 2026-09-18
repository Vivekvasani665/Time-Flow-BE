import type { Response } from 'express';

export type PaginationMeta = { page: number; limit: number; total: number; totalPages: number };

export type SuccessBody<T> = {
  success: true;
  data: T;
  message?: string;
  meta?: Record<string, unknown>;
};

export function ok<T>(res: Response, data: T, message?: string, status = 200): Response {
  const body: SuccessBody<T> = { success: true, data };
  if (message) body.message = message;
  return res.status(status).json(body);
}

export function created<T>(res: Response, data: T, message?: string): Response {
  return ok(res, data, message, 201);
}

export function paginated<T>(
  res: Response,
  data: T[],
  meta: PaginationMeta & Record<string, unknown>,
  message?: string,
): Response {
  const body: SuccessBody<T[]> = { success: true, data, meta };
  if (message) body.message = message;
  return res.status(200).json(body);
}

export function buildMeta(page: number, limit: number, total: number): PaginationMeta {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}
