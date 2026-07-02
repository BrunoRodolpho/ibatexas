-- Add the `pause_read_error` no-reply incident cause (W1 — Redis-outage silent
-- ghosting fix). A bot-pause gate READ-ERROR (Redis unreachable) fails CLOSED and
-- suppresses the reply — the customer gets silence — but it is NOT a genuine
-- human-handoff pause, so it must open a governed incident distinct from a real
-- `suppressed_paused`. `ADD VALUE IF NOT EXISTS` keeps the migration idempotent
-- under `ibx db provision` re-apply.
ALTER TYPE "ibx_domain"."IncidentCause" ADD VALUE IF NOT EXISTS 'pause_read_error';
