import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { sendMail, type MailMessage } from '../src/queue/mailer';
import { api, nextIp, unique } from './helpers';

// Capture outgoing mail so a test reads the code the way a user would: from the email.
vi.mock('../src/queue/mailer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queue/mailer')>()),
  sendMail: vi.fn().mockResolvedValue('test-message-id'),
}));

const mailed = vi.mocked(sendMail);
const PASSWORD = 'OtpLogin123';

beforeAll(() => {
  env.LOGIN_OTP_ENABLED = true;
});
afterAll(() => {
  env.LOGIN_OTP_ENABLED = false;
});
beforeEach(() => {
  mailed.mockClear();
});

async function newUser() {
  const email = `${unique('otp')}@example.com`;
  const res = await api()
    .post('/api/auth/register')
    .set('X-Forwarded-For', nextIp())
    .send({ firstName: 'Olive', lastName: 'Tp', email, password: PASSWORD });
  expect(res.status).toBe(201);
  return email;
}

const login = (email: string, password = PASSWORD) =>
  api().post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password });
const verify = (verificationId: string, otp: string) =>
  api().post('/api/auth/verify-login-otp').set('X-Forwarded-For', nextIp()).send({ verificationId, otp });
const resend = (verificationId: string) =>
  api().post('/api/auth/resend-login-otp').set('X-Forwarded-For', nextIp()).send({ verificationId });

function lastCode(): string {
  const message = mailed.mock.calls.at(-1)?.[0] as MailMessage | undefined;
  const code = message?.text.match(/Your code: (\d{6})/)?.[1];
  if (!code) throw new Error('no OTP email was sent');
  return code;
}

/** A code guaranteed to differ from the real one. */
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

const cookieNames = (res: { headers: Record<string, unknown> }) =>
  ((res.headers['set-cookie'] as string[] | undefined) ?? []).map((c) => c.split('=')[0]);

async function startLogin() {
  const email = await newUser();
  const res = await login(email);
  expect(res.status).toBe(200);
  return { email, verificationId: res.body.data.verificationId as string, code: lastCode() };
}

describe('login OTP — password step', () => {
  it('rejects a wrong password with the existing error, sending nothing', async () => {
    const email = await newUser();
    const res = await login(email, 'wrong-pass-1');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    expect(mailed).not.toHaveBeenCalled();
  });

  it('rejects an unknown email identically', async () => {
    const res = await login('nobody-here@example.com');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    expect(mailed).not.toHaveBeenCalled();
  });

  it('emails a code instead of issuing a session', async () => {
    const email = await newUser();
    const res = await login(email);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('OTP sent to your registered email');
    expect(res.body.data).toMatchObject({
      requiresOtp: true,
      verificationId: expect.any(String),
      email: expect.stringMatching(/^o\*+@example\.com$/),
      expiresInSeconds: 300,
      resendAvailableInSeconds: 60,
    });
    expect(res.body.data).not.toHaveProperty('accessToken');
    expect(res.body.data).not.toHaveProperty('user');
    expect(cookieNames(res)).toEqual([]);

    // The email carries the code, the name, the expiry and a warning…
    expect(mailed).toHaveBeenCalledTimes(1);
    const message = mailed.mock.calls[0]![0];
    expect(message.to).toBe(email);
    expect(message.subject).toBe('Your Time-Flow Login Verification Code');
    const code = lastCode();
    expect(message.html).toContain(code);
    expect(message.text).toContain('Hi Olive');
    expect(message.text).toContain('5 minutes');
    expect(message.text).toMatch(/never share this code/i);

    // …but the code is in neither the response nor the database.
    expect(JSON.stringify(res.body)).not.toContain(code);
    const row = await prisma.loginOtp.findUniqueOrThrow({ where: { id: res.body.data.verificationId } });
    expect(row.otpHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.otpHash).not.toContain(code);
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(4.5 * 60 * 1000);
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it('reports a mail failure and leaves no usable attempt behind', async () => {
    const email = await newUser();
    mailed.mockRejectedValueOnce(new Error('SMTP down'));
    const res = await login(email);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('EMAIL_DELIVERY_FAILED');
    expect(await prisma.loginOtp.count({ where: { user: { email } } })).toBe(0);
  });
});

describe('login OTP — verification', () => {
  it('signs in with the right code; the session then works for /me, protected APIs and logout', async () => {
    const { verificationId, code } = await startLogin();

    const res = await verify(verificationId, code);
    expect(res.status).toBe(200);
    expect(res.body.data.user.firstName).toBe('Olive');
    expect(res.body.data.accessToken).toBeTruthy();
    expect(cookieNames(res)).toEqual(expect.arrayContaining(['tf_access', 'tf_refresh', 'tf_session']));

    const token: string = res.body.data.accessToken;
    const me = await api().get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    const projects = await api().get('/api/projects').set('Authorization', `Bearer ${token}`);
    expect(projects.status).toBe(200);

    const refreshCookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('tf_refresh='))!.split(';')[0]!;
    const logout = await api().post('/api/auth/logout').set('Cookie', refreshCookie);
    expect(logout.status).toBe(200);
    const refresh = await api().post('/api/auth/refresh').set('Cookie', refreshCookie);
    expect(refresh.status).toBe(401);
  });

  it('gives no access to protected APIs before the code is verified', async () => {
    await startLogin();
    const res = await api().get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong code and says how many attempts are left', async () => {
    const { verificationId, code } = await startLogin();
    const res = await verify(verificationId, wrong(code));
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'LOGIN_OTP_INVALID', message: 'Incorrect code. 4 attempts left.' });
  });

  it('rejects an expired code', async () => {
    const { verificationId, code } = await startLogin();
    await prisma.loginOtp.update({ where: { id: verificationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await verify(verificationId, code);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('LOGIN_OTP_EXPIRED');
  });

  it('accepts a code only once', async () => {
    const { verificationId, code } = await startLogin();
    expect((await verify(verificationId, code)).status).toBe(200);
    const again = await verify(verificationId, code);
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('LOGIN_OTP_SESSION_INVALID');
  });

  it('locks the code after 5 wrong attempts — even the right code then fails', async () => {
    const { verificationId, code } = await startLogin();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await verify(verificationId, wrong(code))).status);
    expect(statuses).toEqual([401, 401, 401, 401, 429]);

    const right = await verify(verificationId, code);
    expect(right.status).toBe(429);
    expect(right.body.code).toBe('LOGIN_OTP_TOO_MANY_ATTEMPTS');
  });

  it('gives the same answer for an unknown verification id (no enumeration)', async () => {
    const res = await verify('00000000-0000-4000-8000-000000000000', '123456');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('LOGIN_OTP_SESSION_INVALID');
  });

  it('validates the body', async () => {
    const res = await verify('not-a-uuid', '12ab');
    expect(res.status).toBe(400);
    expect(res.body.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['verificationId', 'otp']));
  });

  it('a new sign-in supersedes the previous attempt', async () => {
    const email = await newUser();
    const first = await login(email);
    const firstCode = lastCode();
    const second = await login(email);
    const secondCode = lastCode();

    expect((await verify(first.body.data.verificationId, firstCode)).body.code).toBe('LOGIN_OTP_SESSION_INVALID');
    expect((await verify(second.body.data.verificationId, secondCode)).status).toBe(200);
  });
});

describe('login OTP — resend', () => {
  /** Pretends the cooldown has passed. */
  const skipCooldown = (id: string) => prisma.loginOtp.update({ where: { id }, data: { lastSentAt: new Date(Date.now() - 61_000) } });

  it('enforces the 60-second cooldown', async () => {
    const { verificationId } = await startLogin();
    const res = await resend(verificationId);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('LOGIN_OTP_RESEND_COOLDOWN');
    expect(res.body.message).toMatch(/wait \d+ seconds/);
    expect(mailed).toHaveBeenCalledTimes(1);
  });

  it('sends a new code, retires the old one and resets the attempt count', async () => {
    const { verificationId, code: oldCode } = await startLogin();
    for (let i = 0; i < 5; i++) await verify(verificationId, wrong(oldCode));
    await skipCooldown(verificationId);

    const res = await resend(verificationId);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ verificationId, expiresAt: expect.any(String), resendAvailableAt: expect.any(String) });
    const newCode = lastCode();
    expect(JSON.stringify(res.body)).not.toContain(newCode);

    if (newCode !== oldCode) expect((await verify(verificationId, oldCode)).body.code).toBe('LOGIN_OTP_INVALID');
    expect((await verify(verificationId, newCode)).status).toBe(200);
  });

  it('caps the number of codes per sign-in attempt', async () => {
    const { verificationId } = await startLogin();
    await prisma.loginOtp.update({ where: { id: verificationId }, data: { sendCount: 5, lastSentAt: new Date(Date.now() - 61_000) } });
    const res = await resend(verificationId);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('LOGIN_OTP_RESEND_LIMIT');
  });

  it('lets the user retry at once when the email could not be sent', async () => {
    const { verificationId } = await startLogin();
    await skipCooldown(verificationId);
    mailed.mockRejectedValueOnce(new Error('SMTP down'));
    expect((await resend(verificationId)).body.code).toBe('EMAIL_DELIVERY_FAILED');
    expect((await resend(verificationId)).status).toBe(200);
  });
});

describe('login OTP — switched off', () => {
  it('keeps the existing single-step login', async () => {
    const email = await newUser();
    env.LOGIN_OTP_ENABLED = false;
    try {
      const res = await login(email);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ requiresOtp: false, accessToken: expect.any(String) });
      expect(mailed).not.toHaveBeenCalled();
    } finally {
      env.LOGIN_OTP_ENABLED = true;
    }
  });
});
