import request from 'supertest';
import { vi } from 'vitest';
import * as sms from '../src/queue/sms';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';

export const app = createApp({ enableBullBoard: false });
export const PASSWORD = 'Password123!';

export const EMAILS = {
  superadmin: 'superadmin@timeflow.dev',
  admin: 'admin@timeflow.dev',
  manager: 'manager@timeflow.dev',
  employee: 'employee@timeflow.dev',
} as const;

// Each test file gets a fresh module instance, so start from a random offset
// to keep IPs unique across files run within the same rate-limit window.
let ipCounter = Math.floor(Math.random() * 16_000_000);
/** Unique client IP per call so the 5/min login limiter doesn't interfere across tests. */
export const nextIp = () => {
  const n = ++ipCounter;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};

export type Session = { token: string; userId: string; auth: (r: request.Test) => request.Test };

export async function loginAs(who: keyof typeof EMAILS | string, password = PASSWORD): Promise<Session> {
  const email = who in EMAILS ? EMAILS[who as keyof typeof EMAILS] : who;
  const res = await request(app).post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const token: string = res.body.data.accessToken;
  return { token, userId: res.body.data.user.id, auth: (r) => r.set('Authorization', `Bearer ${token}`) };
}

export const api = () => request(app);

export async function roleId(name: string): Promise<string> {
  const role = await prisma.role.findUniqueOrThrow({ where: { name } });
  return role.id;
}

export async function userId(email: string): Promise<string> {
  const user = await prisma.user.findFirstOrThrow({ where: { email, deletedAt: null } });
  return user.id;
}

let seq = 0;
export const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;

let phoneSeq = Math.floor(Math.random() * 1_000_000);
/** A mobile number no other test user has. */
export const uniquePhone = () => `+9198${String(Date.now() % 10_000).padStart(4, '0')}${String(++phoneSeq % 10_000).padStart(4, '0')}`;

/** Runs `fn` while capturing the code texted by the signup flow (the same code is emailed). */
export async function captureSmsOtp<T>(fn: () => Promise<T>): Promise<{ result: T; otp: string }> {
  let otp = '';
  const spy = vi.spyOn(sms.smsService, 'sendMessage').mockImplementation(async (msg) => {
    otp = msg.vars?.otp ?? '';
    return 'test-sms-id';
  });
  try {
    return { result: await fn(), otp };
  } finally {
    spy.mockRestore();
  }
}

/** Full self-service signup: register → verify the code → sign in. */
export async function signUpAndLogin(body: { firstName: string; lastName: string; email: string; password: string; phone?: string }) {
  const { result: reg, otp } = await captureSmsOtp(() =>
    request(app).post('/api/auth/register').set('X-Forwarded-For', nextIp()).send({ phone: uniquePhone(), ...body }),
  );
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const verified = await request(app)
    .post('/api/auth/register/verify-otp')
    .set('X-Forwarded-For', nextIp())
    .send({ verificationId: reg.body.data.verificationId, otp });
  if (verified.status !== 200) throw new Error(`verify failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  const login = await request(app).post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email: body.email, password: body.password });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  return login;
}
