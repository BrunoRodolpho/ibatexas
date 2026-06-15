#!/usr/bin/env bash
# scripts/test-stack/provision-sim-writer-role.sh — T1b-5: provision the
# sim-store writer role (ibx_sim_writer — INSERT/UPDATE on sim_runs +
# sim_results ONLY) on the ephemeral journey-test Postgres.
#
# Applies scripts/test-stack/create-sim-writer-role.sql inside the test
# stack's postgres container (no host psql dependency), substituting the
# __SIM_WRITER_PASSWORD__ sentinel from IBX_TEST_SIM_PASSWORD (.env.test).
# `ibx journey run` then persists run records via SIM_DATABASE_URL — see
# .env.test.example for both vars. The T1a-9 read-only oracle containment is
# untouched: this is a SECOND dedicated role, never a widening of the first.
#
# Invoked by scripts/test-stack-up.sh AFTER `ibx journey migrate` (the SQL
# fails loudly if the sim_runs table does not exist yet). Idempotent —
# re-running re-syncs the password and re-applies the grants.
#
# Standalone usage (test stack infra up, `ibx journey migrate` applied):
#   ./scripts/test-stack/provision-sim-writer-role.sh
#
# Knobs (env, all defaulted, same names as test-stack-up.sh):
#   IBX_TEST_COMPOSE_PROJECT  compose project name (default ibx-test)
#   IBX_TEST_ENV_FILE         env file (default .env.test)
#
# Exit codes: 0 role provisioned; 1 precondition or SQL failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="${IBX_TEST_ENV_FILE:-.env.test}"
COMPOSE_FILE="docker-compose.test.yml"
PROJECT="${IBX_TEST_COMPOSE_PROJECT:-ibx-test}"
SQL_FILE="scripts/test-stack/create-sim-writer-role.sql"

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ -f "$SQL_FILE" ]] || fail "$SQL_FILE not found"
[[ -f "$ENV_FILE" ]] || fail "$ENV_FILE not found — generate it with ./scripts/gen-env-test.sh"

# Pick up the env contract if the caller has not already exported it
# (test-stack-up.sh exports the whole file with `set -a` before calling us).
if [[ -z "${IBX_TEST_SIM_PASSWORD:-}" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "./$ENV_FILE"
  set +a
fi
[[ -n "${IBX_TEST_SIM_PASSWORD:-}" ]] \
  || fail "IBX_TEST_SIM_PASSWORD is empty in $ENV_FILE — regenerate with ./scripts/gen-env-test.sh --force"

PG_USER="${IBX_TEST_POSTGRES_USER:-ibatexas}"
PG_DB="${IBX_TEST_POSTGRES_DB:-ibatexas_test}"

# Substitute the password sentinel in pure bash so the secret never appears in
# an argv (visible via ps) and is never echoed.
SQL_TEXT="$(<"$SQL_FILE")"
SQL_TEXT="${SQL_TEXT//__SIM_WRITER_PASSWORD__/$IBX_TEST_SIM_PASSWORD}"

printf '%s\n' "$SQL_TEXT" | docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "$PROJECT" \
  exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -f -

echo "ibx_sim_writer provisioned: INSERT/UPDATE on sim_runs + sim_results only in db $PG_DB (project $PROJECT)."
echo "The runner persists run records via SIM_DATABASE_URL (.env.test)."
