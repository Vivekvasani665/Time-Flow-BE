import { describe, expect, it } from 'vitest';
import { generateTotp, totpStep } from '../src/common/utils/totp';
import { api, nextIp, signUpAndLogin, unique } from './helpers';
import { createSoftAuthenticator } from './soft-authenticator';

const PASSWORD = 'Passkey12345';

async function newUser() {
  const email = `${unique('pk')}@example.com`;
  const res = await signUpAndLogin({ firstName: 'Pat', lastName: 'Key', email, password: PASSWORD });
  const token: string = res.body.data.accessToken;
  return { email, auth: (r: ReturnType<ReturnType<typeof api>['get']>) => r.set('Authorization', `Bearer ${token}`) };
}

/** Registers a software passkey the way the browser would. */
async function addPasskey(user: Awaited<ReturnType<typeof newUser>>, authenticator = createSoftAuthenticator()) {
  const options = await user.auth(api().post('/api/auth/me/2fa/passkeys/options')).send({ password: PASSWORD });
  expect(options.status).toBe(200);
  const res = await user.auth(api().post('/api/auth/me/2fa/passkeys')).send({ response: authenticator.register(options.body.data.challenge), name: 'Test key' });
  return { res, authenticator };
}

const login = (email: string) => api().post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password: PASSWORD });
const passkeyOptions = (challengeToken: string) =>
  api().post('/api/auth/login/2fa/passkey/options').set('X-Forwarded-For', nextIp()).send({ challengeToken });
const passkeyLogin = (challengeToken: string, response: unknown) =>
  api().post('/api/auth/login/2fa/passkey').set('X-Forwarded-For', nextIp()).send({ challengeToken, response });

describe('passkeys', () => {
  it('registering needs the password, and the first passkey turns 2FA on with recovery codes', async () => {
    const user = await newUser();
    const denied = await user.auth(api().post('/api/auth/me/2fa/passkeys/options')).send({ password: 'wrong-password-1' });
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe('INVALID_PASSWORD');

    const { res } = await addPasskey(user);
    expect(res.status).toBe(201);
    expect(res.body.data.passkey).toMatchObject({ name: 'Test key' });
    expect(res.body.data.recoveryCodes).toHaveLength(10);

    const status = await user.auth(api().get('/api/auth/me/2fa'));
    expect(status.body.data).toMatchObject({ enabled: true, totp: { enabled: false, pending: false } });
    expect(status.body.data.passkeys).toHaveLength(1);
    // Nothing secret leaves the server.
    expect(status.body.data.passkeys[0]).not.toHaveProperty('publicKey');

    // A second passkey does not replace the recovery codes.
    const second = await addPasskey(user);
    expect(second.res.body.data.recoveryCodes).toBeNull();
  });

  it('signs in with a passkey, and each challenge works once', async () => {
    const user = await newUser();
    const { authenticator } = await addPasskey(user);

    const first = await login(user.email);
    expect(first.body.data).toMatchObject({ twoFactorRequired: true, methods: ['passkey', 'recovery'] });
    const { challengeToken } = first.body.data;

    const options = await passkeyOptions(challengeToken);
    expect(options.status).toBe(200);
    expect(options.body.data.allowCredentials).toEqual([expect.objectContaining({ id: authenticator.id })]);
    const assertion = authenticator.authenticate(options.body.data.challenge);

    const ok = await passkeyLogin(challengeToken, assertion);
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.email).toBe(user.email);

    // The signed WebAuthn challenge is spent: replaying the same assertion fails.
    const replay = await passkeyLogin(challengeToken, assertion);
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('PASSKEY_CHALLENGE_EXPIRED');
  });

  it('refuses a signature made for another site, and a passkey from another account', async () => {
    const user = await newUser();
    const { authenticator } = await addPasskey(user);
    const stranger = createSoftAuthenticator();

    const { challengeToken } = (await login(user.email)).body.data;
    const phished = authenticator.authenticate((await passkeyOptions(challengeToken)).body.data.challenge, 'https://evil.example');
    const res = await passkeyLogin(challengeToken, phished);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSKEY_VERIFICATION_FAILED');

    const foreign = stranger.authenticate((await passkeyOptions(challengeToken)).body.data.challenge);
    expect((await passkeyLogin(challengeToken, foreign)).body.code).toBe('PASSKEY_VERIFICATION_FAILED');
  });

  it('turns 2FA off with the password plus a passkey', async () => {
    const user = await newUser();
    const { authenticator } = await addPasskey(user);

    const options = await user.auth(api().post('/api/auth/me/2fa/step-up/options'));
    const disable = await user.auth(api().post('/api/auth/me/2fa/disable')).send({ password: PASSWORD, passkey: authenticator.authenticate(options.body.data.challenge) });
    expect(disable.status).toBe(200);

    const res = await login(user.email);
    expect(res.body.data.twoFactorRequired).toBe(false);
  });

  it('removing the last method turns 2FA off; with an authenticator app left it stays on', async () => {
    const user = await newUser();
    await addPasskey(user);

    // Add an authenticator app next to the passkey: no new recovery codes.
    const setup = await user.auth(api().post('/api/auth/me/2fa/setup')).send({ password: PASSWORD });
    const enable = await user.auth(api().post('/api/auth/me/2fa/enable')).send({ code: generateTotp(setup.body.data.secret, totpStep()) });
    expect(enable.status).toBe(200);
    expect(enable.body.data.recoveryCodes).toBeNull();
    expect((await login(user.email)).body.data.methods).toEqual(['totp', 'passkey', 'recovery']);

    const { passkeys } = (await user.auth(api().get('/api/auth/me/2fa'))).body.data;
    const removed = await user.auth(api().delete(`/api/auth/me/2fa/passkeys/${passkeys[0].id}`)).send({ password: PASSWORD });
    expect(removed.body.data).toEqual({ twoFactorEnabled: true });

    const noTotp = await user.auth(api().delete('/api/auth/me/2fa/totp')).send({ password: PASSWORD });
    expect(noTotp.body.data).toEqual({ twoFactorEnabled: false });
    expect((await login(user.email)).body.data.twoFactorRequired).toBe(false);
  });
});
