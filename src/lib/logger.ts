import pino from 'pino';
import { env, isProd } from '../config/env';

/** Paths that must never reach log output. */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'refreshToken',
  '*.refreshToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: process.env.SERVICE_NAME ?? 'timeflow-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  formatters: { level: (label) => ({ level: label }) },
  ...(isProd || env.NODE_ENV === 'test'
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } } }),
});

export type Logger = typeof logger;
