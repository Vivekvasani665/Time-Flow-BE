import type { Request, Response } from 'express';
import { created, ok } from '../../common/http/response';
import { requireAuth } from '../../common/utils/request-context';
import { uuidParam } from '../../common/utils/validation';
import { tokenService } from './token.service';
import {
  disableTwoFactorSchema,
  loginSchema,
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
import { twoFactorService } from './two-factor.service';
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
      // No cookies yet — nothing authenticates until the emailed code is verified.
      return ok(res, result, 'OTP sent to your registered email');
    }
    if ('twoFactorRequired' in result) {
      // No cookies yet — the client posts the challenge back with a code.
      return ok(res, result, 'Enter the code from your authenticator app');
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
    const { verificationId } = resendLoginOtpSchema.parse(req.body);
    return ok(res, await loginOtpService.resend(verificationId, clientInfo(req)), 'A new code has been sent to your email');
  },

  async loginTwoFactor(req: Request, res: Response) {
    const { challengeToken, code } = twoFactorLoginSchema.parse(req.body);
    const session = await authService.verifyTwoFactorLogin(challengeToken, code, clientInfo(req));
    tokenService.setAuthCookies(res, session.accessToken, session.refreshToken, session.refreshExpiresAt);
    const user = await authService.getAuthUser(session.userId);
    const recoveryCodesRemaining = session.method === 'recovery' ? (await twoFactorService.status(session.userId)).recoveryCodesRemaining : undefined;
    return ok(res, { user, accessToken: session.accessToken, recoveryCodesRemaining }, 'Signed in successfully');
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
    return ok(res, await twoFactorService.setup(auth.id), 'Scan the QR code with your authenticator app');
  },

  async twoFactorEnable(req: Request, res: Response) {
    const auth = requireAuth(req);
    const { code } = twoFactorCodeSchema.parse(req.body);
    const result = await twoFactorService.enable(auth.id, code, { actorId: auth.id, ...clientInfo(req) });
    return ok(res, result, 'Two-factor authentication enabled. Save your recovery codes somewhere safe.');
  },

  async twoFactorDisable(req: Request, res: Response) {
    const auth = requireAuth(req);
    const { password, code } = disableTwoFactorSchema.parse(req.body);
    await twoFactorService.disable(auth.id, password, code, { actorId: auth.id, ...clientInfo(req) });
    return ok(res, null, 'Two-factor authentication disabled');
  },

  async twoFactorRegenerateCodes(req: Request, res: Response) {
    const auth = requireAuth(req);
    const { code } = twoFactorCodeSchema.parse(req.body);
    const result = await twoFactorService.regenerateRecoveryCodes(auth.id, code, { actorId: auth.id, ...clientInfo(req) });
    return ok(res, result, 'New recovery codes generated. The old ones no longer work.');
  },

  async updatePreferences(req: Request, res: Response) {
    const auth = requireAuth(req);
    const patch = updatePreferencesSchema.parse(req.body);
    return ok(res, await authService.updatePreferences(auth.id, patch), 'Preferences saved');
  },
};
