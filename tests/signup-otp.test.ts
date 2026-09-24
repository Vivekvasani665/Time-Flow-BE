import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import * as mailer from '../src/queue/mailer';
import * as sms from '../src/queue/sms';
import { producers } from '../src/queue/producers';
import { api, EMAILS, nextIp, unique, uniquePhone } from './helpers';

const PASSWORD = 'Signup1234';

let emailedOtp = '';
let textedOtp = '';
let smsFails: sms.SmsFailureCode | null = null;

beforeEach(() => {
  emailedOtp = '';
  textedOtp = '';
  smsFails = null;
  vi.spyOn(mailer, 'sendMail').mockImplementation(async (msg) => {
    emailedOtp = /\b(\d{6})\b/.exec(msg.subject)?.[1] ?? '';
    return 'test-msg-id';
  });
  vi.spyOn(sms.smsService, 'sendMessage').mockImplementation(async (msg) => {
    if (smsFails) throw new sms.SmsError(smsFails, 'provider down');
    textedOtp = msg.vars?.otp ?? '';
    return 'test-sms-id';
  });
});

const newUser = () => ({ firstName: 'Sam', lastName: 'Rivera', email: `${unique('signup')}@timeflow.dev`, phone: uniquePhone(), password: PASSWORD });
const register = (body: Record<string, unknown>) => api().post('/api/auth/register').set('X-Forwarded-For', nextIp()).send(body);
const verify = (verificationId: string, otp: string) =>
  api().post('/api/auth/register/verify-otp').set('X-Forwarded-For', nextIp()).send({ verificationId, otp });
const resend = (verificationId: string, channel?: string) =>
  api().post('/api/auth/register/resend-otp').set('X-Forwarded-For', nextIp()).send({ verificationId, ...(channel ? { channel } : {}) });
const login = (email: string, password = PASSWORD) => api().post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password });
const wrong = (otp: string) => (otp === '000000' ? '111111' : '000000');

describe('Signup with email + SMS OTP', () => {
  it('runs the full flow: register (pending) → same code by email and SMS → verify → active → login', async () => {
    const body = newUser();
    const res = await register(body);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      requiresVerification: true,
      channels: ['email', 'sms'],
      delivery: { email: { status: 'sent' }, sms: { status: 'sent' } },
      expiresInSeconds: 300,
    });
    expect(JSON.stringify(res.body)).not.toContain(emailedOtp);
    expect(res.body.data.phone).toMatch(/^\+91\*+\d{4}$/);
    expect(res.headers['set-cookie']).toBeUndefined();

    expect(emailedOtp).toMatch(/^\d{6}$/);
    expect(textedOtp).toBe(emailedOtp);

    const user = await prisma.user.findFirstOrThrow({ where: { email: body.email }, include: { role: true } });
    expect(user).toMatchObject({ status: 'PENDING', phone: body.phone, role: { name: 'Employee' } });
    const row = await prisma.signupOtp.findUniqueOrThrow({ where: { id: res.body.data.verificationId } });
    expect(row.otpHash).not.toContain(emailedOtp);
    expect(row.userId).toBe(user.id);

    // Unverified accounts cannot sign in.
    const early = await login(body.email);
    expect(early.status).toBe(403);
    expect(early.body.code).toBe('ACCOUNT_NOT_VERIFIED');

    const ok = await verify(res.body.data.verificationId, textedOtp);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ verified: true, user: { id: user.id, email: body.email } });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe('ACTIVE');
    expect(producers.welcomeEmail).toHaveBeenCalledWith(expect.objectContaining({ id: user.id }), user.id);

    // Single use.
    expect((await verify(res.body.data.verificationId, textedOtp)).body.code).toBe('SIGNUP_OTP_SESSION_INVALID');

    const signedIn = await login(body.email);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user).toMatchObject({ email: body.email, status: 'ACTIVE', phone: body.phone });
  });

  it('counts wrong codes and locks the code after 5', async () => {
    const res = await register(newUser());
    const id = res.body.data.verificationId;
    const bad = wrong(emailedOtp);
    const first = await verify(id, bad);
    expect(first.status).toBe(400);
    expect(first.body).toMatchObject({ code: 'SIGNUP_OTP_INVALID', message: 'Incorrect code. 4 attempts left.' });
    for (let i = 0; i < 3; i++) await verify(id, bad);
    expect((await verify(id, bad)).body.code).toBe('SIGNUP_OTP_TOO_MANY_ATTEMPTS');
    expect((await verify(id, emailedOtp)).body.code).toBe('SIGNUP_OTP_TOO_MANY_ATTEMPTS');
  });

  it('rejects an expired code', async () => {
    const res = await register(newUser());
    await prisma.signupOtp.update({ where: { id: res.body.data.verificationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const out = await verify(res.body.data.verificationId, emailedOtp);
    expect(out.status).toBe(401);
    expect(out.body.code).toBe('SIGNUP_OTP_EXPIRED');
  });

  it('resends on one channel after the cooldown, and the old code stops working', async () => {
    const res = await register(newUser());
    const id = res.body.data.verificationId;
    const oldCode = emailedOtp;

    const tooSoon = await resend(id, 'sms');
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.code).toBe('SIGNUP_OTP_RESEND_COOLDOWN');

    await prisma.signupOtp.update({ where: { id }, data: { lastSentAt: new Date(Date.now() - 60_000) } });
    emailedOtp = '';
    const again = await resend(id, 'sms');
    expect(again.status).toBe(200);
    expect(again.body.data.channels).toEqual(['sms']);
    expect(again.body.message).toMatch(/mobile number/);
    expect(emailedOtp).toBe(''); // SMS only
    expect(textedOtp).toMatch(/^\d{6}$/);

    if (oldCode !== textedOtp) expect((await verify(id, oldCode)).body.code).toBe('SIGNUP_OTP_INVALID');
    expect((await verify(id, textedOtp)).status).toBe(200);
  });

  it('still creates the account (201) when only email delivers, and says why SMS failed', async () => {
    smsFails = 'SMS_PROVIDER_AUTH_FAILED';
    const res = await register(newUser());
    expect(res.status).toBe(201);
    expect(res.body.data.channels).toEqual(['email']);
    expect(res.body.data.delivery).toEqual({ email: { status: 'sent' }, sms: { status: 'failed', code: 'SMS_PROVIDER_AUTH_FAILED' } });
    expect(res.body.message).toBe('Verification code sent to your email');
    // The emailed code still verifies the account.
    expect((await verify(res.body.data.verificationId, emailedOtp)).status).toBe(200);
  });

  it('answers 503 and removes the pending user when no channel delivers', async () => {
    smsFails = 'SMS_SEND_FAILED';
    const body = { ...newUser(), email: `${unique('nodeliver')}+fail@example.com` };
    vi.mocked(mailer.sendMail).mockRejectedValueOnce(new Error('smtp down'));
    const res = await register(body);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('OTP_DELIVERY_FAILED');
    expect(await prisma.user.count({ where: { email: body.email } })).toBe(0);
  });

  it('resends on email only', async () => {
    const res = await register(newUser());
    const id = res.body.data.verificationId;
    await prisma.signupOtp.update({ where: { id }, data: { lastSentAt: new Date(Date.now() - 60_000) } });
    textedOtp = '';
    const again = await resend(id, 'email');
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ channels: ['email'], delivery: { email: { status: 'sent' } } });
    expect(textedOtp).toBe('');
    expect((await verify(id, emailedOtp)).status).toBe(200);
  });

  it('refuses a taken email or mobile number, but replaces an unverified signup', async () => {
    const takenEmail = await register({ ...newUser(), email: EMAILS.manager });
    expect(takenEmail.status).toBe(409);
    expect(takenEmail.body.code).toBe('USER_EMAIL_EXISTS');

    const first = newUser();
    const a = await register(first);
    const verified = await verify(a.body.data.verificationId, emailedOtp);
    expect(verified.status).toBe(200);
    // Same digits, different formatting.
    const spaced = `${first.phone.slice(0, 3)} ${first.phone.slice(3, 8)}-${first.phone.slice(8)}`;
    const takenPhone = await register({ ...newUser(), phone: spaced });
    expect(takenPhone.status).toBe(409);
    expect(takenPhone.body.code).toBe('USER_PHONE_EXISTS');

    const pending = newUser();
    const p1 = await register(pending);
    const p2 = await register({ ...pending, firstName: 'Samuel' });
    expect(p2.status).toBe(201);
    const rows = await prisma.user.findMany({ where: { email: pending.email } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ firstName: 'Samuel', status: 'PENDING' });
    expect((await verify(p1.body.data.verificationId, emailedOtp)).body.code).toBe('SIGNUP_OTP_SESSION_INVALID');
  });

  it('refuses a client-chosen role or status', async () => {
    const res = await register({ ...newUser(), roleId: '00000000-0000-0000-0000-000000000000', status: 'ACTIVE' });
    expect(res.status).toBe(400);
  });

  it('validates the body, including the mobile number', async () => {
    const res = await register({ firstName: '', lastName: 'X', email: 'not-an-email', phone: '98765', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    const paths = res.body.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['firstName', 'email', 'phone', 'password']));

    const noPhone = await register({ ...newUser(), phone: undefined });
    expect(noPhone.status).toBe(400);
  });
});
