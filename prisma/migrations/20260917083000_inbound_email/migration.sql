-- CreateEnum
CREATE TYPE "EmailDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- AlterTable
ALTER TABLE "email_logs" ADD COLUMN     "direction" "EmailDirection" NOT NULL DEFAULT 'OUTBOUND',
ADD COLUMN     "from_name" VARCHAR(120),
ADD COLUMN     "in_reply_to" VARCHAR(512),
ADD COLUMN     "message_id" VARCHAR(512);

-- CreateTable
CREATE TABLE "mailbox_sync_state" (
    "id" VARCHAR(320) NOT NULL,
    "uid_validity" BIGINT NOT NULL,
    "last_uid" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mailbox_sync_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_logs_message_id_key" ON "email_logs"("message_id");
