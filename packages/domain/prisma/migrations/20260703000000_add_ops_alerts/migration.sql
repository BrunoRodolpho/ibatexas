-- CreateEnum
CREATE TYPE "ibx_domain"."OpsAlertCause" AS ENUM (
  'ops_stuck_order',
  'ops_pix_expiry_backlog',
  'ops_stale_defer',
  'ops_dlq_depth'
);

-- CreateEnum
CREATE TYPE "ibx_domain"."OpsAlertSeverity" AS ENUM (
  'low',
  'medium',
  'high'
);

-- CreateEnum
CREATE TYPE "ibx_domain"."OpsAlertStatus" AS ENUM (
  'OPEN',
  'ACKNOWLEDGED',
  'AUTO_RESOLVED',
  'RESOLVED'
);

-- CreateEnum
CREATE TYPE "ibx_domain"."OpsAlertResolutionType" AS ENUM (
  'AUTO',
  'STAFF'
);

-- CreateTable: ops_alerts (NEW-025 detection half — a restaurant-GLOBAL
-- operational-alert journal raised by deterministic system watchdogs. Parallel
-- to conversation_incidents; no session, no customer. Governed by the SYSTEM-only
-- ops.alert.* policy bundle; consumed by the admin ops inbox + the ops agent.)
CREATE TABLE "ibx_domain"."ops_alerts" (
    "id" TEXT NOT NULL,
    "cause" "ibx_domain"."OpsAlertCause" NOT NULL,
    "severity" "ibx_domain"."OpsAlertSeverity" NOT NULL DEFAULT 'medium',
    "status" "ibx_domain"."OpsAlertStatus" NOT NULL DEFAULT 'OPEN',
    "source" TEXT NOT NULL,
    "scope" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "context" JSONB,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "dedupe_key" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,
    "resolution_type" "ibx_domain"."OpsAlertResolutionType",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: status board, newest-active-first.
CREATE INDEX "ops_alerts_status_last_seen_at_idx" ON "ibx_domain"."ops_alerts"("status", "last_seen_at");

-- CreateIndex: per-cause filtering.
CREATE INDEX "ops_alerts_cause_idx" ON "ibx_domain"."ops_alerts"("cause");

-- CreateIndex: partial unique index — a single OPEN (non-terminal) alert per
-- condition identity. Repeat detections of the SAME condition fold into that one
-- open row (occurrences++); a resolved condition that recurs opens a fresh row,
-- so history accumulates. Not expressible in schema.prisma (the DSL cannot carry
-- the WHERE); hand-written and applied via `ibx db provision` / `migrate deploy`.
-- A future `prisma migrate dev` reads this as drift and tries to DROP it — keep it
-- hand-written (mirrors conversation_incidents_session_open_uq).
CREATE UNIQUE INDEX "ops_alerts_dedupe_open_uq"
  ON "ibx_domain"."ops_alerts"("dedupe_key")
  WHERE "status" IN ('OPEN', 'ACKNOWLEDGED');
