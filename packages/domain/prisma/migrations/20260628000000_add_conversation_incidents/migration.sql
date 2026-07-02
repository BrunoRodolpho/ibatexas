-- CreateEnum
CREATE TYPE "ibx_domain"."IncidentKind" AS ENUM (
  'no_reply'
);

-- CreateEnum
CREATE TYPE "ibx_domain"."IncidentCause" AS ENUM (
  'empty_completion',
  'whitespace_only',
  'send_failed',
  'retry_exhausted',
  'timeout'
);

-- CreateEnum
CREATE TYPE "ibx_domain"."IncidentSeverity" AS ENUM (
  'low',
  'medium',
  'high'
);

-- CreateEnum
CREATE TYPE "ibx_domain"."IncidentStatus" AS ENUM (
  'OPEN',
  'ACKNOWLEDGED',
  'AUTO_RESOLVED',
  'RESOLVED'
);

-- CreateEnum
CREATE TYPE "ibx_domain"."IncidentResolutionType" AS ENUM (
  'AUTO',
  'STAFF',
  'HANDED_OFF'
);

-- CreateTable: conversation_incidents (no-reply incident journal — durable,
-- kernel- and NATS-independent; correlated by soft session_id string, no FK).
CREATE TABLE "ibx_domain"."conversation_incidents" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "customer_id" TEXT,
    "channel" TEXT NOT NULL,
    "sender_ref" TEXT,
    "kind" "ibx_domain"."IncidentKind" NOT NULL DEFAULT 'no_reply',
    "cause" "ibx_domain"."IncidentCause" NOT NULL,
    "last_cause" "ibx_domain"."IncidentCause",
    "severity" "ibx_domain"."IncidentSeverity" NOT NULL DEFAULT 'medium',
    "status" "ibx_domain"."IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "drop_count" INTEGER NOT NULL DEFAULT 1,
    "customer_impacted" BOOLEAN NOT NULL DEFAULT true,
    "opened_at" TIMESTAMP(3) NOT NULL,
    "last_drop_at" TIMESTAMP(3) NOT NULL,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,
    "resolution_type" "ibx_domain"."IncidentResolutionType",
    "prior_incident_id" TEXT,
    "last_turn_id" TEXT,
    "last_decision_kind" TEXT,
    "closing_turn_id" TEXT,
    "external_id" TEXT NOT NULL,
    "phone_hash" TEXT,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: per-event create idempotency backstop (<sourceSubject>:<eventId>).
CREATE UNIQUE INDEX "conversation_incidents_external_id_key" ON "ibx_domain"."conversation_incidents"("external_id");

-- CreateIndex: status board, newest-open-first.
CREATE INDEX "conversation_incidents_status_opened_at_idx" ON "ibx_domain"."conversation_incidents"("status", "opened_at");

-- CreateIndex: soft session correlation lookups.
CREATE INDEX "conversation_incidents_session_id_idx" ON "ibx_domain"."conversation_incidents"("session_id");

-- CreateIndex: per-customer history.
CREATE INDEX "conversation_incidents_customer_id_idx" ON "ibx_domain"."conversation_incidents"("customer_id");

-- CreateIndex: partial unique index — single open (non-terminal) incident per session.
-- Not expressible in schema.prisma (the DSL cannot carry the WHERE); hand-written
-- and applied via `ibx db provision` / `migrate deploy`. A future `prisma migrate dev`
-- reads this as drift and tries to DROP it — keep it hand-written.
CREATE UNIQUE INDEX "conversation_incidents_session_open_uq"
  ON "ibx_domain"."conversation_incidents"("session_id")
  WHERE "status" IN ('OPEN', 'ACKNOWLEDGED');
