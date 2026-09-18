import { describe, expect, it } from 'vitest';
import { api } from './helpers';

describe('OpenAPI & health', () => {
  it('serves an OpenAPI document covering every contract endpoint', async () => {
    const res = await api().get('/api/docs.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.0.3');
    const paths = Object.keys(res.body.paths);
    for (const p of ['/api/auth/login', '/api/users/{id}', '/api/roles/{id}/users', '/api/permissions', '/api/projects', '/api/tasks/{id}', '/api/activity-logs', '/api/dashboard', '/api/queues']) {
      expect(paths).toContain(p);
    }
  });

  it('reports liveness and readiness', async () => {
    expect((await api().get('/health/live')).status).toBe(200);
    const ready = await api().get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toMatchObject({ database: { status: 'up' }, redis: { status: 'up' } });
  });

  it('returns a consistent envelope for unknown routes and echoes request ids', async () => {
    const res = await api().get('/api/nope').set('X-Request-Id', 'test-request-123');
    expect(res.status).toBe(404);
    expect(res.headers['x-request-id']).toBe('test-request-123');
    expect(res.body).toMatchObject({ success: false, code: 'ROUTE_NOT_FOUND', requestId: 'test-request-123' });
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await api().post('/api/auth/login').set('Content-Type', 'application/json').set('X-Forwarded-For', '10.9.9.9').send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
