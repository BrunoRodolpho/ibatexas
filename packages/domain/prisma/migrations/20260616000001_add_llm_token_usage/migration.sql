-- CreateTable: llm_token_usage (ERDS-059 — durable per-llm.call token usage +
-- estimated USD cost, written alongside the existing telemetry. Best-effort /
-- fail-open; the cost dashboards aggregate by session and by customer).
CREATE TABLE "ibx_domain"."llm_token_usage" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "channel" TEXT,
    "model" TEXT NOT NULL,
    "prompt_tokens" INTEGER NOT NULL,
    "completion_tokens" INTEGER NOT NULL,
    "total_tokens" INTEGER NOT NULL,
    "estimated_usd" DECIMAL(12,6) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_token_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: per-session cost lookups.
CREATE INDEX "llm_token_usage_session_id_idx" ON "ibx_domain"."llm_token_usage"("session_id");

-- CreateIndex: per-customer cost over time.
CREATE INDEX "llm_token_usage_customer_id_created_at_idx" ON "ibx_domain"."llm_token_usage"("customer_id", "created_at");
