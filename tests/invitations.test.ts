import { describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { api, loginAs, nextIp, roleId, unique } from './helpers';

const PASSWORD = 'Welcome123!';
const GONE = 'Invitation Link Expired or Already Used';

const tokenOf = (inviteUrl: string) => decodeURIComponent(/accept-invitation\?token=([\w%-]+)/.exec(inviteUrl)![1]);

async function invite(email: string, role = 'Employee') {
  const admin = await loginAs('superadmin');
  return admin.auth(api().post('/api/admin/invitations')).send({ email, roleId: await roleId(role) });
}

const accept = (token: string, extra: Record<string, unknown> = {}) =>
  api().post('/api/auth/invitations/accept').set('X-Forwarded-For', nextIp()).send({ token, password: PASSWORD, confirmPassword: PASSWORD, ...extra });

describe('User invitations', () => {
  it('runs the full flow: invite → copy link → verify → set password → login → link expires', async () => {
    const email = `${unique('invitee')}@example.com`;

    const created = await invite(email.toUpperCase());
    expect(created.status).toBe(201);
    expect(created.body.data.invitation).toMatchObject({ email, status: 'PENDING', role: { name: 'Employee' } });
    expect(created.body.data.invitation).not.toHaveProperty('tokenHash');
    const token = tokenOf(created.body.data.inviteUrl);
    expect(token).toMatch(/^[\w-]{43}$/);
    // No account exists until the invitee sets a password.
    expect(await prisma.user.count({ where: { email } })).toBe(0);

    const verify = await api().get('/api/auth/invitations/verify').query({ token });
    expect(verify.status).toBe(200);
    expect(verify.body.data).toMatchObject({ valid: true, email, role: { name: 'Employee' } });

    const done = await accept(token, { firstName: 'Ina', lastName: 'Vite' });
    expect(done.status).toBe(200);
    expect(done.body.message).toBe('Password set successfully. You can now log in.');

    const session = await loginAs(email, PASSWORD);
    const me = await session.auth(api().get('/api/auth/me'));
    expect(me.body.data.user ?? me.body.data).toMatchObject({ email, firstName: 'Ina', lastName: 'Vite' });

    const row = await prisma.userInvitation.findFirstOrThrow({ where: { email } });
    expect(row.status).toBe('ACCEPTED');
    expect(row.acceptedUserId).toBe(session.userId);

    // Step 9: the link is spent.
    const again = await accept(token);
    expect(again.status).toBe(410);
    expect(again.body).toMatchObject({ code: 'INVITATION_LINK_INVALID', message: GONE });
    expect((await api().get('/api/auth/invitations/verify').query({ token })).status).toBe(410);
  });

  it('derives a name from the email when none is given', async () => {
    const email = `jane.doe.${unique('x')}@example.com`;
    const token = tokenOf((await invite(email)).body.data.inviteUrl);
    expect((await accept(token)).status).toBe(200);
    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    expect(user.firstName).toBe('Jane');
  });

  it('rejects an expired link with the same message and marks it EXPIRED', async () => {
    const email = `${unique('late')}@example.com`;
    const token = tokenOf((await invite(email)).body.data.inviteUrl);
    await prisma.userInvitation.updateMany({ where: { email }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await accept(token);
    expect(res.status).toBe(410);
    expect(res.body.message).toBe(GONE);
    expect((await prisma.userInvitation.findFirstOrThrow({ where: { email } })).status).toBe('EXPIRED');
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it('rejects an unknown token', async () => {
    const res = await accept('not-a-real-token');
    expect(res.status).toBe(410);
    expect(res.body.message).toBe(GONE);
  });

  it('re-inviting revokes the previous link; revoking kills a link', async () => {
    const email = `${unique('twice')}@example.com`;
    const first = tokenOf((await invite(email)).body.data.inviteUrl);
    const secondRes = await invite(email);
    const second = tokenOf(secondRes.body.data.inviteUrl);

    expect((await accept(first)).status).toBe(410);

    const admin = await loginAs('superadmin');
    const revoked = await admin.auth(api().delete(`/api/admin/invitations/${secondRes.body.data.invitation.id}`));
    expect(revoked.status).toBe(200);
    expect(revoked.body.data.status).toBe('REVOKED');
    expect((await accept(second)).status).toBe(410);
  });

  it('refuses to invite an email that already has an account', async () => {
    const res = await invite('employee@timeflow.dev');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('USER_EMAIL_EXISTS');
  });

  it('validates password strength and confirmation without spending the link', async () => {
    const email = `${unique('weak')}@example.com`;
    const token = tokenOf((await invite(email)).body.data.inviteUrl);

    expect((await accept(token, { password: 'password1', confirmPassword: 'password1' })).status).toBe(400);
    const mismatch = await accept(token, { confirmPassword: 'Different123!' });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'confirmPassword' })]));

    expect((await accept(token)).status).toBe(200);
  });

  it('lists invitations with their effective status', async () => {
    const email = `${unique('listed')}@example.com`;
    await invite(email);
    const admin = await loginAs('superadmin');
    const res = await admin.auth(api().get('/api/admin/invitations')).query({ search: email, status: 'PENDING' });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.total).toBe(1);
  });

  it('forbids everyone but the Super Admin', async () => {
    for (const who of ['admin', 'employee'] as const) {
      const session = await loginAs(who);
      const res = await session.auth(api().post('/api/admin/invitations')).send({ email: 'x@example.com', roleId: await roleId('Employee') });
      expect(res.status).toBe(403);
    }
    expect((await api().get('/api/admin/invitations')).status).toBe(401);
  });
});
