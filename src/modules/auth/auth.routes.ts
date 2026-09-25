import { Router } from 'express';
import { env } from '../../config/env';
import { authenticate } from '../../common/middleware/authenticate';
import { rateLimit } from '../../common/middleware/rate-limit';
import { authController } from './auth.controller';

const loginLimiter = rateLimit({
  name: 'login',
  limit: env.RATE_LIMIT_LOGIN_MAX,
  windowSeconds: env.RATE_LIMIT_LOGIN_WINDOW_SECONDS,
  message: 'Too many login attempts. Please wait a minute and try again.',
});

const registerLimiter = rateLimit({
  name: 'register',
  limit: env.RATE_LIMIT_LOGIN_MAX,
  windowSeconds: env.RATE_LIMIT_LOGIN_WINDOW_SECONDS,
  message: 'Too many sign-up attempts. Please wait a minute and try again.',
});

const twoFactorLoginLimiter = rateLimit({
  name: 'login-2fa',
  limit: env.RATE_LIMIT_LOGIN_MAX,
  windowSeconds: env.RATE_LIMIT_LOGIN_WINDOW_SECONDS,
  message: 'Too many code attempts. Please wait a minute and try again.',
});

// Per-IP guards on the emailed-code step. Guessing is capped per code as well
// (5 wrong attempts), and resends by a per-attempt cooldown.
const loginOtpVerifyLimiter = rateLimit({
  name: 'login-otp-verify',
  limit: 10,
  windowSeconds: 60,
  message: 'Too many code attempts. Please wait a minute and try again.',
});

const loginOtpResendLimiter = rateLimit({
  name: 'login-otp-resend',
  limit: 5,
  windowSeconds: 5 * 60,
  message: 'Too many code requests. Please wait a few minutes and try again.',
});

// Same shape of guard for the signup code: guessing is also capped per code
// (5 wrong attempts), and resends by a per-signup cooldown.
const signupOtpVerifyLimiter = rateLimit({
  name: 'signup-otp-verify',
  limit: 10,
  windowSeconds: 60,
  message: 'Too many code attempts. Please wait a minute and try again.',
});

const signupOtpResendLimiter = rateLimit({
  name: 'signup-otp-resend',
  limit: 5,
  windowSeconds: 5 * 60,
  message: 'Too many code requests. Please wait a few minutes and try again.',
});

const refreshLimiter = rateLimit({ name: 'refresh', limit: 30, windowSeconds: 60 });

export const authRouter = Router();

authRouter.post('/login', loginLimiter, authController.login);
authRouter.post('/login/2fa', twoFactorLoginLimiter, authController.loginTwoFactor);
authRouter.post('/verify-login-otp', loginOtpVerifyLimiter, authController.verifyLoginOtp);
authRouter.post('/login/otp/verify', loginOtpVerifyLimiter, authController.verifyLoginOtp);
authRouter.post('/resend-login-otp', loginOtpResendLimiter, authController.resendLoginOtp);
authRouter.post('/login/otp/resend', loginOtpResendLimiter, authController.resendLoginOtp);
authRouter.post('/register', registerLimiter, authController.register);
authRouter.post('/register/verify-otp', signupOtpVerifyLimiter, authController.verifySignupOtp);
authRouter.post('/register/resend-otp', signupOtpResendLimiter, authController.resendSignupOtp);
authRouter.post('/refresh', refreshLimiter, authController.refresh);
authRouter.post('/logout', authController.logout);
authRouter.get('/me', authenticate, authController.me);
// Your own UI settings — no permission, every signed-in user has them.
authRouter.patch('/me/preferences', authenticate, authController.updatePreferences);
// Sessions: your own signed-in devices. No permission — these are yours.
authRouter.get('/me/sessions', authenticate, authController.listSessions);
authRouter.post('/me/sessions/revoke-others', authenticate, authController.revokeOtherSessions);
authRouter.delete('/me/sessions/:id', authenticate, authController.revokeSession);
// Two-factor authentication (TOTP) for your own account.
authRouter.get('/me/2fa', authenticate, authController.twoFactorStatus);
authRouter.post('/me/2fa/setup', authenticate, authController.twoFactorSetup);
authRouter.post('/me/2fa/enable', authenticate, authController.twoFactorEnable);
authRouter.post('/me/2fa/disable', authenticate, authController.twoFactorDisable);
authRouter.post('/me/2fa/recovery-codes', authenticate, authController.twoFactorRegenerateCodes);
