#!/usr/bin/env bash
# scripts/test-stack-up.sh — T1a-11b: bring up the FULL ephemeral journey-test
# stack with counted, timed steps. This script is the canonical launcher; the
# measured total wall-clock re-baselines plan-v2 §7 (recorded in
# docs/agents/phase-1a-measurements.md).
#
#   [1/4] infra      docker compose --env-file .env.test -f docker-compose.test.yml
#                    -p <project> up -d --wait              (T1a-11a composition)
#   [2/4] migrate    ibx db provision (kernel audit-postgres schema WITH the
#                    intent_audit monthly partitions + claustrum memory/
#                    grounding schemas), then ibx bootstrap --skip-docker
#                    --skip-seed (Medusa + Prisma domain layers + Medusa admin
#                    user) — all against the test DB
#   [3/4] apps       process-compose up -f process-compose.test.yaml -e .env.test
#                    -D -p <pc-port>  → api :3001 + commerce :9000, then wait for
#                    both readiness endpoints. BKL-263: the profile interposes a
#                    `seed-promotions` one-shot between them — the api is GATED
#                    on it because LE2-018's boot reconciliation refuses to start
#                    without the declared promotions in this stack's Medusa.
#   [4/4] seed       ibx db reindex (creates the Typesense collection missing
#                    on virgin test infra), then ibx test seed (products →
#                    reindex → domain → homepage → delivery → orders →
#                    reviews → intel)
#
# Requirements: .env.test (generate with ./scripts/gen-env-test.sh — it
# interpolates ANTHROPIC_API_KEY from your dev .env; apps/api hard-requires it
# at boot), docker, process-compose, ibx, curl. The app ports default to
# 3001/9000 but are env-parameterized (TEST_API_PORT / TEST_COMMERCE_PORT in
# .env.test) — FE-D25: set a free pair to run this stack ALONGSIDE a dev stack
# that already holds :3001/:9000. The chosen pair must be free at bring-up.
#
# Knobs (env, all defaulted):
#   IBX_TEST_COMPOSE_PROJECT  compose project name (default ibx-test; use a
#                             run id, e.g. ibx-test-$CI_RUN_ID, to keep
#                             parallel runs and volumes apart)
#   IBX_TEST_PC_PORT          process-compose server port (default 28505 —
#                             distinct from the dev instance's 8080)
#   IBX_TEST_APP_WAIT_SECONDS per-app readiness budget (default 600)
#   IBX_TEST_E2E              "1" → ALSO boot apps/web (:3000) by overlaying
#                             process-compose.e2e.yaml on the test profile
#                             (T2-7 Playwright e2e stack). Default off: the
#                             journeys harness never needs the storefront UI.
#
# Teardown (ALWAYS run it, including after failures):
#   ./scripts/test-stack-down.sh
#
# Exit codes: 0 stack up + seeded; 1 any step failed (stack may be partially
# up — run test-stack-down.sh).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE=".env.test"
COMPOSE_FILE="docker-compose.test.yml"
PC_FILE="process-compose.test.yaml"
PC_E2E_FILE="process-compose.e2e.yaml"
PROJECT="${IBX_TEST_COMPOSE_PROJECT:-ibx-test}"
PC_PORT="${IBX_TEST_PC_PORT:-28505}"
APP_WAIT_SECONDS="${IBX_TEST_APP_WAIT_SECONDS:-600}"
E2E="${IBX_TEST_E2E:-0}"
# BKL-263: how much of a stuck process's own log a readiness failure prints.
FAILURE_LOG_LINES="${IBX_TEST_FAILURE_LOG_LINES:-120}"

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
now() { date +%s; }

# ── Preflight ────────────────────────────────────────────────────────────────
for bin in docker process-compose ibx curl; do
  command -v "$bin" >/dev/null 2>&1 || fail "$bin not found on PATH"
done
[[ -f "$ENV_FILE" ]] || fail "$ENV_FILE not found — generate it with ./scripts/gen-env-test.sh"
[[ -f "$PC_FILE" ]] || fail "$PC_FILE not found — run from the repo root"

# Export the full T1a-11a env contract BEFORE anything boots: apps load no
# dotenv of their own; the ibx CLI's dotenv load never overrides shell env
# (shell > root .env); and process-compose expands ${TEST_*_PORT} in the app
# profile from THIS shell's environment — so every child process AND the
# readiness probes see the test values. Sourced before the port preflight so
# TEST_API_PORT / TEST_COMMERCE_PORT are known. (FE-D26 made @ibatexas/tools
# read stack-targeting env at call time; this contract still supplies it.)
set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a

# apps/api/src/config.ts hard-requires ANTHROPIC_API_KEY at boot. Presence
# check only — the value is never printed.
[[ -n "${ANTHROPIC_API_KEY:-}" ]] || fail "ANTHROPIC_API_KEY is empty in $ENV_FILE — regenerate with ./scripts/gen-env-test.sh (interpolates it from .env)"

# FE-D25: env-parameterized app ports (defaults 3001/9000, sourced above from
# .env.test) so the ephemeral stack can coexist with a running dev stack.
APP_PORTS=("${TEST_API_PORT:-3001}" "${TEST_COMMERCE_PORT:-9000}")
if [[ "$E2E" == "1" ]]; then
  [[ -f "$PC_E2E_FILE" ]] || fail "$PC_E2E_FILE not found — run from the repo root"
  APP_PORTS+=(3000)
fi

for port in "${APP_PORTS[@]}"; do
  if lsof -ti ":$port" >/dev/null 2>&1; then
    fail "port $port is busy — set TEST_API_PORT / TEST_COMMERCE_PORT (in .env.test) to a free pair to coexist with dev, or stop the dev stack (ibx dev stop) first"
  fi
done

wait_http() {
  # wait_http <url> <name> [process...] — poll until 2xx (curl -f also rejects
  # the api's 503 degraded-boot responses), bounded by APP_WAIT_SECONDS.
  #
  # BKL-263: on timeout, DUMP the named processes' logs, don't just name the
  # command that would. An unreachable endpoint says nothing about why, and on
  # CI nobody can run the follow-up — the process-compose server dies with the
  # job. The four runs that motivated this ticket each left exactly one line
  # ("api (:3001) not ready after 600s") for a process that had printed a
  # complete refusal report to its own log, which cost a whole diagnosis cycle.
  local url="$1" name="$2"
  shift 2
  local logs=("$@")
  local deadline=$(( $(now) + APP_WAIT_SECONDS ))
  until curl -fsS -o /dev/null --max-time 5 "$url" 2>/dev/null; do
    if (( $(now) >= deadline )); then
      echo "error: $name not ready after ${APP_WAIT_SECONDS}s ($url)" >&2
      echo "--- process-compose state (port $PC_PORT) ---" >&2
      process-compose process list -p "$PC_PORT" >&2 || true
      local proc
      # `${a[@]+"${a[@]}"}`: bash 3.2 (still the /bin/bash a macOS dev runs this
      # with) treats an empty array's "${a[@]}" as unbound under `set -u`. Every
      # call site names a process today, so this only protects the next one.
      for proc in ${logs[@]+"${logs[@]}"}; do
        echo "--- last ${FAILURE_LOG_LINES} log lines: $proc ---" >&2
        process-compose process logs "$proc" -n "$FAILURE_LOG_LINES" -p "$PC_PORT" >&2 || true
      done
      echo "full logs: process-compose process logs <process> -p $PC_PORT" >&2
      return 1
    fi
    sleep 3
  done
  echo "  $name ready: $url"
}

echo "ibx journey-test stack up (project=$PROJECT, pc-port=$PC_PORT)"
T0=$(now)

# ── [1/4] Infra ──────────────────────────────────────────────────────────────
echo "[1/4] infra: docker compose -f $COMPOSE_FILE -p $PROJECT up -d --wait"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "$PROJECT" up -d --wait
T1=$(now)

# ── [2/4] Migration layers ───────────────────────────────────────────────────
# `ibx db provision` is REQUIRED (bootstrap's kernel step applies the
# audit-postgres schema but NOT the monthly intent_audit partitions; the api
# fail-fasts at boot without them: "table 'intent_audit' has no partitions")
# and MUST run BEFORE bootstrap: the two kernel runners keep separate
# apply-once ledgers (adjudicate_audit_migrations vs audit_schema_migrations).
# Bootstrap's runner tolerates already-applied DDL ("já aplicado") so it is
# safe second; provision's runner does not, so on a fresh DB it must go first.
echo "[2/4] migrate: ibx db provision + ibx bootstrap --skip-docker --skip-seed (test DB)"
ibx db provision
ibx bootstrap --skip-docker --skip-seed
# T1a-9: SELECT-only oracle role (ibx_oracle_ro) — must run after the migration
# layers (needs the ibx_domain + audit schemas). The journeys oracle connects
# via ORACLE_DATABASE_URL (.env.test) using this role.
IBX_TEST_COMPOSE_PROJECT="$PROJECT" ./scripts/test-stack/provision-oracle-role.sh
# T1b-5: journeys sim layer (sim_runs/sim_results — persistent run records
# joined to intent_audit via the hashed sessionId namespaces). Dedicated
# `ibx journey migrate` step, NOT folded into `ibx db provision`: the sim
# layer is test-plane-only and dev/prod flows also run `db provision`. The
# writer role (ibx_sim_writer — INSERT/UPDATE on sim_* only; the oracle
# stays read-only) is provisioned right after, since its grants need the
# tables. The runner persists run records via SIM_DATABASE_URL (.env.test).
ibx journey migrate
IBX_TEST_COMPOSE_PROJECT="$PROJECT" ./scripts/test-stack/provision-sim-writer-role.sh
T2=$(now)

# ── [3/4] App boot (process-compose test profile [+ e2e overlay]) ────────────
PC_FILE_ARGS=(-f "$PC_FILE")
if [[ "$E2E" == "1" ]]; then
  # T2-7: overlay merges the web (:3000) process on top of the test profile.
  PC_FILE_ARGS+=(-f "$PC_E2E_FILE")
fi
echo "[3/4] apps: process-compose up ${PC_FILE_ARGS[*]} -e $ENV_FILE -D -p $PC_PORT"
process-compose up "${PC_FILE_ARGS[@]}" -e "$ENV_FILE" -D -p "$PC_PORT"
# FE-D25: poll the parameterized ports — polling the hardcoded :9000/:3001 would
# silently succeed against DEV's already-healthy endpoints (a false-green that
# never waits for THIS stack) whenever the ports were reassigned to coexist.
wait_http "http://localhost:${TEST_COMMERCE_PORT:-9000}/health" "commerce (:${TEST_COMMERCE_PORT:-9000})" commerce
# BKL-263: seed-promotions is named alongside api because the api is GATED on it
# (process-compose.test.yaml) — when that one-shot fails, the api never starts at
# all and its own log is empty, so the answer is only in the seeder's.
wait_http "http://localhost:${TEST_API_PORT:-3001}/health" "api (:${TEST_API_PORT:-3001})" api seed-promotions
if [[ "$E2E" == "1" ]]; then
  wait_http "http://localhost:3000/" "web (:3000)" web
fi
T3=$(now)

# ── [4/4] Seed ───────────────────────────────────────────────────────────────
# `ibx db reindex` first: it ensureCollectionExists()-creates the Typesense
# products collection, which is MISSING on the virgin test Typesense — the
# Medusa seed script (apps/commerce/src/seed.ts) ends by reindexing into that
# collection and 404s without it (the dev stack never hits this because its
# Typesense volume persists). With zero products it exits 0 after creating
# the collection; idempotent afterwards.
echo "[4/4] seed: ibx db reindex (ensure Typesense collection) + ibx test seed"
ibx db reindex
ibx test seed
T4=$(now)

# ── Measurement ──────────────────────────────────────────────────────────────
echo ""
echo "IBX_TEST_STACK_TIMINGS infra=$((T1 - T0))s migrate=$((T2 - T1))s apps=$((T3 - T2))s seed=$((T4 - T3))s total=$((T4 - T0))s"
echo "Test stack is up. Record total boot+seed wall-clock in docs/agents/phase-1a-measurements.md."
echo "Tear down with: ./scripts/test-stack-down.sh"
