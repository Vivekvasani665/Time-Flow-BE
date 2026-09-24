-- Self-registration now creates a PENDING user that becomes ACTIVE only once
-- the OTP sent to its email and mobile number is verified.
ALTER TYPE "UserStatus" ADD VALUE 'PENDING';

-- CreateTable
CREATE TABLE "signup_otps" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "otp_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "send_count" INTEGER NOT NULL DEFAULT 1,
    "last_sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channels" VARCHAR(10)[] DEFAULT ARRAY[]::VARCHAR(10)[],
    "verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signup_otps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signup_otps_user_id_idx" ON "signup_otps"("user_id");

-- CreateIndex
CREATE INDEX "signup_otps_expires_at_idx" ON "signup_otps"("expires_at");

-- AddForeignKey
ALTER TABLE "signup_otps" ADD CONSTRAINT "signup_otps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A mobile number belongs to one non-deleted user. Compared on digits only, so
-- "+91 98765 43210" and "+919876543210" are the same number. Prisma's schema
-- language cannot express this, so it is maintained by hand.
--
-- Numbers were not unique before. Where two live users share one, the oldest
-- account keeps it and the newer ones have it cleared so the index can build.
UPDATE "users" u SET "phone" = NULL
WHERE u."deleted_at" IS NULL AND u."phone" ~ '[0-9]'
  AND EXISTS (
    SELECT 1 FROM "users" o
    WHERE o."deleted_at" IS NULL AND o."phone" ~ '[0-9]'
      AND regexp_replace(o."phone", '[^0-9]', '', 'g') = regexp_replace(u."phone", '[^0-9]', '', 'g')
      AND (o."created_at", o."id") < (u."created_at", u."id")
  );

CREATE UNIQUE INDEX "users_phone_active_key" ON "users" (regexp_replace("phone", '[^0-9]', '', 'g'))
  WHERE "deleted_at" IS NULL AND "phone" ~ '[0-9]';
