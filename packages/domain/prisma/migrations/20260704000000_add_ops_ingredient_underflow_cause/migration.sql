-- AlterEnum: extend the ops-alert cause taxonomy (NEW-037).
-- Promotes the NEW-036 ingredient-depletion underflow (stock clamped at 0 with a
-- positive shortfall) into a first-class ops-alert cause so it surfaces in the
-- admin ops-alerts inbox + the ops agent, instead of only a structured WARN log.
--
-- Postgres enum add-value: appended AFTER 'ops_dlq_depth' (the enum is unordered
-- for filtering; append keeps the frozen taxonomy stable). IF NOT EXISTS makes the
-- statement idempotent so a re-apply / provision is a no-op. Mirrors the taxonomy
-- add-value idiom (see 20260701000000_add_pause_read_error_incident_cause).
ALTER TYPE "ibx_domain"."OpsAlertCause" ADD VALUE IF NOT EXISTS 'ops_ingredient_underflow';
