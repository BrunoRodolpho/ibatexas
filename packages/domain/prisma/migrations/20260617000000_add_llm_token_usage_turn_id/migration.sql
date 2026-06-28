-- #94-1: add the idempotency key `turn_id` (unique) to llm_token_usage so the
-- per-turn sink can UPSERT on it — a BullMQ/turn retry overwrites rather than
-- duplicates. Added robustly (nullable → backfill → NOT NULL) so it is safe
-- against any pre-existing rows; the upstream table is brand new, so the
-- backfill is typically a no-op. Must be applied BEFORE the upsert sink ships.

-- AlterTable: add nullable, backfill existing rows (id is unique), enforce NOT NULL.
ALTER TABLE "ibx_domain"."llm_token_usage" ADD COLUMN "turn_id" TEXT;
UPDATE "ibx_domain"."llm_token_usage" SET "turn_id" = "id" WHERE "turn_id" IS NULL;
ALTER TABLE "ibx_domain"."llm_token_usage" ALTER COLUMN "turn_id" SET NOT NULL;

-- CreateIndex: the unique idempotency key.
CREATE UNIQUE INDEX "llm_token_usage_turn_id_key" ON "ibx_domain"."llm_token_usage"("turn_id");
