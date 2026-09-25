import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { sha256 } from '../src/common/utils/crypto';
import * as mailer from '../src/queue/mailer';
import * as sms from '../src/queue/sms';
import { hashPassword } from '../src/modules/auth/auth.service';
import { api, nextIp, roleId, unique, uniquePhone } from './helpers';

let emailedOtp = '';
let textedOtp = '';

beforeEach(() => {
  emailedOtp = textedOtp = '';
  vi.spyOn(mailer, 'sendMail').mockImplementation(async (msg) => {
    emailedOtp = /\b(\d{6})\b/.exec(msg.subject)?.[1] ?? '';
    return 'test-msg-id';
  });
  vi.spyOn(sms.smsService, 'sendMessage').mockImplementation(async (msg) => {
    textedOtp = msg.vars?.otp ?? '';
    return 'test-sms-id';
  });
});

async function makeUser(opts: { phone?: string | null; status?: 'ACTIVE' | 'INACTIVE' | 'PENDING' } = {}) {
  const email = `${unique('otplogin')}@timeflow.dev`;
  const phone = opts.phone === undefined ? uniquePhone() : opts.phone;
  const user = await prisma.user.create({
    data: { firstName: 'Omi', lastName: 'Token', email, phone, status: opts.status ?? 'ACTIVE', roleId: await roleId('Employee'), passwordHash: await hashPassword('Unused123') },
  });
  return { id: user.id, email, phone };
}

const send = (body: Record<string, unknown>) => api().post('/api/auth/send-otp').set('X-Forwarded-For', nextIp()).send(body);
const verify = (token: string, otp: string) => api().post('/api/auth/verify-otp').set('X-Forwarded-For', nextIp()).send({ token, otp });
const resend = (token: string, channel?: string) =>
  api().post('/api/auth/resend-otp').set('X-Forwarded-For', nextIp()).send({ token, ...(channel ? { channel } : {}) });
const redisKey = (token: string) => `otp:login:${sha256(token)}`;
const wrong = (otp: string) => (otp === '000000' ? '111111' : '000000');

describe('Token-based OTP login (send-otp → verify-otp)', () => {
  it('email → token + one code by email and SMS → verify → session; the token works once', async () => {
    const u = await makeUser();
    const res = await send({ email: u.email });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ channels: ['email', 'sms'], emailSent: true, smsSent: true, expiresInSeconds: 300 });
    const { token } = res.body.data;
    expect(token).toMatch(/^[\w-]{40,}$/);
    expect(textedOtp).toBe(emailedOtp);

    // Redis holds a hash of the code under a hash of the token — never either in clear.
    const stored = await redis.hgetall(redisKey(token));
    expect(stored.userId).toBe(u.id);
    expect(JSON.stringify(stored)).not.toContain(emailedOtp);
    expect(await redis.exists(`otp:login:${token}`)).toBe(0);
    expect(await redis.ttl(redisKey(token))).toBeGreaterThan(0);

    const ok = await verify(token, emailedOtp);
    expect(ok.status).toBe(200);
    expect(ok.body.data.user).toMatchObject({ id: u.id, email: u.email });
    expect((ok.headers['set-cookie'] as unknown as string[]).join('\n')).toMatch(/tf_access=.*HttpOnly/);
    expect(await redis.exists(redisKey(token))).toBe(0); // token deleted

    const again = await verify(token, emailedOtp);
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('OTP_TOKEN_INVALID');
  });

  it('finds the account by mobile number, whatever its formatting', async () => {
    const u = await makeUser();
    const spaced = `${u.phone!.slice(0, 3)} ${u.phone!.slice(3, 8)}-${u.phone!.slice(8)}`;
    const res = await send({ phone: spaced });
    expect(res.status).toBe(200);
    expect((await verify(res.body.data.token, textedOtp)).status).toBe(200);
  });

  it('counts wrong codes (+1 each) and locks the token after 5', async () => {
    const u = await makeUser();
    const { token } = (await send({ email: u.email })).body.data;
    const bad = wrong(emailedOtp);
    const first = await verify(token, bad);
    expect(first.status).toBe(400);
    expect(first.body).toMatchObject({ code: 'INVALID_OTP', message: 'Incorrect code. 4 attempts left.' });
    for (let i = 0; i < 3; i++) await verify(token, bad);
    expect((await verify(token, bad)).body.code).toBe('OTP_MAX_ATTEMPTS');
    const locked = await verify(token, emailedOtp);
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('OTP_MAX_ATTEMPTS');
  });

  it('rejects an expired code but lets the user resend on the same token', async () => {
    const u = await makeUser();
    const { token } = (await send({ email: u.email })).body.data;
    await redis.hset(redisKey(token), { expiresAt: Date.now() - 1000, lastSentAt: Date.now() - 120_000 });
    const expired = await verify(token, emailedOtp);
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('OTP_EXPIRED');

    const again = await resend(token);
    expect(again.status).toBe(200);
    expect((await verify(token, emailedOtp)).status).toBe(200);
  });

  it('rejects an unknown token', async () => {
    const res = await verify('x'.repeat(43), '123456');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('OTP_TOKEN_INVALID');
  });

  it('enforces the resend cooldown (429), then sends a NEW code by SMS only', async () => {
    const u = await makeUser();
    const { token } = (await send({ email: u.email })).body.data;
    const oldCode = emailedOtp;

    expect((await send({ email: u.email })).body.code).toBe('OTP_RATE_LIMITED');
    const early = await resend(token);
    expect(early.status).toBe(429);
    expect(early.body.code).toBe('OTP_RATE_LIMITED');

    await redis.hset(redisKey(token), 'lastSentAt', Date.now() - 120_000);
    emailedOtp = '';
    const again = await resend(token, 'sms');
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ channels: ['sms'], smsSent: true, emailSent: false });
    expect(emailedOtp).toBe('');
    if (oldCode !== textedOtp) expect((await verify(token, oldCode)).body.code).toBe('INVALID_OTP');
    expect((await verify(token, textedOtp)).status).toBe(200);
  });

  it('a new send replaces the previous token', async () => {
    const u = await makeUser();
    const first = (await send({ email: u.email })).body.data.token;
    await redis.hset(redisKey(first), 'lastSentAt', Date.now() - 120_000);
    const second = (await send({ email: u.email })).body.data.token;
    expect(second).not.toBe(first);
    expect((await verify(first, emailedOtp)).body.code).toBe('OTP_TOKEN_INVALID');
    expect((await verify(second, emailedOtp)).status).toBe(200);
  });

  it('invalidates the token if the password changes before the code is used', async () => {
    const u = await makeUser();
    const { token } = (await send({ email: u.email })).body.data;
    await prisma.user.update({ where: { id: u.id }, data: { tokenVersion: { increment: 1 } } });
    expect((await verify(token, emailedOtp)).body.code).toBe('OTP_TOKEN_INVALID');
  });

  it('still asks accounts with an authenticator app for their 2FA code', async () => {
    const u = await makeUser();
    await prisma.user.update({ where: { id: u.id }, data: { twoFactorEnabled: true } });
    const { token } = (await send({ email: u.email })).body.data;
    const res = await verify(token, emailedOtp);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ twoFactorRequired: true });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('answers 404 / 403 for accounts that cannot sign in, and validates input', async () => {
    expect((await send({ email: `${unique('nobody')}@timeflow.dev` })).body.code).toBe('ACCOUNT_NOT_FOUND');
    expect((await send({ email: (await makeUser({ status: 'INACTIVE' })).email })).body.code).toBe('ACCOUNT_INACTIVE');
    expect((await send({ email: (await makeUser({ status: 'PENDING' })).email })).body.code).toBe('ACCOUNT_NOT_VERIFIED');
    expect((await send({})).status).toBe(400);
    expect((await send({ email: 'a@b.co', phone: '+919876543210' })).status).toBe(400);
    expect((await send({ phone: '98765' })).status).toBe(400);
  });

  it('sends email only for an account without a mobile number', async () => {
    const u = await makeUser({ phone: null });
    const res = await send({ email: u.email });
    expect(res.body.data).toMatchObject({ channels: ['email'], smsSent: false, phone: null });
  });

  it('is switched off by OTP_LOGIN_ENABLED=false', async () => {
    const saved = env.OTP_LOGIN_ENABLED;
    (env as { OTP_LOGIN_ENABLED: boolean }).OTP_LOGIN_ENABLED = false;
    try {
      expect((await send({ email: 'x@y.co' })).status).toBe(404);
    } finally {
      (env as { OTP_LOGIN_ENABLED: boolean }).OTP_LOGIN_ENABLED = saved;
    }
  });
});
