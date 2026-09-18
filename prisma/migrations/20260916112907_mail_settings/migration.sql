-- NOTE: `prisma migrate dev` also emitted DROP INDEX for the five pg_trgm
-- search indexes from 20260915090000. They are raw SQL, absent from the
-- Prisma schema, so every diff wants to drop them. Removed on purpose.

-- CreateTable
CREATE TABLE "mail_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "host" VARCHAR(255) NOT NULL,
    "port" INTEGER NOT NULL,
    "secure" BOOLEAN NOT NULL DEFAULT false,
    "username" VARCHAR(254) NOT NULL,
    "password_enc" TEXT NOT NULL,
    "from_address" VARCHAR(254) NOT NULL,
    "from_name" VARCHAR(80) NOT NULL DEFAULT 'TimeFlow',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_verified_at" TIMESTAMPTZ(3),
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mail_settings_pkey" PRIMARY KEY ("id")
);
