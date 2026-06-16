-- CreateTable: agent_red_team_runs (ERDS-058 — durable store of managed-agent
-- red-team / adversarial test runs; mirrors agent_runs scoped to the per-release
-- red-team suite. Per-release CI population is deferred — this lands the store).
CREATE TABLE "ibx_domain"."agent_red_team_runs" (
    "run_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "agent_version" TEXT,
    "test_suite" TEXT NOT NULL,
    "test_case" TEXT NOT NULL,
    "decision_kind" TEXT NOT NULL,
    "intent_kind" TEXT,
    "model_calls" INTEGER NOT NULL DEFAULT 0,
    "assertions_passed" INTEGER,
    "at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_red_team_runs_pkey" PRIMARY KEY ("run_id")
);

-- CreateIndex: red-team coverage per agent + suite.
CREATE INDEX "agent_red_team_runs_agent_id_test_suite_idx" ON "ibx_domain"."agent_red_team_runs"("agent_id", "test_suite");

-- CreateIndex: run history, newest-first.
CREATE INDEX "agent_red_team_runs_created_at_idx" ON "ibx_domain"."agent_red_team_runs"("created_at");
