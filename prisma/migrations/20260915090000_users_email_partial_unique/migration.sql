-- Email must be unique among *non-deleted* users only, so a soft-deleted
-- user's address can be re-used. Prisma's schema language cannot express
-- partial indexes, so this one is maintained by hand.
CREATE UNIQUE INDEX "users_email_active_key" ON "users" ("email") WHERE "deleted_at" IS NULL;

-- Trigram indexes back the case-insensitive `ILIKE '%term%'` searches the
-- list endpoints run (Prisma `contains` + `mode: insensitive`). A B-tree
-- cannot serve a leading-wildcard LIKE; GIN trigram indexes can.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "users_first_name_trgm_idx" ON "users" USING gin ("first_name" gin_trgm_ops);
CREATE INDEX "users_last_name_trgm_idx" ON "users" USING gin ("last_name" gin_trgm_ops);
CREATE INDEX "users_email_trgm_idx" ON "users" USING gin ("email" gin_trgm_ops);
CREATE INDEX "projects_name_trgm_idx" ON "projects" USING gin ("name" gin_trgm_ops);
CREATE INDEX "tasks_title_trgm_idx" ON "tasks" USING gin ("title" gin_trgm_ops);
