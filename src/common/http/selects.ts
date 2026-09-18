import type { Prisma } from '@prisma/client';

/** Public projection of a user embedded in other resources. Never includes secrets. */
export const userRefSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  avatarUrl: true,
} satisfies Prisma.UserSelect;

export type UserRef = Prisma.UserGetPayload<{ select: typeof userRefSelect }>;
