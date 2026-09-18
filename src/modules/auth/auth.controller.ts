import type { Request, Response } from 'express';
import { ok } from '../../common/http/response';
import { requireAuth } from '../../common/utils/request-context';
import { uuidParam } from '../../common/utils/validation';
import { tokenService } from './token.service';
import { loginSchema, updatePreferencesSchema } from './auth.schemas';
import { authService } from './auth.service';

const clientInfo = (req: Request) => ({ ip: req.ip ?? null, userAgent: req.get('user-agent')?.slice(0, 255) ?? null });

export const authController = {
  async login(req: Request, res: Response) {
    const input = loginSchema.parse(req.body);
    const session = await authService.login(input, clientInfo(req));
    tokenService.setAuthCookies(res, session.accessToken, session.refreshToken, session.refreshExpiresAt);
    const user = await authService.getAuthUser(session.userId);
    // The access token is also returned for non-browser clients (Swagger, scripts).
    return ok(res, { user, accessToken: session.accessToken }, 'Signed in successfully');
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

  async updatePreferences(req: Request, res: Response) {
    const auth = requireAuth(req);
    const patch = updatePreferencesSchema.parse(req.body);
    return ok(res, await authService.updatePreferences(auth.id, patch), 'Preferences saved');
  },
};
