import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from '../src/lib/logger';

describe('logger configuration', () => {
  it('redacts credentials and session material', () => {
    expect(REDACT_PATHS).toEqual(expect.arrayContaining(['password', 'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]']));
  });

  it('keeps the Redis password out of logged Redis errors', () => {
    let out = '';
    const sink = new Writable({ write: (chunk, _enc, done) => ((out += chunk), done()) });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, sink);
    const err = Object.assign(new Error('ERR max requests limit exceeded'), { command: { name: 'auth', args: ['default', 's3cret-redis-password'] } });
    log.error({ err, redis: 'main' }, 'redis error');
    expect(out).not.toContain('s3cret-redis-password');
    expect(out).toContain('"name":"auth"');
  });
});
