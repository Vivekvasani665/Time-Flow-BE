import type { Request, Response } from 'express';
import { created, ok } from '../../common/http/response';
import { requireAuth } from '../../common/utils/request-context';
import { uuidParam } from '../../common/utils/validation';
import { tokenService } from './token.service';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import {
  disableTwoFactorSchema,
  loginSchema,
  passkeyLoginOptionsSchema,
  passkeyLoginSchema,
  passwordConfirmSchema,
  registerPasskeySchema,
  twoFactorProofSchema,
  twoFactorSetupLoginSchema,
  resendLoginOtpSchema,
  resendSignupOtpSchema,
  registerSchema,
  twoFactorCodeSchema,
  twoFactorLoginSchema,
  updatePreferencesSchema,
  verifyLoginOtpSchema,
  verifySignupOtpSchema,
} from './auth.schemas';
import { authService } from './auth.service';
import { twoFactorService, type TwoFactorProof } from './two-factor.service';
import { defaultPasskeyName } from './passkey.service';
import { loginOtpService } from './login-otp.service';
import { OTP_CHANNELS, signupOtpService, type OtpChannel } from './signup-otp.service';

const channelLabel = (channels: OtpChannel[]) =>
  channels.length === 2 ? 'email and mobile number' : channels[0] === 'sms' ? 'mobile number' : 'email';

const clientInfo = (req: Request) => ({ ip: req.ip ?? null, userAgent: req.get('user-agent')?.slice(0, 255) ?? null });

export const authController = {
  async login(req: Request, res: Response) {
    const input = loginSchema.parse(req.body);
    const result = await authService.login(input, clientInfo(req));
    if ('requiresOtp' in result) {
      // No cookies yet — nothing authenticates until the code is verified.
      return ok(res, result, `OTP sent to your ${channelLabel(result.channels)}`);
    }
    if ('twoFactorRequired' in result) {
      // No cookies yet — the client posts the challenge back with a code or passkey.
      return ok(res, result, 'Verify your identity to finish signing in');
    }
    if ('twoFactorSetupRequired' in result) {
      // No cookies yet — the session comes with finishing the pending setup.
      return ok(res, result, 'Scan the QR code with your authenticator app to finish setting up two-factor authentication');
    }
    tokenService.setAuthCookies(res, result.accessToken, result.refreshToken, result.refreshExpiresAt);
    const user = await authService.getAuthUser(result.userId);
    // The access token is also returned for non-browser clients (Swagger, scripts).
    return ok(res, { twoFactorRequired: false, requiresOtp: false, user, accessToken: result.accessToken }, 'Signed in successfully');
  },

  async verifyLoginOtp(req: Request, res: Response) {
    const { verificationId, otp } = verifyLoginOtpSchema.parse(req.body);
    const session = await authService.verifyLoginOtp(verificationId, otp, clientInfo(req));
    tokenService.setAuthCookies(res, session.accessToken, session.refreshToken, session.refreshExpiresAt);
    const user = await authService.getAuthUser(session.userId);
    // Same shape as a password-only sign-in, so the client handles both alike.
    return ok(res, { user, accessToken: session.accessToken }, 'Signed in successfully');
  },

  async resendLoginOtp(req: Request, res: Response) {
    const { verificationId, channel } = resendLoginOtpSchema.parse(req.body);
    const result = await loginOtpService.resend(verificationId, clientInfo(req), channel === 'both' ? undefined : [channel]);
    return ok(res, result, `A new code has been sent to your ${channelLabel(result.channels)}`);
  },

  async loginTwoFactor(req: Request, res: Response) {
    const { challengeToken, code } = twoFactorLoginSchema.parse(req.body);
    const session = await authService.verifyTwoFactorLogin(challengeToken, code, clientInfo(req));
    tokenService.setAuthCookies(res, session.accessToken, session.refreshToken, session.refreshExpiresAt);
    const user = await authService.getAuthUser(session.userId);
    const recoveryCodesRemaining = session.method === 'recovery' ? (await twoFactorService.status(session.userId)).recoveryCodesRemaining : undefined;
    return ok(res, { user, accessToken: session.accessToken, recoveryCodesRemaining }, 'Signed in successfully');
  },

  async passkeyLoginOptions(req: Request, res: Response) {
    const { challengeToken } = passkeyLoginOptionsSchema.parse(req.body);
    return ok(res, await authService.passkeyLoginOptions(challengeToken));
  },

  async loginPasskey(req: Request, res: Response) {
    const { challengeToken, response } = passkeyLoginSchema.parse(req.body);
    const session = await authService.verifyPasskeyLogin(challengeToken, response as unknown as AuthenticationResponseJSON, clientInfo(req));
    tokenService.setAuthCookies(res, session.accessToken, session.refreshToken, session.refreshExpiresAt);
    const user = await authService.getAuthUser(session.userId);
    return ok(res, { user, accessToken: session.accessToken }, 'Signed in successfully');
  },

  async loginTwoFactorSetup(req: Request, res: Response) {
    const { challengeToken, code } = twoFactorSetupLoginSchema.parse(req.body);
    const session = await authService.completeTwoFactorSetupLogin(challengeToken, code, clientInfo(req));
    tokenService.setAuthCookies(res, session.accessToken, session.refreshToken, session.refreshExpiresAt);
    const user = await authService.getAuthUser(session.userId);
    return ok(
      res,
      { user, accessToken: session.accessToken, recoveryCodes: session.recoveryCodes },
      'Two-factor authentication enabled. Save your recovery codes somewhere safe.',
    );
  },

  async register(req: Request, res: Response) {
    const input = registerSchema.parse(req.body);
    // No cookies — the account stays PENDING until the code is verified.
    const challenge = await authService.register(input, clientInfo(req));
    return created(res, challenge, `Verification code sent to your ${channelLabel(challenge.channels)}`);
  },

  async verifySignupOtp(req: Request, res: Response) {
    const { verificationId, otp } = verifySignupOtpSchema.parse(req.body);
    const user = await authService.verifySignup(verificationId, otp, clientInfo(req));
    return ok(res, { verified: true, user }, 'Account verified. You can now sign in.');
  },

  async resendSignupOtp(req: Request, res: Response) {
    const { verificationId, channel } = resendSignupOtpSchema.parse(req.body);
    const channels = channel === 'both' ? OTP_CHANNELS : [channel];
    const result = await signupOtpService.resend(verificationId, channels, clientInfo(req));
    return ok(res, result, `A new code has been sent to your ${channelLabel(result.channels)}`);
  },

  async refresh(req: Request, res: Response) {
    const raw = tokenService.extractRefreshToken(req);
    if (!raw) {
      tokenService.clearAuthCookies(res);
      return res.status(401).json({ success: false, message: 'Refresh token missing', code: 'UNAUTHENTICATED' });
    }
    try {
      const session = await authService.refresh(raw, clientInfo(req));
      tokenService.setAuthCookies(res, session.accessToken, session.refreshToken, session.refreshExpiresAt);
      const user = await authService.getAuthUser(session.userId);
      return ok(res, { user, accessToken: session.accessToken }, 'Session refreshed');
    } catch (err) {
      tokenService.clearAuthCookies(res);
      throw err;
    }
  },

  async logout(req: Request, res: Response) {
    await authService.logout(tokenService.extractRefreshToken(req), null, clientInfo(req));
    tokenService.clearAuthCookies(res);
    return ok(res, null, 'Signed out successfully');
  },

  async me(req: Request, res: Response) {
    const auth = requireAuth(req);
    return ok(res, await authService.getAuthUser(auth.id));
  },

  async listSessions(req: Request, res: Response) {
    const auth = requireAuth(req);
    return ok(res, await authService.listSessions(auth.id, tokenService.extractRefreshToken(req)));
  },

  async revokeSession(req: Request, res: Response) {
    const auth = requireAuth(req);
    const { id } = uuidParam.parse(req.params);
    await authService.revokeSession(auth.id, id);
    return ok(res, null, 'Signed out on that device');
  },

  async revokeOtherSessions(req: Request, res: Response) {
    const auth = requireAuth(req);
    const revoked = await authService.revokeOtherSessions(auth.id, tokenService.extractRefreshToken(req));
    return ok(res, { revoked }, revoked === 1 ? 'Signed out 1 other device' : `Signed out ${revoked} other devices`);
  },

  async twoFactorStatus(req: Request, res: Response) {
    const auth = requireAuth(req);
    return ok(res, await twoFactorService.status(auth.id));
  },

  async twoFactorSetup(req: Request, res: Response) {
    const auth = requireAuth(req);
    const { password } = passwordConfirmSchema.parse(req.body);
    const result = await twoFactorService.setup(auth.id, password, { actorId: auth.id, ...clientInfo(req) });
    return ok(res, result, 'Scan the QR code with your authenticator app');
  },

  async twoFactorCancelSetup(req: Request, res: Response) {
    const auth = requireAuth(req);
    await twoFactorService.cancelSetup(auth.id);
    return ok(res, null, 'Authenticator setup cancelled');
  },

  async twoFactorEnable(req: Request, res: Response) {
    const auth = requireAuth(req);
    const { code } = twoFactorCodeSchema.parse(req.body);
    const result = await twoFactorService.enable(auth.id, code, { actorId: auth.id, ...clientInfo(req) });
    return ok(
      res,
      result,
      result.recoveryCodes ? 'Two-factor authentication enabled. Save your recovery codes somewhere safe.' : 'Authenticator app added',
    );
  },

  async twoFactorRemoveTotp(req: Request, res: Response) {
    const auth = requireAuth(req);
    const { password } = passwordConfirmSchema.parse(req.body);
    const result = await twoFactorService.removeTotp(auth.id, password, { actorId: auth.id, ...clientInfo(req) });
    return ok(res, result, result.twoFactorEnabled ? 'Authenticator app removed' : 'Authenticator app removed. Two-factor authentication is now off.');
  },

  async twoFactorStepUpOptions(req: Request, res: Response) {
    const auth = requireAuth(req);
    return ok(res, await twoFactorService.stepUpOptions(auth.id));
  },

  async twoFactorDisable(req: Request, res: Response) {
    const auth = requireAuth(req);
    const { password, ...proof } = disableTwoFactorSchema.parse(req.body);
    await twoFactorService.disable(auth.id, password, proof as TwoFactorProof, { actorId: auth.id, ...clientInfo(req) });
    return ok(res, null, 'Two-factor authentication disabled');
  },

  async twoFactorRegenerateCodes(req: Request, res: Response) {
    const auth = requireAuth(req);
    const proof = twoFactorProofSchema.parse(req.body);
    const result = await twoFactorService.regenerateRecoveryCodes(auth.id, proof as TwoFactorProof, { actorId: auth.id, ...clientInfo(req) });
    return ok(res, result, 'New recovery codes generated. The old ones no longer work.');
  },

  async passkeyRegistrationOptions(req: Request, res: Response) {
    const auth = requireAuth(req);
    const { password } = passwordConfirmSchema.parse(req.body);
    return ok(res, await twoFactorService.passkeyRegistrationOptions(auth.id, password));
  },

  async registerPasskey(req: Request, res: Response) {
    const auth = requireAuth(req);
    const { response, name } = registerPasskeySchema.parse(req.body);
    const client = clientInfo(req);
    const result = await twoFactorService.registerPasskey(
      auth.id,
      response as unknown as RegistrationResponseJSON,
      name ?? defaultPasskeyName(client.userAgent),
      { actorId: auth.id, ...client },
    );
    return created(res, result, result.recoveryCodes ? 'Passkey added. Two-factor authentication is on — save your recovery codes.' : 'Passkey added');
  },

  async removePasskey(req: Request, res: Response) {
    const auth = requireAuth(req);
    const { id } = uuidParam.parse(req.params);
    const { password } = passwordConfirmSchema.parse(req.body);
    const result = await twoFactorService.removePasskey(auth.id, id, password, { actorId: auth.id, ...clientInfo(req) });
    return ok(res, result, result.twoFactorEnabled ? 'Passkey removed' : 'Passkey removed. Two-factor authentication is now off.');
  },

  async updatePreferences(req: Request, res: Response) {
    const auth = requireAuth(req);
    const patch = updatePreferencesSchema.parse(req.body);
    return ok(res, await authService.updatePreferences(auth.id, patch), 'Preferences saved');
  },
};
