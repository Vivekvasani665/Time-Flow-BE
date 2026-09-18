import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from '../src/lib/logger';

describe('logger configuration', () => {
  it('redacts credentials and session material', () => {
    expect(REDACT_PATHS).toEqual(expect.arrayContaining(['password', 'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]']));
  });
});
