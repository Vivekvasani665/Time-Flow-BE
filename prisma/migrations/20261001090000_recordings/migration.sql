-- CreateEnum
CREATE TYPE "RecordingType" AS ENUM ('FULL_SCREEN', 'WINDOW', 'BROWSER_TAB', 'SCREEN_WEBCAM', 'WEBCAM');

-- CreateEnum
CREATE TYPE "RecordingStatus" AS ENUM ('UPLOADING', 'READY');

-- CreateTable
CREATE TABLE "recordings" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "project_id" UUID,
    "title" VARCHAR(160) NOT NULL,
    "description" VARCHAR(2000),
    "tags" VARCHAR(40)[] DEFAULT ARRAY[]::VARCHAR(40)[],
    "storage_key" VARCHAR(255) NOT NULL,
    "thumbnail_key" VARCHAR(255),
    "mime_type" VARCHAR(127) NOT NULL,
    "file_size" BIGINT NOT NULL DEFAULT 0,
    "duration" INTEGER,
    "recording_type" "RecordingType" NOT NULL,
    "status" "RecordingStatus" NOT NULL DEFAULT 'UPLOADING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recordings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recordings_storage_key_key" ON "recordings"("storage_key");

-- CreateIndex
CREATE INDEX "recordings_user_id_status_created_at_idx" ON "recordings"("user_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "recordings_project_id_status_idx" ON "recordings"("project_id", "status");

-- CreateIndex
CREATE INDEX "recordings_status_created_at_idx" ON "recordings"("status", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Recording oversight permission. The seed keeps permissions in sync with the catalog, but
-- deployments only run migrations, so create it here and grant it to the admin roles.
INSERT INTO "permissions" ("id", "key", "module", "action", "description")
VALUES (gen_random_uuid(), 'recordings.manage_all', 'recordings', 'manage_all', 'View and delete every recording (lifts data scoping)')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."name" IN ('Super Admin', 'Admin') AND p."key" = 'recordings.manage_all'
ON CONFLICT DO NOTHING;
