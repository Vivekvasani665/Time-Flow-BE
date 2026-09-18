import type { AuthContext } from '../modules/auth/auth.types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by `authenticate` middleware. */
      auth?: AuthContext;
    }
  }
}

export {};
