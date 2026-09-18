import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { isProd } from '../../config/env';
import { logger } from '../../lib/logger';
import { AppError, ConflictError, NotFoundError, ValidationError, type ErrorDetail } from '../errors';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

function zodToDetails(err: ZodError): ErrorDetail[] {
  return err.issues.map((issue) => ({ path: issue.path.join('.') || '(root)', message: issue.message }));
}

/** Maps a Prisma unique-constraint violation to a domain-specific conflict. */
function mapUniqueViolation(err: Prisma.PrismaClientKnownRequestError): AppError {
  const target = JSON.stringify(err.meta?.target ?? '');
  const model = String(err.meta?.modelName ?? '');
  if (target.includes('email') || (model === 'User' && target.includes('users_email'))) {
    return new ConflictError('Email already exists', 'USER_EMAIL_EXISTS');
  }
  if (model === 'Role' || target.includes('name')) return new ConflictError('Role name already exists', 'ROLE_NAME_EXISTS');
  return new ConflictError('Resource already exists');
}

export function normalizeError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) return new ValidationError(zodToDetails(err));

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002':
        return mapUniqueViolation(err);
      case 'P2025':
        return new NotFoundError();
      case 'P2003':
        return new ConflictError('Operation violates a relation constraint');
      default:
        break;
    }
  }
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'File is too large');
    return new AppError(400, 'BAD_REQUEST', err.message);
  }
  // body-parser errors
  if (typeof err === 'object' && err !== null && 'type' in err) {
    const type = (err as { type: unknown }).type;
    if (type === 'entity.parse.failed') return new AppError(400, 'BAD_REQUEST', 'Malformed JSON body');
    if (type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }
  return new AppError(500, 'INTERNAL_ERROR', 'Something went wrong');
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appError = normalizeError(err);
  const requestId = req.id != null ? String(req.id) : undefined;
  const log = req.log ?? logger;

  if (appError.statusCode >= 500) {
    log.error({ err, requestId }, 'unhandled error');
  } else {
    log.debug({ code: appError.code, requestId }, appError.message);
  }

  if (res.headersSent) return;

  res.status(appError.statusCode).json({
    success: false,
    message: appError.message,
    code: appError.code,
    ...(appError.details ? { details: appError.details } : {}),
    ...(requestId ? { requestId } : {}),
    ...(!isProd && appError.statusCode >= 500 && err instanceof Error ? { debug: err.message } : {}),
  });
};
