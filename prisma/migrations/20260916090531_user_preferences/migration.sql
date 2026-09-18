-- NOTE: `prisma migrate dev` also emitted DROP INDEX for the five pg_trgm search
-- indexes created in 20260915090000. They are raw SQL and absent from the Prisma
-- schema, so every diff wants to drop them. Those lines were removed on purpose
-- — keep removing them when regenerating this migration.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "preferences" JSONB NOT NULL DEFAULT '{}';
