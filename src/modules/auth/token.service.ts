import jwt from 'jsonwebtoken';
import type { CookieOptions, Request, Response } from 'express';
import { env } from '../../config/env';
import { randomToken, sha256 } from '../../common/utils/crypto';
import type { AccessTokenPayload, VerifiedAccessToken } from './auth.types';

export const ACCESS_COOKIE = 'tf_access';
export const REFRESH_COOKIE = 'tf_refresh';
/**
 * Non-secret, JS-invisible hint that a refreshable session exists. The refresh
 * cookie is scoped to /api/auth, so page navigations can't see it; this marker
 * (path /) lets the frontend middleware tell "access token lapsed, refresh me"
 * apart from "never signed in". It grants nothing on its own.
 */
export const SESSION_MARKER_COOKIE = 'tf_session';
const REFRESH_COOKIE_PATH = '/api/auth';
/**
 * The access cookie is httpOnly, so clients can't read its expiry. Every
 * authenticated response advertises it instead, letting the browser refresh
 * the session shortly *before* it lapses rather than eating a 401 first.
 */
export const SESSION_EXPIRES_HEADER = 'X-Session-Expires-At';

const JWT_ISSUER = 'timeflow-api';
const JWT_AUDIENCE = 'timeflow';

export const tokenService = {
  signAccessToken(payload: AccessTokenPayload): string {
    return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  },

  /** Returns the payload, or null for any invalid/expired token. */
  verifyAccessToken(token: string): VerifiedAccessToken | null {
    try {
      const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
      if (
        typeof decoded === 'string' ||
        typeof decoded.sub !== 'string' ||
        typeof decoded.tv !== 'number' ||
        typeof decoded.exp !== 'number'
      ) {
        return null;
      }
      return { sub: decoded.sub, tv: decoded.tv, exp: decoded.exp };
    } catch {
      return null;
    }
  },

  generateRefreshToken(): { raw: string; hash: string; expiresAt: Date } {
    const raw = randomToken(48);
    return {
      raw,
      hash: sha256(raw),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
    };
  },

  extractAccessToken(req: Request): string | null {
    const header = req.get('authorization');
    if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
    const cookie: unknown = req.cookies?.[ACCESS_COOKIE];
    return typeof cookie === 'string' && cookie ? cookie : null;
  },

  extractRefreshToken(req: Request): string | null {
    const cookie: unknown = req.cookies?.[REFRESH_COOKIE];
    return typeof cookie === 'string' && cookie ? cookie : null;
  },

  setAuthCookies(res: Response, accessToken: string, refreshToken: string, refreshExpiresAt: Date): void {
    const base: CookieOptions = { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax' };
    const accessTtlMs = env.ACCESS_TOKEN_TTL_MINUTES * 60 * 1000;
    res.cookie(ACCESS_COOKIE, accessToken, { ...base, path: '/', maxAge: accessTtlMs });
    res.setHeader(SESSION_EXPIRES_HEADER, new Date(Date.now() + accessTtlMs).toISOString());
    res.cookie(REFRESH_COOKIE, refreshToken, { ...base, path: REFRESH_COOKIE_PATH, expires: refreshExpiresAt });
    res.cookie(SESSION_MARKER_COOKIE, '1', { ...base, path: '/', expires: refreshExpiresAt });
  },

  clearAuthCookies(res: Response): void {
    const base: CookieOptions = { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax' };
    res.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
    res.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_COOKIE_PATH });
    res.clearCookie(SESSION_MARKER_COOKIE, { ...base, path: '/' });
  },
};
