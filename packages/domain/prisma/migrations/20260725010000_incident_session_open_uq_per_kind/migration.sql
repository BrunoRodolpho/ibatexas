-- Scope the per-session open-incident partial unique index BY JOURNAL KIND (BKL-211).
--
-- 20260628000000 created:
--
--   CREATE UNIQUE INDEX conversation_incidents_session_open_uq
--     ON conversation_incidents(session_id) WHERE status IN ('OPEN','ACKNOWLEDGED');
--
-- i.e. AT MOST ONE non-terminal incident per session, full stop. That was exactly
-- right while `no_reply` was the only journal: repeat drops on one conversation
-- SHOULD fold into a single row (dropCount++) rather than storm the inbox.
--
-- BKL-211 adds a SECOND journal on the same table (`kind = 'security_probe'`) with
-- deliberately opposite lifecycle semantics — it models an attack REVIEW item, so a
-- delivered reply must NOT auto-close it (see incident-auto-close.ts and
-- incident.service.ts `findOpenBySession`). Left unscoped, the old index makes the
-- two journals mutually exclusive per session and produces a REGRESSION in the W1
-- no-reply backstop:
--
--   a never-auto-closing security_probe row occupies the session's single open
--   slot ⇒ a later genuine ghost (empty completion / send failure) can no longer
--   open a fresh incident. `openExecutor` folds it into the security row as a
--   dropCount increment, `opened` stays false, `conversation.incident_opened` is
--   never published, and the staff WhatsApp ping for a real customer-facing outage
--   silently never fires.
--
-- Scoping the index to (session_id, kind) keeps the fold-repeats-into-one-row
-- invariant WITHIN each journal while letting the two coexist. `openExecutor`'s
-- session-dedup lookups are scoped by the same `kind`, so the index and the
-- imperative dedup agree.
--
-- Hand-written (the Prisma DSL cannot express the WHERE): a future
-- `prisma migrate dev` reads it as drift and tries to DROP it — keep it
-- hand-written, mirroring the original and `ops_alerts_dedupe_open_uq`.
--
-- Re-apply safety (`ibx db provision`): DROP ... IF EXISTS + CREATE ... IF NOT
-- EXISTS make this idempotent. Existing rows cannot violate the new index: it is
-- strictly WEAKER than the one it replaces (any pair unique on (session_id) is
-- unique on (session_id, kind)), so no backfill and no conflict is possible.
DROP INDEX IF EXISTS "ibx_domain"."conversation_incidents_session_open_uq";

CREATE UNIQUE INDEX IF NOT EXISTS "conversation_incidents_session_open_uq"
  ON "ibx_domain"."conversation_incidents"("session_id", "kind")
  WHERE "status" IN ('OPEN', 'ACKNOWLEDGED');
