-- scripts/test-stack/create-readonly-role.sql — T1a-9 test-plane containment:
-- SELECT-only Postgres role for the journeys oracle (@ibatexas/journeys).
--
-- The deterministic oracle (AuditReader, goal-state invariants, projection
-- checks) must be structurally incapable of mutating SUT state: it connects
-- via ORACLE_DATABASE_URL (see .env.test.example) as role ibx_oracle_ro,
-- which holds SELECT-only privileges on the two schemas the oracle reads:
--
--   public      — the kernel audit tables (intent_audit + partitions,
--                 audit_outcomes, governance_events, audit_guard_stats; the
--                 @adjudicate/audit-postgres migrations are unqualified =>
--                 public) and the Medusa/claustrum tables that share it.
--   ibx_domain  — the Prisma domain schema (packages/domain/prisma).
--
-- No INSERT/UPDATE/DELETE/TRUNCATE/CREATE anywhere: a write attempt fails
-- with SQLSTATE 42501 insufficient_privilege (pinned by the integration test
-- packages/journeys/src/oracle/__tests__/readonly-role.integration.test.ts).
-- We deliberately do NOT set default_transaction_read_only on the role: it is
-- session-overridable, and it would mask the privilege boundary (writes would
-- fail 25006 instead of 42501). The hard guarantee is privilege ABSENCE.
--
-- Apply AFTER `ibx bootstrap` (migrations create ibx_domain + the audit
-- tables; the script fails loudly if run too early). Run it as the SAME role
-- that runs migrations (the compose POSTGRES_USER, default `ibatexas`): the
-- ALTER DEFAULT PRIVILEGES statements below bind to the executing role, so
-- tables created later by that role (monthly intent_audit partitions, new
-- migrations) are SELECT-able by ibx_oracle_ro without re-provisioning.
--
-- __ORACLE_PASSWORD__ is a sentinel substituted by the wrapper
-- (scripts/test-stack/provision-oracle-role.sh) from IBX_TEST_ORACLE_PASSWORD
-- (.env.test). It must never contain a single quote or backslash — the
-- generator (scripts/gen-env-test.sh) emits hex, which satisfies that.
--
-- Idempotent: re-running re-syncs the password and re-applies the grants.

-- ── Role (create or re-sync) ─────────────────────────────────────────────────
DO $role$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'ibx_oracle_ro') THEN
    EXECUTE format(
      'ALTER ROLE ibx_oracle_ro WITH LOGIN PASSWORD %L '
      || 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
      '__ORACLE_PASSWORD__'
    );
  ELSE
    EXECUTE format(
      'CREATE ROLE ibx_oracle_ro WITH LOGIN PASSWORD %L '
      || 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
      '__ORACLE_PASSWORD__'
    );
  END IF;
END
$role$;

-- ── Ordering guard: migrations must have run first ───────────────────────────
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.schemata WHERE schema_name = 'ibx_domain'
  ) THEN
    RAISE EXCEPTION
      'schema ibx_domain not found — run the migration layers (ibx bootstrap) '
      'before provisioning ibx_oracle_ro';
  END IF;
END
$guard$;

-- ── Read surface: current database, public + ibx_domain, SELECT only ─────────
DO $connect$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ibx_oracle_ro', current_database());
END
$connect$;

GRANT USAGE ON SCHEMA public TO ibx_oracle_ro;
GRANT USAGE ON SCHEMA ibx_domain TO ibx_oracle_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ibx_oracle_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA ibx_domain TO ibx_oracle_ro;

-- Future tables created by the executing (migration) role — e.g. the monthly
-- intent_audit partitions minted by `ibx kernel migrate` — stay SELECT-able.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ibx_oracle_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA ibx_domain GRANT SELECT ON TABLES TO ibx_oracle_ro;

-- Belt-and-braces: PG15+ already revoked PUBLIC's CREATE on schema public,
-- but make the oracle's inability to create objects explicit.
REVOKE CREATE ON SCHEMA public FROM ibx_oracle_ro;
REVOKE CREATE ON SCHEMA ibx_domain FROM ibx_oracle_ro;
