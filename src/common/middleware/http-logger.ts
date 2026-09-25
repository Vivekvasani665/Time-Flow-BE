import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import pinoHttp from 'pino-http';
import { logger, redactUrl } from '../../lib/logger';

const REQUEST_ID_RE = /^[\w-]{8,64}$/;

/**
 * Structured access log: timestamp, level, request id, method, route, status
 * and response time. Honours an incoming `X-Request-Id` for cross-service
 * correlation and echoes it back.
 */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
  serializers: {
    req: (req: { id: string; method: string; url: string; remoteAddress?: string; raw?: Partial<Request> }) => ({
      id: req.id,
      method: req.method,
      url: redactUrl(req.raw?.originalUrl ?? req.url),
      ip: req.raw?.ip ?? req.remoteAddress,
    }),
    res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
  },
  customSuccessMessage: (req, res, responseTime) =>
    `${req.method} ${redactUrl((req as Partial<Request>).originalUrl ?? req.url)} ${res.statusCode} ${Math.round(responseTime)}ms`,
  customErrorMessage: (req, res) => `${req.method} ${redactUrl((req as Partial<Request>).originalUrl ?? req.url)} ${res.statusCode}`,
  customAttributeKeys: { responseTime: 'responseTimeMs' },
});
