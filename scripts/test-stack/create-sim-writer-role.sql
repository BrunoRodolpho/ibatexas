-- scripts/test-stack/create-sim-writer-role.sql — T1b-5 sim-store containment:
-- dedicated writer role for the journeys sim_runs / sim_results tables.
--
-- ORACLE-grade separation, write side: `ibx journey run` persists run records
-- through SIM_DATABASE_URL as role ibx_sim_writer, which holds INSERT/UPDATE
-- on EXACTLY sim_runs + sim_results — nothing else, not even SELECT. The
-- T1a-9 read-only oracle containment stays intact (ibx_oracle_ro remains
-- SELECT-only and may read sim_* via its existing default privileges); the
-- sim writer can neither read nor mutate any SUT table — intent_audit,
-- Medusa, ibx_domain and claustrum_* writes all fail with SQLSTATE 42501
-- insufficient_privilege (pinned by packages/journeys/src/harness/__tests__/
-- sim-store.test.ts). DELETE/TRUNCATE are deliberately withheld even on
-- sim_*: run records are append-only evidence.
--
-- Apply AFTER `ibx journey migrate` (the grants need the tables; the script
-- fails loudly if run too early) as the SAME role that runs migrations (the
-- compose POSTGRES_USER, default `ibatexas`).
--
-- __SIM_WRITER_PASSWORD__ is a sentinel substituted by the wrapper
-- (scripts/test-stack/provision-sim-writer-role.sh) from IBX_TEST_SIM_PASSWORD
-- (.env.test). It must never contain a single quote or backslash — the
-- generator (scripts/gen-env-test.sh) emits hex, which satisfies that.
--
-- Idempotent: re-running re-syncs the password and re-applies the grants.

-- ── Role (create or re-sync) ─────────────────────────────────────────────────
DO $role$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'ibx_sim_writer') THEN
    EXECUTE format(
      'ALTER ROLE ibx_sim_writer WITH LOGIN PASSWORD %L '
      || 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
      '__SIM_WRITER_PASSWORD__'
    );
  ELSE
    EXECUTE format(
      'CREATE ROLE ibx_sim_writer WITH LOGIN PASSWORD %L '
      || 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
      '__SIM_WRITER_PASSWORD__'
    );
  END IF;
END
$role$;

-- ── Ordering guard: `ibx journey migrate` must have run first ────────────────
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'sim_runs'
  ) THEN
    RAISE EXCEPTION
      'table sim_runs not found — run `ibx journey migrate` before '
      'provisioning ibx_sim_writer';
  END IF;
END
$guard$;

-- ── Write surface: current database, sim_* only, INSERT/UPDATE only ──────────
DO $connect$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ibx_sim_writer', current_database());
END
$connect$;

GRANT USAGE ON SCHEMA public TO ibx_sim_writer;
GRANT INSERT, UPDATE ON TABLE sim_runs, sim_results TO ibx_sim_writer;

-- Belt-and-braces: PG15+ already revoked PUBLIC's CREATE on schema public,
-- but make the writer's inability to create objects explicit.
REVOKE CREATE ON SCHEMA public FROM ibx_sim_writer;
