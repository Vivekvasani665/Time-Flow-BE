-- CreateEnum
CREATE TYPE "CallType" AS ENUM ('VOICE', 'VIDEO');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('RINGING', 'ACCEPTED', 'CONNECTED', 'REJECTED', 'MISSED', 'ENDED', 'FAILED');

-- CreateTable
CREATE TABLE "calls" (
    "id" UUID NOT NULL,
    "caller_id" UUID NOT NULL,
    "receiver_id" UUID NOT NULL,
    "type" "CallType" NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'RINGING',
    "caller_socket_id" VARCHAR(64),
    "receiver_socket_id" VARCHAR(64),
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMPTZ(3),
    "connected_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "duration_seconds" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calls_caller_id_status_idx" ON "calls"("caller_id", "status");

-- CreateIndex
CREATE INDEX "calls_receiver_id_status_idx" ON "calls"("receiver_id", "status");

-- CreateIndex
CREATE INDEX "calls_caller_id_receiver_id_created_at_idx" ON "calls"("caller_id", "receiver_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_caller_id_fkey" FOREIGN KEY ("caller_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_receiver_id_fkey" FOREIGN KEY ("receiver_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

