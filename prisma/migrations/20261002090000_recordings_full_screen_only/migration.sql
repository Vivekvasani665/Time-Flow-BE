-- Window and single-tab recording were removed: TimeFlow now records only a whole
-- display (optionally with a webcam bubble), or the webcam alone. Recordings made in
-- the removed modes are kept, and shown as full-screen recordings.
UPDATE "recordings" SET "recording_type" = 'FULL_SCREEN' WHERE "recording_type" IN ('WINDOW', 'BROWSER_TAB');

-- PostgreSQL can't drop enum values, so the type is rebuilt.
ALTER TYPE "RecordingType" RENAME TO "RecordingType_old";
CREATE TYPE "RecordingType" AS ENUM ('FULL_SCREEN', 'SCREEN_WEBCAM', 'WEBCAM');
ALTER TABLE "recordings" ALTER COLUMN "recording_type" TYPE "RecordingType" USING ("recording_type"::text::"RecordingType");
DROP TYPE "RecordingType_old";
