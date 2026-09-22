import type { UserStatus } from '@prisma/client';

/** Cached, per-user identity snapshot used by the auth middleware. */
export type CachedUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: UserStatus;
  roleId: string;
  roleName: string;
  tokenVersion: number;
};

/** Everything downstream code needs to know about the caller. */
export type AuthContext = CachedUser & {
  permissions: ReadonlySet<string>;
};

export type AccessTokenPayload = {
  sub: string;
  /** token version — mismatch with DB invalidates the token */
  tv: number;
};

export type VerifiedAccessToken = AccessTokenPayload & {
  /** expiry, seconds since epoch */
  exp: number;
};

/** Proves the password step of a 2FA sign-in; exchanged for a session with a TOTP code. */
export type TwoFactorChallengePayload = {
  sub: string;
  tv: number;
};
