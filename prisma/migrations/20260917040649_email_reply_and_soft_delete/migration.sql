-- NOTE: `prisma migrate dev` also emitted DROP INDEX for the five pg_trgm
-- search indexes from 20260915090000. They are raw SQL, absent from the
-- Prisma schema, so every diff wants to drop them. Removed on purpose.

-- This one *is* intentional: it is replaced below by a variant that also
-- carries `deleted_by_from_at`, which every Sent query now filters on.
-- DropIndex
DROP INDEX "email_logs_from_user_id_created_at_idx";

-- AlterTable
ALTER TABLE "email_logs" ADD COLUMN     "deleted_by_from_at" TIMESTAMPTZ(3),
ADD COLUMN     "deleted_by_to_at" TIMESTAMPTZ(3),
ADD COLUMN     "reply_to_id" UUID;

-- CreateIndex
CREATE INDEX "email_logs_to_user_id_deleted_by_to_at_created_at_idx" ON "email_logs"("to_user_id", "deleted_by_to_at", "created_at" DESC);

-- CreateIndex
CREATE INDEX "email_logs_from_user_id_deleted_by_from_at_created_at_idx" ON "email_logs"("from_user_id", "deleted_by_from_at", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "email_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
