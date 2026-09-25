import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { base32Encode, generateTotp, totpStep, verifyTotp } from '../src/common/utils/totp';
import { api, loginAs, nextIp, signUpAndLogin, unique } from './helpers';

const PASSWORD = 'TwoFactor123';

const cookieNames = (res: { headers: Record<string, unknown> }) =>
  ((res.headers['set-cookie'] as string[] | undefined) ?? []).map((c) => c.split('=')[0]);

/**
 * A code for a step the server has not yet accepted. Steps −1…+1 around now
 * are valid, and each accepted step must be later than the last, so a test can
 * make up to three code-based calls: `code(secret, -1)`, `code(secret)`, `code(secret, 1)`.
 */
const code = (secret: string, offset = 0) => generateTotp(secret, totpStep() + offset);

async function newUser() {
  const email = `${unique('tfa')}@example.com`;
  const res = await signUpAndLogin({ firstName: 'Tess', lastName: 'Factor', email, password: PASSWORD });
  const token: string = res.body.data.accessToken;
  return { email, userId: res.body.data.user.id as string, auth: (r: ReturnType<ReturnType<typeof api>['get']>) => r.set('Authorization', `Bearer ${token}`) };
}

/** A registered user with 2FA already on. Consumes step −1 and one code attempt. */
async function enrolledUser() {
  const user = await newUser();
  const setup = await user.auth(api().post('/api/auth/me/2fa/setup'));
  expect(setup.status).toBe(200);
  const secret: string = setup.body.data.secret;
  const enable = await user.auth(api().post('/api/auth/me/2fa/enable')).send({ code: code(secret, -1) });
  expect(enable.status).toBe(200);
  return { ...user, secret, recoveryCodes: enable.body.data.recoveryCodes as string[] };
}

const login = (email: string, password = PASSWORD) =>
  api().post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password });

const loginTwoFactor = (challengeToken: string, c: string) =>
  api().post('/api/auth/login/2fa').set('X-Forwarded-For', nextIp()).send({ challengeToken, code: c });

describe('TOTP', () => {
  // RFC 6238 appendix B, SHA-1 secret, truncated to 6 digits.
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it('matches the RFC 6238 test vectors', () => {
    expect(generateTotp(secret, totpStep(59_000))).toBe('287082');
    expect(generateTotp(secret, totpStep(1_111_111_109_000))).toBe('081804');
    expect(generateTotp(secret, totpStep(2_000_000_000_000))).toBe('279037');
  });

  it('accepts one step of clock drift either way, and no more', () => {
    const at = 1_111_111_109_000;
    const step = totpStep(at);
    expect(verifyTotp(secret, generateTotp(secret, step - 1), at)).toBe(step - 1);
    expect(verifyTotp(secret, generateTotp(secret, step + 1), at)).toBe(step + 1);
    expect(verifyTotp(secret, generateTotp(secret, step + 2), at)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', at)).toBeNull();
  });
});

describe('2FA enrolment', () => {
  it('sets up with a QR code, confirms with a code and returns recovery codes', async () => {
    const user = await newUser();

    const before = await user.auth(api().get('/api/auth/me/2fa'));
    expect(before.body.data).toMatchObject({ enabled: false, recoveryCodesRemaining: 0 });

    const setup = await user.auth(api().post('/api/auth/me/2fa/setup'));
    expect(setup.status).toBe(200);
    const { secret, otpauthUrl, qrCodeDataUrl } = setup.body.data;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUrl).toContain(`otpauth://totp/TimeFlow%3A${encodeURIComponent(user.email)}?secret=${secret}`);
    expect(qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);

    const wrong = await user.auth(api().post('/api/auth/me/2fa/enable')).send({ code: '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('INVALID_TWO_FACTOR_CODE');

    const enable = await user.auth(api().post('/api/auth/me/2fa/enable')).send({ code: code(secret) });
    expect(enable.status).toBe(200);
    expect(enable.body.data.recoveryCodes).toHaveLength(10);
    expect(enable.body.data.recoveryCodes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);

    const after = await user.auth(api().get('/api/auth/me/2fa'));
    expect(after.body.data).toMatchObject({ enabled: true, recoveryCodesRemaining: 10 });
    const me = await user.auth(api().get('/api/auth/me'));
    expect(me.body.data.twoFactorEnabled).toBe(true);

    const again = await user.auth(api().post('/api/auth/me/2fa/setup'));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('TWO_FACTOR_ALREADY_ENABLED');
  });

  it('refuses to enable before setup', async () => {
    const user = await newUser();
    const res = await user.auth(api().post('/api/auth/me/2fa/enable')).send({ code: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TWO_FACTOR_SETUP_REQUIRED');
  });
});

describe('2FA sign-in', () => {
  it('asks for a code instead of issuing a session, then signs in with it', async () => {
    const user = await enrolledUser();

    const first = await login(user.email);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ twoFactorRequired: true, challengeToken: expect.any(String) });
    expect(first.body.data).not.toHaveProperty('accessToken');
    expect(cookieNames(first)).toEqual([]);

    const wrong = await loginTwoFactor(first.body.data.challengeToken, '000000');
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('INVALID_TWO_FACTOR_CODE');

    const good = code(user.secret);
    const ok = await loginTwoFactor(first.body.data.challengeToken, good);
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.email).toBe(user.email);
    expect(ok.body.data.accessToken).toBeTruthy();
    expect(cookieNames(ok)).toEqual(expect.arrayContaining(['tf_access', 'tf_refresh', 'tf_session']));

    // The same code cannot be replayed, even inside its 30-second window.
    const replay = await loginTwoFactor(first.body.data.challengeToken, good);
    expect(replay.status).toBe(401);
  });

  it('spends the challenge on success, but not on a wrong code', async () => {
    const user = await enrolledUser();
    const { challengeToken } = (await login(user.email)).body.data;

    expect((await loginTwoFactor(challengeToken, '000000')).status).toBe(401);
    expect((await loginTwoFactor(challengeToken, code(user.secret))).status).toBe(200);

    // A fresh, valid code still cannot turn the same challenge into a second session.
    const reused = await loginTwoFactor(challengeToken, code(user.secret, 1));
    expect(reused.status).toBe(401);
    expect(reused.body.code).toBe('TWO_FACTOR_CHALLENGE_INVALID');
  });

  it('tells an expired challenge apart from an invalid one', async () => {
    const user = await enrolledUser();
    const expired = jwt.sign({ sub: user.userId, tv: 0, exp: Math.floor(Date.now() / 1000) - 5 }, env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      issuer: 'timeflow-api',
      audience: 'timeflow-2fa',
      jwtid: 'expired-challenge',
    });
    const res = await loginTwoFactor(expired, code(user.secret));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TWO_FACTOR_CHALLENGE_EXPIRED');

    const garbage = await loginTwoFactor('not-a-token', '123456');
    expect(garbage.body.code).toBe('TWO_FACTOR_CHALLENGE_INVALID');
  });

  it('accepts each recovery code once', async () => {
    const user = await enrolledUser();
    const { challengeToken } = (await login(user.email)).body.data;
    const recovery = user.recoveryCodes[3]!.toUpperCase();

    const ok = await loginTwoFactor(challengeToken, recovery);
    expect(ok.status).toBe(200);
    expect(ok.body.data.recoveryCodesRemaining).toBe(9);

    // A new sign-in, so it is the recovery code — not the spent challenge — being refused.
    const again = (await login(user.email)).body.data.challengeToken;
    const reused = await loginTwoFactor(again, recovery);
    expect(reused.status).toBe(401);
    expect(reused.body.code).toBe('INVALID_TWO_FACTOR_CODE');
  });

  it('keeps challenge tokens and access tokens apart', async () => {
    const user = await enrolledUser();
    const { challengeToken } = (await login(user.email)).body.data;

    const asBearer = await api().get('/api/auth/me').set('Authorization', `Bearer ${challengeToken}`);
    expect(asBearer.status).toBe(401);

    const { token } = await loginAs('manager');
    const asChallenge = await loginTwoFactor(token, '123456');
    expect(asChallenge.status).toBe(401);
    expect(asChallenge.body.code).toBe('TWO_FACTOR_CHALLENGE_INVALID');
  });

  it('limits code guesses per user, across IPs', async () => {
    const user = await enrolledUser();
    const { challengeToken } = (await login(user.email)).body.data;
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await loginTwoFactor(challengeToken, '000000')).status);
    // enrolledUser() spent one of the five attempts.
    expect(statuses).toEqual([401, 401, 401, 401, 429]);
  });

  it('leaves accounts without 2FA signing in as before', async () => {
    const res = await api().post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email: 'manager@timeflow.dev', password: 'Password123!' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ twoFactorRequired: false, accessToken: expect.any(String) });
  });
});

describe('2FA management', () => {
  it('disables only with the password and a code', async () => {
    const user = await enrolledUser();

    const badPassword = await user.auth(api().post('/api/auth/me/2fa/disable')).send({ password: 'nope-nope-1', code: code(user.secret) });
    expect(badPassword.status).toBe(400);
    expect(badPassword.body.code).toBe('INVALID_PASSWORD');

    const disable = await user.auth(api().post('/api/auth/me/2fa/disable')).send({ password: PASSWORD, code: code(user.secret) });
    expect(disable.status).toBe(200);

    const res = await login(user.email);
    expect(res.body.data).toMatchObject({ twoFactorRequired: false, accessToken: expect.any(String) });
  });

  it('regenerating recovery codes retires the old ones', async () => {
    const user = await enrolledUser();
    const regen = await user.auth(api().post('/api/auth/me/2fa/recovery-codes')).send({ code: code(user.secret) });
    expect(regen.status).toBe(200);
    expect(regen.body.data.recoveryCodes).toHaveLength(10);

    const { challengeToken } = (await login(user.email)).body.data;
    expect((await loginTwoFactor(challengeToken, user.recoveryCodes[0]!)).status).toBe(401);
    expect((await loginTwoFactor(challengeToken, regen.body.data.recoveryCodes[0])).status).toBe(200);
  });

  it('lets an admin reset a locked-out user, but not an employee', async () => {
    const user = await enrolledUser();
    const employee = await loginAs('employee');
    const denied = await employee.auth(api().post(`/api/users/${user.userId}/2fa/reset`));
    expect(denied.status).toBe(403);

    const admin = await loginAs('superadmin');
    const reset = await admin.auth(api().post(`/api/users/${user.userId}/2fa/reset`));
    expect(reset.status).toBe(200);

    const res = await login(user.email);
    expect(res.body.data.twoFactorRequired).toBe(false);
    const again = await admin.auth(api().post(`/api/users/${user.userId}/2fa/reset`));
    expect(again.body.code).toBe('TWO_FACTOR_NOT_ENABLED');
  });
});
