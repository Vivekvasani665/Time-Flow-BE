-- Mailbox: store the rendered message and tie each row to its people.
--
-- NOTE: the pg_trgm search indexes created in 20260915090000 live outside the
-- Prisma schema, so `prisma migrate dev` wants to drop them on every diff.
-- Those DROP INDEX statements were removed here deliberately — keep removing
-- them when regenerating this migration.

-- AlterTable
ALTER TABLE "email_logs" ADD COLUMN     "body_html" TEXT,
ADD COLUMN     "body_text" TEXT,
ADD COLUMN     "from_user_id" UUID,
ADD COLUMN     "read_at" TIMESTAMPTZ(3),
ADD COLUMN     "to_user_id" UUID;

-- Backfill existing outbox rows with the historical sender, then drop the
-- default so the application always supplies it explicitly.
ALTER TABLE "email_logs" ADD COLUMN "from_address" VARCHAR(254) NOT NULL DEFAULT 'TimeFlow <no-reply@timeflow.dev>';
ALTER TABLE "email_logs" ALTER COLUMN "from_address" DROP DEFAULT;

-- Link historical rows to the user they were addressed to, where that email
-- still resolves to a live account.
UPDATE "email_logs" e
SET "to_user_id" = u."id"
FROM "users" u
WHERE u."email" = e."to" AND u."deleted_at" IS NULL AND e."to_user_id" IS NULL;

-- CreateIndex
CREATE INDEX "email_logs_to_user_id_read_at_created_at_idx" ON "email_logs"("to_user_id", "read_at", "created_at" DESC);

-- CreateIndex
CREATE INDEX "email_logs_from_user_id_created_at_idx" ON "email_logs"("from_user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
