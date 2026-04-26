-- IBX-IGE Postgres audit mirror — schema migration.
--
-- Creates `intent_audit` as a partitioned table by month. Partitions are
-- created on demand by the migration's companion script
-- (see scripts/create-audit-partition.sql) — or by an adopter's preferred
-- partitioning extension (pg_partman, partman, etc.).
--
-- Retention policy: the migration creates partitions; adopters drop old
-- partitions according to their compliance window (typically 7y for finance,
-- 2y for general transactional audit).

CREATE TABLE IF NOT EXISTS intent_audit (
  id                BIGSERIAL,
  intent_hash       TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  kind              TEXT NOT NULL,
  principal         TEXT NOT NULL CHECK (principal IN ('llm', 'user', 'system')),
  taint             TEXT NOT NULL CHECK (taint IN ('SYSTEM', 'TRUSTED', 'UNTRUSTED')),
  decision_kind     TEXT NOT NULL,
  refusal_kind      TEXT NULL,
  refusal_code      TEXT NULL,
  decision_basis    TEXT[] NOT NULL,
  resource_version  TEXT NULL,
  envelope_jsonb    JSONB NOT NULL,
  decision_jsonb    JSONB NOT NULL,
  recorded_at       TIMESTAMPTZ NOT NULL,
  duration_ms       INTEGER NOT NULL,
  partition_month   TEXT NOT NULL,
  PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

-- Indexes for the common query patterns:
--   1. By intent_hash for replay-by-intent
--   2. By session_id + recorded_at for "what happened in this session"
--   3. By kind + recorded_at for "show me all order.submit refusals last week"
--
-- Indexes are inherited by partitions automatically.
CREATE INDEX IF NOT EXISTS idx_intent_audit_intent_hash
  ON intent_audit (intent_hash, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_intent_audit_session
  ON intent_audit (session_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_intent_audit_kind_decision
  ON intent_audit (kind, decision_kind, recorded_at DESC);

-- Constraint: refusal_kind and refusal_code are co-present or both null.
ALTER TABLE intent_audit ADD CONSTRAINT intent_audit_refusal_pair
  CHECK ((refusal_kind IS NULL) = (refusal_code IS NULL));

-- Companion script (run monthly via cron / pg_partman / migration tooling):
--
--   CREATE TABLE intent_audit_2026_04 PARTITION OF intent_audit
--     FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
--
--   CREATE TABLE intent_audit_2026_05 PARTITION OF intent_audit
--     FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
--
-- Retention drop (after compliance window):
--
--   DROP TABLE IF EXISTS intent_audit_2024_01;
