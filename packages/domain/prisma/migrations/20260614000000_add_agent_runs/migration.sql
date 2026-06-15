-- CreateTable: agent_runs (P1 D-journal — durable managed-agent run journal,
-- replacing the 256-entry in-memory ring; the P4 adjutant projects from it).
CREATE TABLE "ibx_domain"."agent_runs" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "agent_version" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "decision_kind" TEXT NOT NULL,
    "intent_kind" TEXT NOT NULL,
    "model_calls" INTEGER NOT NULL DEFAULT 0,
    "at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: idempotent upsert key (one row per agent + trigger event).
CREATE UNIQUE INDEX "agent_runs_agent_id_external_id_key" ON "ibx_domain"."agent_runs"("agent_id", "external_id");

-- CreateIndex: run history per agent, newest-first.
CREATE INDEX "agent_runs_agent_id_at_idx" ON "ibx_domain"."agent_runs"("agent_id", "at");

-- CreateIndex: lookups by agent session namespace.
CREATE INDEX "agent_runs_session_id_idx" ON "ibx_domain"."agent_runs"("session_id");
