import { beforeAll, describe, expect, it } from 'vitest';
import { api, loginAs, type Session } from './helpers';

let s: Session;
beforeAll(async () => {
  s = await loginAs('employee');
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

describe('POST /api/uploads/avatar', () => {
  it('accepts a real PNG and returns a random server-side filename', async () => {
    const res = await s.auth(api().post('/api/uploads/avatar')).attach('file', PNG, { filename: '../../evil name.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.data.url).toMatch(/^\/uploads\/avatars\/[0-9a-f-]{36}\.png$/);
    expect((await api().get(res.body.data.url)).status).toBe(200);
  });

  it('rejects files whose content does not match the declared type', async () => {
    const res = await s.auth(api().post('/api/uploads/avatar')).attach('file', Buffer.from('<script>alert(1)</script>'), { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it('rejects disallowed MIME types and oversized files', async () => {
    const svg = await s.auth(api().post('/api/uploads/avatar')).attach('file', Buffer.from('<svg/>'), { filename: 'x.svg', contentType: 'image/svg+xml' });
    expect(svg.status).toBe(400);
    const big = await s.auth(api().post('/api/uploads/avatar')).attach('file', Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]), { filename: 'big.png', contentType: 'image/png' });
    expect(big.status).toBe(413);
  });

  it('requires authentication', async () => {
    expect((await api().post('/api/uploads/avatar').attach('file', PNG, 'a.png')).status).toBe(401);
  });
});
