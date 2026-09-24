import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorHandler, INTERNAL_ERROR_MESSAGE } from '../src/common/middleware/error-handler';
import { api } from './helpers';

describe('Error responses', () => {
  it('never exposes internal error text on a 500', async () => {
    const app = express();
    app.get('/boom', () => {
      throw new Error('Invalid `prisma.user.findMany()` invocation in /Users/dev/src/secret.ts: table does not exist');
    });
    app.use(errorHandler);

    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, statusCode: 500, message: INTERNAL_ERROR_MESSAGE, code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|secret|\/Users/);
  });

  it('includes statusCode alongside the code and details on client errors', async () => {
    const res = await api().post('/api/auth/login').set('X-Forwarded-For', '10.250.0.1').send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(res.body.details.length).toBeGreaterThan(0);
  });
});
