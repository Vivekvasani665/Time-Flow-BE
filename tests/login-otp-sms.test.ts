import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import * as mailer from '../src/queue/mailer';
import * as sms from '../src/queue/sms';
import { hashPassword } from '../src/modules/auth/auth.service';
import { api, nextIp, roleId, unique, uniquePhone } from './helpers';

const PASSWORD = 'LoginSms123';
const mutableEnv = env as { LOGIN_OTP_ENABLED: boolean };
const original = env.LOGIN_OTP_ENABLED;

let emailedOtp = '';
let textedOtp = '';
let textedTo = '';
let smsFails: sms.SmsFailureCode | null = null;
let emailFails = false;

beforeAll(() => {
  mutableEnv.LOGIN_OTP_ENABLED = true;
});
afterAll(() => {
  mutableEnv.LOGIN_OTP_ENABLED = original;
});

beforeEach(() => {
  emailedOtp = textedOtp = textedTo = '';
  smsFails = null;
  emailFails = false;
  vi.spyOn(mailer, 'sendMail').mockImplementation(async (msg) => {
    if (emailFails) throw new Error('smtp down');
    emailedOtp = /\b(\d{6})\b/.exec(msg.subject)?.[1] ?? '';
    return 'test-msg-id';
  });
  vi.spyOn(sms.smsService, 'sendMessage').mockImplementation(async (msg) => {
    if (smsFails) throw new sms.SmsError(smsFails, 'provider said no');
    textedOtp = msg.vars?.otp ?? '';
    textedTo = msg.to;
    return 'test-sms-id';
  });
});

async function makeUser(phone: string | null) {
  const email = `${unique('loginsms')}@timeflow.dev`;
  await prisma.user.create({
    data: { firstName: 'Lia', lastName: 'Sms', email, phone, status: 'ACTIVE', roleId: await roleId('Employee'), passwordHash: await hashPassword(PASSWORD) },
  });
  return email;
}

const login = (email: string) => api().post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password: PASSWORD });
const verify = (verificationId: string, otp: string) =>
  api().post('/api/auth/login/otp/verify').set('X-Forwarded-For', nextIp()).send({ verificationId, otp });
const resend = (verificationId: string, channel?: string) =>
  api().post('/api/auth/login/otp/resend').set('X-Forwarded-For', nextIp()).send({ verificationId, ...(channel ? { channel } : {}) });
const coolDown = (id: string) => prisma.loginOtp.update({ where: { id }, data: { lastSentAt: new Date(Date.now() - 120_000) } });

describe('Login OTP by email + SMS', () => {
  it('sends ONE code to both the email and the mobile number, and it signs in once', async () => {
    const phone = uniquePhone();
    const email = await makeUser(phone);
    const res = await login(email);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      requiresOtp: true,
      channels: ['email', 'sms'],
      emailSent: true,
      smsSent: true,
      delivery: { email: { status: 'sent' }, sms: { status: 'sent' } },
    });
    expect(res.body.data.phone).toMatch(/^\+\d{2}\*+\d{4}$/);
    expect(res.body.message).toBe('OTP sent to your email and mobile number');
    expect(res.headers['set-cookie']).toBeUndefined();

    expect(emailedOtp).toMatch(/^\d{6}$/);
    expect(textedOtp).toBe(emailedOtp);
    expect(textedTo).toBe(phone);
    expect(JSON.stringify(res.body)).not.toContain(emailedOtp);

    const row = await prisma.loginOtp.findUniqueOrThrow({ where: { id: res.body.data.verificationId } });
    expect(row.channels).toEqual(['email', 'sms']);
    expect(row.otpHash).not.toContain(textedOtp);

    const ok = await verify(res.body.data.verificationId, textedOtp);
    expect(ok.status).toBe(200);
    expect((ok.headers['set-cookie'] as unknown as string[]).join('\n')).toMatch(/tf_access=/);
    expect((await verify(res.body.data.verificationId, textedOtp)).body.code).toBe('LOGIN_OTP_SESSION_INVALID');
  });

  it('keeps an existing user without a mobile number on email only', async () => {
    const res = await login(await makeUser(null));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ channels: ['email'], emailSent: true, smsSent: false, phone: null, delivery: { email: { status: 'sent' } } });
    expect(sms.smsService.sendMessage).not.toHaveBeenCalled();
    expect(res.body.message).toBe('OTP sent to your email');
  });

  it('does not pretend the SMS went out when the provider fails, but the emailed code still works', async () => {
    smsFails = 'SMS_PROVIDER_AUTH_FAILED';
    const res = await login(await makeUser(uniquePhone()));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      channels: ['email'],
      emailSent: true,
      smsSent: false,
      delivery: { sms: { status: 'failed', code: 'SMS_PROVIDER_AUTH_FAILED' } },
    });
    expect((await verify(res.body.data.verificationId, emailedOtp)).status).toBe(200);
  });

  it('signs in with the SMS code when email delivery fails', async () => {
    emailFails = true;
    const res = await login(await makeUser(uniquePhone()));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ channels: ['sms'], emailSent: false, smsSent: true, delivery: { email: { status: 'failed', code: 'EMAIL_DELIVERY_FAILED' } } });
    expect((await verify(res.body.data.verificationId, textedOtp)).status).toBe(200);
  });

  it('answers 503 with per-channel reasons when nothing was delivered', async () => {
    emailFails = true;
    smsFails = 'SMS_PROVIDER_UNAVAILABLE';
    const both = await login(await makeUser(uniquePhone()));
    expect(both.status).toBe(503);
    expect(both.body.code).toBe('OTP_DELIVERY_FAILED');
    expect(both.body.details).toEqual([
      { path: 'email', message: 'EMAIL_DELIVERY_FAILED' },
      { path: 'sms', message: 'SMS_PROVIDER_UNAVAILABLE' },
    ]);

    const emailOnly = await login(await makeUser(null));
    expect(emailOnly.status).toBe(503);
    expect(emailOnly.body.code).toBe('EMAIL_DELIVERY_FAILED');
  });

  it('reports a stored number without a country code instead of guessing one', async () => {
    const res = await login(await makeUser('98765 43210'));
    expect(res.body.data).toMatchObject({ channels: ['email'], smsSent: false, delivery: { sms: { status: 'failed', code: 'INVALID_PHONE_NUMBER' } } });
    expect(sms.smsService.sendMessage).not.toHaveBeenCalled();
  });

  it('resends: 429 during the cooldown, then a NEW code by SMS only; the old code dies', async () => {
    const res = await login(await makeUser(uniquePhone()));
    const id = res.body.data.verificationId;
    const oldCode = textedOtp;

    const early = await resend(id);
    expect(early.status).toBe(429);
    expect(early.body.code).toBe('LOGIN_OTP_RESEND_COOLDOWN');

    await coolDown(id);
    emailedOtp = '';
    const again = await resend(id, 'sms');
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ channels: ['sms'], smsSent: true, emailSent: false });
    expect(again.body.message).toBe('A new code has been sent to your mobile number');
    expect(emailedOtp).toBe('');

    if (oldCode !== textedOtp) expect((await verify(id, oldCode)).body.code).toBe('LOGIN_OTP_INVALID');
    expect((await verify(id, textedOtp)).status).toBe(200);
  });

  it('resends to both channels by default (the old request body still works)', async () => {
    const res = await login(await makeUser(uniquePhone()));
    await coolDown(res.body.data.verificationId);
    const again = await resend(res.body.data.verificationId);
    expect(again.status).toBe(200);
    expect(again.body.data.channels).toEqual(['email', 'sms']);
    expect(textedOtp).toBe(emailedOtp);
  });

  it('refuses an SMS resend for an account with no mobile number', async () => {
    const res = await login(await makeUser(null));
    await coolDown(res.body.data.verificationId);
    const again = await resend(res.body.data.verificationId, 'sms');
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('INVALID_PHONE_NUMBER');
  });

  it('locks the code after 5 wrong attempts and rejects an expired code', async () => {
    const res = await login(await makeUser(uniquePhone()));
    const id = res.body.data.verificationId;
    const wrong = textedOtp === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) expect((await verify(id, wrong)).body.code).toBe('LOGIN_OTP_INVALID');
    expect((await verify(id, wrong)).status).toBe(429);
    expect((await verify(id, textedOtp)).body.code).toBe('LOGIN_OTP_TOO_MANY_ATTEMPTS');

    const res2 = await login(await makeUser(uniquePhone()));
    await prisma.loginOtp.update({ where: { id: res2.body.data.verificationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await verify(res2.body.data.verificationId, textedOtp);
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('LOGIN_OTP_EXPIRED');
  });

  it('with Twilio Verify, the SMS carries its own code and either code signs in', async () => {
    vi.spyOn(sms.smsService, 'providerGeneratesCode').mockReturnValue(true);
    const check = vi.spyOn(sms.smsService, 'checkOtp').mockImplementation(async (_to, code) => code === '246810');

    const res = await login(await makeUser(uniquePhone()));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ channels: ['email', 'sms'], smsSent: true, sameCodeOnAllChannels: false });

    // A wrong code is checked against Twilio too, and still counts as one attempt.
    const wrong = await verify(res.body.data.verificationId, emailedOtp === '999999' ? '999998' : '999999');
    expect(wrong.body.code).toBe('LOGIN_OTP_INVALID');
    expect(check).toHaveBeenCalledTimes(1);

    const ok = await verify(res.body.data.verificationId, '246810'); // the code Twilio texted
    expect(ok.status).toBe(200);

    // The emailed code works as well, without asking Twilio.
    check.mockClear();
    const res2 = await login(await makeUser(uniquePhone()));
    expect((await verify(res2.body.data.verificationId, emailedOtp)).status).toBe(200);
    expect(check).not.toHaveBeenCalled();
  });
});
