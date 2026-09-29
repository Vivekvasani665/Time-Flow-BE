-- AlterEnum
ALTER TYPE "EmailStatus" ADD VALUE 'DRAFT';

-- AlterTable
ALTER TABLE "email_logs" ADD COLUMN     "bcc" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "cc" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "provider_message_id" VARCHAR(255),
ALTER COLUMN "to" SET DATA TYPE TEXT;

-- CreateTable
CREATE TABLE "email_attachments" (
    "id" UUID NOT NULL,
    "email_id" UUID,
    "uploaded_by_id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(127) NOT NULL,
    "size" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_attachments_email_id_idx" ON "email_attachments"("email_id");

-- CreateIndex
CREATE INDEX "email_attachments_uploaded_by_id_email_id_created_at_idx" ON "email_attachments"("uploaded_by_id", "email_id", "created_at");

-- AddForeignKey
ALTER TABLE "email_attachments" ADD CONSTRAINT "email_attachments_email_id_fkey" FOREIGN KEY ("email_id") REFERENCES "email_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_attachments" ADD CONSTRAINT "email_attachments_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

