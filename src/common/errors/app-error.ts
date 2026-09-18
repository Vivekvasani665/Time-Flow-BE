export type ErrorDetail = { path: string; message: string };

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(details: ErrorDetail[], message = 'Validation failed') {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, code = 'BAD_REQUEST', details?: ErrorDetail[]) {
    super(400, code, message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', code = 'UNAUTHENTICATED') {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action', code = 'FORBIDDEN') {
    super(403, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(entity = 'Resource', code = 'NOT_FOUND') {
    super(404, code, `${entity} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT') {
    super(409, code, message);
  }
}

export class RateLimitError extends AppError {
  constructor(
    readonly retryAfterSeconds: number,
    message = 'Too many requests, please try again later',
  ) {
    super(429, 'RATE_LIMITED', message);
  }
}
