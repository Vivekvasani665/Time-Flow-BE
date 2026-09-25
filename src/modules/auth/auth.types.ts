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

/**
 * Proves the password step of a 2FA sign-in. `verify`: exchanged for a session
 * with a second factor. `setup`: 2FA is not on yet but an authenticator setup
 * is pending, so the session comes with finishing it.
 */
export type TwoFactorChallengePurpose = 'verify' | 'setup';

export type TwoFactorChallengePayload = {
  sub: string;
  tv: number;
  pur: TwoFactorChallengePurpose;
};

export type VerifiedTwoFactorChallenge = TwoFactorChallengePayload & {
  /** Unique per challenge, so a used one can be refused. */
  jti: string;
  /** expiry, seconds since epoch */
  exp: number;
};
