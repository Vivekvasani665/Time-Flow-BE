-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- CreateTable
CREATE TABLE "user_invitations" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "role_id" UUID NOT NULL,
    "invited_by_id" UUID,
    "token_hash" VARCHAR(64) NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_user_id" UUID,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_invitations_token_hash_key" ON "user_invitations"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "user_invitations_accepted_user_id_key" ON "user_invitations"("accepted_user_id");

-- CreateIndex
CREATE INDEX "user_invitations_email_created_at_idx" ON "user_invitations"("email", "created_at");

-- CreateIndex
CREATE INDEX "user_invitations_status_created_at_idx" ON "user_invitations"("status", "created_at");

-- At most one live invitation per email. Not expressible in the Prisma schema,
-- so it lives here; inviting again revokes the previous link first.
CREATE UNIQUE INDEX "user_invitations_one_pending_per_email" ON "user_invitations"("email") WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_accepted_user_id_fkey" FOREIGN KEY ("accepted_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
