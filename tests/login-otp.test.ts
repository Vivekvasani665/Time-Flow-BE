import { describe, expect, it, vi, beforeEach } from 'vitest';
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import * as mailer from '../src/queue/mailer';
import { api, EMAILS, nextIp, PASSWORD } from './helpers';

describe('Login OTP Flow & Database Model', () => {
  let capturedOtp = '';

  beforeEach(() => {
    capturedOtp = '';
    vi.spyOn(mailer, 'sendMail').mockImplementation(async (msg) => {
      const match = /\b(\d{6})\b/.exec(msg.text || msg.html);
      if (match) capturedOtp = match[1];
      return 'test-msg-id';
    });
  });

  it('verifies LoginOtp model exists and User relation loginOtps is queryable', async () => {
    const user = await prisma.user.findFirstOrThrow({
      where: { email: EMAILS.employee },
      include: { loginOtps: true },
    });

    expect(user).toBeDefined();
    expect(Array.isArray(user.loginOtps)).toBe(true);
  });

  it('runs complete Login OTP flow from POST /api/auth/login to POST /api/auth/login/otp/verify', async () => {
    // Temporarily enable LOGIN_OTP_ENABLED
    const originalSetting = env.LOGIN_OTP_ENABLED;
    (env as { LOGIN_OTP_ENABLED: boolean }).LOGIN_OTP_ENABLED = true;

    try {
      // Step 1: Login with credentials
      const ip = nextIp();
      const loginRes = await api()
        .post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: EMAILS.employee, password: PASSWORD });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.success).toBe(true);
      expect(loginRes.body.data.requiresOtp).toBe(true);
      expect(loginRes.body.data.verificationId).toBeDefined();
      expect(loginRes.body.data.email).toBeDefined();

      const verificationId = loginRes.body.data.verificationId;
      expect(capturedOtp).toMatch(/^\d{6}$/);

      // Step 2: Verify LoginOtp record exists in PostgreSQL database
      const otpRecord = await prisma.loginOtp.findUnique({
        where: { id: verificationId },
        include: { user: true },
      });
      expect(otpRecord).not.toBeNull();
      expect(otpRecord?.userId).toBe(otpRecord?.user.id);
      expect(otpRecord?.otpHash).toBeDefined();
      expect(otpRecord?.attempts).toBe(0);
      expect(otpRecord?.sendCount).toBe(1);
      expect(otpRecord?.usedAt).toBeNull();
      expect(otpRecord?.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // Step 3: Wrong OTP should be rejected
      const failRes = await api()
        .post('/api/auth/login/otp/verify')
        .set('X-Forwarded-For', ip)
        .send({ verificationId, otp: '000000' });

      expect(failRes.status).toBe(401);
      expect(failRes.body.code).toBe('LOGIN_OTP_INVALID');

      const afterFailRecord = await prisma.loginOtp.findUnique({ where: { id: verificationId } });
      expect(afterFailRecord?.attempts).toBe(1);

      // Step 4: Correct OTP should succeed on /api/auth/login/otp/verify
      const verifyRes = await api()
        .post('/api/auth/login/otp/verify')
        .set('X-Forwarded-For', ip)
        .send({ verificationId, otp: capturedOtp });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.success).toBe(true);
      expect(verifyRes.body.data.user.email).toBe(EMAILS.employee);
      expect(verifyRes.body.data.accessToken).toBeDefined();

      const cookies = (verifyRes.headers['set-cookie'] as unknown as string[]).join('\n');
      expect(cookies).toMatch(/tf_access=/);
      expect(cookies).toMatch(/tf_refresh=/);

      // Step 5: Verify record was marked used in PostgreSQL
      const usedRecord = await prisma.loginOtp.findUnique({ where: { id: verificationId } });
      expect(usedRecord?.usedAt).not.toBeNull();

      // Step 6: Cannot reuse the same OTP verificationId
      const replayRes = await api()
        .post('/api/auth/login/otp/verify')
        .set('X-Forwarded-For', ip)
        .send({ verificationId, otp: capturedOtp });

      expect(replayRes.status).toBe(401);
      expect(replayRes.body.code).toBe('LOGIN_OTP_SESSION_INVALID');
    } finally {
      (env as { LOGIN_OTP_ENABLED: boolean }).LOGIN_OTP_ENABLED = originalSetting;
    }
  });

  it('supports alias endpoint /api/auth/verify-login-otp as well', async () => {
    const originalSetting = env.LOGIN_OTP_ENABLED;
    (env as { LOGIN_OTP_ENABLED: boolean }).LOGIN_OTP_ENABLED = true;

    try {
      const ip = nextIp();
      const loginRes = await api()
        .post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: EMAILS.employee, password: PASSWORD });

      expect(loginRes.status).toBe(200);
      const verificationId = loginRes.body.data.verificationId;

      const verifyRes = await api()
        .post('/api/auth/verify-login-otp')
        .set('X-Forwarded-For', ip)
        .send({ verificationId, otp: capturedOtp });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.success).toBe(true);
      expect(verifyRes.body.data.user.email).toBe(EMAILS.employee);
    } finally {
      (env as { LOGIN_OTP_ENABLED: boolean }).LOGIN_OTP_ENABLED = originalSetting;
    }
  });
});
