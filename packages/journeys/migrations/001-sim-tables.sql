-- 001-sim-tables.sql — T1b-5: persistent journey-run records.
--
-- sim_runs holds one row PER ATTEMPT of `ibx journey run` (run_id is the
-- attempt's runId — the same id the JSONL trace and the run report carry);
-- sim_results holds one row per declared expects[] entry of the journey,
-- reconciled against the observed intent_audit trail (gates/reconciliation.ts).
--
-- JOIN CONTRACT (the reason these tables exist): sim_runs.session_ids is the
-- run's HASHED audit-namespace set — the exact `hashed:`+sha256(raw +
-- AUDIT_REDACT_SECRET).hex.slice(0,8) values the audit redactor stamps into
-- intent_audit.session_id (D-012). The run's kernel decisions are therefore
-- recoverable with a plain SQL join (see SIM_RUN_DECISIONS_SQL in
-- src/harness/sim-store.ts):
--
--   sim_runs.session_ids ∋ intent_audit.session_id, recorded_at within
--   [started_at, finished_at]
--
-- The hashed envelope/AuditRecord schemas are NEVER touched: this layer only
-- ADDS its own tables and reads intent_audit through the join — no column,
-- constraint or trigger lands on any kernel table.
--
-- Writes go through the dedicated ibx_sim_writer role (INSERT/UPDATE on
-- sim_* only — scripts/test-stack/create-sim-writer-role.sql); the T1a-9
-- read-only oracle containment stays intact.
--
-- Applied by `ibx journey migrate` (apply-once ledger journeys_sim_migrations,
-- src/harness/sim-migrate.ts), wired into scripts/test-stack-up.sh step [2/4].

CREATE TABLE IF NOT EXISTS sim_runs (
  run_id            uuid PRIMARY KEY,
  journey_id        text        NOT NULL,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz NOT NULL,
  pass              boolean     NOT NULL,
  -- Attempt ordinal within the k-loop (1-based): one sim_runs row per attempt.
  attempt           integer     NOT NULL,
  -- The SUT model pin (ANTHROPIC_MODEL) the attempt ran against (DR-1).
  model_id          text        NOT NULL,
  -- false = the DR-1 cheap-model dev profile (non-certifying escape used).
  certifying        boolean     NOT NULL,
  cost_usd          numeric(12, 6) NOT NULL,
  driver_tokens_in  integer     NOT NULL DEFAULT 0,
  driver_tokens_out integer     NOT NULL DEFAULT 0,
  sut_tokens_in     integer     NOT NULL DEFAULT 0,
  sut_tokens_out    integer     NOT NULL DEFAULT 0,
  -- The run's HASHED sessionId namespaces (jsonb array of text) — D-012.
  session_ids       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT sim_runs_attempt_positive CHECK (attempt >= 1),
  CONSTRAINT sim_runs_session_ids_is_array CHECK (jsonb_typeof(session_ids) = 'array')
);

CREATE INDEX IF NOT EXISTS sim_runs_journey_started_idx
  ON sim_runs (journey_id, started_at);
CREATE INDEX IF NOT EXISTS sim_runs_session_ids_gin_idx
  ON sim_runs USING gin (session_ids);

CREATE TABLE IF NOT EXISTS sim_results (
  run_id            uuid    NOT NULL REFERENCES sim_runs (run_id) ON DELETE CASCADE,
  -- Index into the journey's declared expects[] (file order, 0-based).
  seq               integer NOT NULL,
  expect_kind       text    NOT NULL,
  expect_decision   text    NOT NULL,
  -- true iff an observed intent_audit record matched the declared
  -- (kind, decision) tuple in the run's namespaces (reconciliation gate).
  observed          boolean NOT NULL,
  -- The decision actually observed for expect_kind (equals expect_decision
  -- when observed; the divergent decision when the kind appeared with a
  -- different one; NULL when the kind never appeared).
  decision_observed text,
  -- intent_audit.intent_hash of the observed record (NULL when unobserved).
  intent_hash       text,
  PRIMARY KEY (run_id, seq),
  CONSTRAINT sim_results_seq_nonnegative CHECK (seq >= 0)
);
