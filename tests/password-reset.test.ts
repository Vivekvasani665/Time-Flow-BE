import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import * as mailer from '../src/queue/mailer';
import { api, loginAs, nextIp, signUpAndLogin, unique } from './helpers';

const OLD_PASSWORD = 'OldPassword123';
const NEW_PASSWORD = 'NewPassword123!';

let lastToken = '';

beforeEach(() => {
  lastToken = '';
  vi.spyOn(mailer, 'sendMail').mockImplementation(async (msg) => {
    const match = /reset-password\?token=([\w%-]+)/.exec(msg.text);
    if (match) lastToken = decodeURIComponent(match[1]);
    return 'test-msg-id';
  });
});

async function newMember() {
  const email = `${unique('reset')}@example.com`;
  const res = await signUpAndLogin({ firstName: 'Rhea', lastName: 'Set', email, password: OLD_PASSWORD });
  return { email, id: res.body.data.user.id as string, token: res.body.data.accessToken as string };
}

const sendReset = async (userId: string) => (await loginAs('superadmin')).auth(api().post(`/api/admin/users/${userId}/password-reset`));
const complete = (token: string, newPassword = NEW_PASSWORD, confirmPassword = newPassword) =>
  api().post('/api/auth/password-reset').set('X-Forwarded-For', nextIp()).send({ token, newPassword, confirmPassword });

describe('Administrator password reset', () => {
  it('runs the full flow: send → pending → verify → reset → completed → login with the new password', async () => {
    const member = await newMember();

    const sent = await sendReset(member.id);
    expect(sent.status).toBe(200);
    expect(sent.body.message).toBe('Password reset link sent successfully.');
    expect(sent.body.data.status).toBe('PENDING');
    expect(JSON.stringify(sent.body)).not.toContain(lastToken);
    expect(sent.body.data).not.toHaveProperty('tokenHash');
    expect(lastToken).toMatch(/^[\w-]{43}$/);

    const row = await prisma.passwordResetRequest.findFirstOrThrow({ where: { userId: member.id } });
    expect(row.tokenHash).not.toBe(lastToken);

    const verify = await api().get('/api/auth/password-reset/verify').query({ token: lastToken });
    expect(verify.status).toBe(200);
    expect(verify.body.data.valid).toBe(true);

    const done = await complete(lastToken);
    expect(done.status).toBe(200);
    expect(done.body.message).toBe('Password reset successfully.');

    const status = await (await loginAs('superadmin')).auth(api().get(`/api/admin/users/${member.id}/password-reset`));
    expect(status.body.data.status).toBe('COMPLETED');
    expect(status.body.data.completedAt).not.toBeNull();

    // Old sessions end; the old password stops working; the new one works.
    const me = await api().get('/api/auth/me').set('Authorization', `Bearer ${member.token}`);
    expect(me.status).toBe(401);
    const oldLogin = await api().post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email: member.email, password: OLD_PASSWORD });
    expect(oldLogin.status).toBe(401);
    await loginAs(member.email, NEW_PASSWORD);
  });

  it('rejects a reused token', async () => {
    const member = await newMember();
    await sendReset(member.id);
    expect((await complete(lastToken)).status).toBe(200);

    const reuse = await complete(lastToken, 'Another123!');
    expect(reuse.status).toBe(400);
    expect(reuse.body.code).toBe('PASSWORD_RESET_INVALID');
  });

  it('rejects an expired token with 410 and reports EXPIRED', async () => {
    const member = await newMember();
    await sendReset(member.id);
    await prisma.passwordResetRequest.updateMany({ where: { userId: member.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await complete(lastToken);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('PASSWORD_RESET_EXPIRED');
    const row = await prisma.passwordResetRequest.findFirstOrThrow({ where: { userId: member.id } });
    expect(row.status).toBe('EXPIRED');
  });

  it('resending cancels the previous link so only the newest works', async () => {
    const member = await newMember();
    await sendReset(member.id);
    const first = lastToken;
    await sendReset(member.id);
    expect(lastToken).not.toBe(first);

    expect((await complete(first)).status).toBe(400);
    expect((await complete(lastToken)).status).toBe(200);
    expect(await prisma.passwordResetRequest.count({ where: { userId: member.id, status: 'PENDING' } })).toBe(0);
  });

  it('validates password strength and confirmation on the server', async () => {
    const member = await newMember();
    await sendReset(member.id);

    const weak = await complete(lastToken, 'password1');
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('VALIDATION_ERROR');

    const mismatch = await complete(lastToken, NEW_PASSWORD, 'Different123!');
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'confirmPassword', message: 'Passwords do not match' })]));

    // Neither attempt spent the link.
    expect((await complete(lastToken)).status).toBe(200);
  });

  it('forbids everyone but the Super Admin, even with users.update', async () => {
    const member = await newMember();
    for (const who of ['admin', 'employee'] as const) {
      const res = await (await loginAs(who)).auth(api().post(`/api/admin/users/${member.id}/password-reset`));
      expect(res.status).toBe(403);
    }
    expect((await api().post(`/api/admin/users/${member.id}/password-reset`)).status).toBe(401);
  });

  it('cancels the link and reports failure when the email cannot be sent', async () => {
    const member = await newMember();
    vi.spyOn(mailer, 'sendMail').mockRejectedValueOnce(new Error('SMTP down'));
    const res = await sendReset(member.id);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('EMAIL_DELIVERY_FAILED');
    const row = await prisma.passwordResetRequest.findFirstOrThrow({ where: { userId: member.id } });
    expect(row.status).toBe('CANCELLED');
  });

  it('returns 404 for an unknown user', async () => {
    const res = await sendReset('00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });
});
