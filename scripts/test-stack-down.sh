#!/usr/bin/env bash
# scripts/test-stack-down.sh — T1a-11b: tear down the ephemeral journey-test
# stack brought up by scripts/test-stack-up.sh. Idempotent and tolerant: every
# step is attempted even if earlier ones fail (the run is over — leave nothing
# behind). Volumes are ALWAYS removed (`down -v`): the isolation model is one
# composition per run (T1a-11a), so test data never survives a run.
#
# Knobs (must match the up invocation):
#   IBX_TEST_COMPOSE_PROJECT  compose project name (default ibx-test)
#   IBX_TEST_PC_PORT          process-compose server port (default 28505)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE=".env.test"
COMPOSE_FILE="docker-compose.test.yml"
PROJECT="${IBX_TEST_COMPOSE_PROJECT:-ibx-test}"
PC_PORT="${IBX_TEST_PC_PORT:-28505}"

rc=0

# ── 1. Stop the app processes (process-compose) ──────────────────────────────
if process-compose process list -p "$PC_PORT" >/dev/null 2>&1; then
  echo "stopping app processes (process-compose down -p $PC_PORT)..."
  process-compose down -p "$PC_PORT" || rc=1
elif process-compose process list -p 8080 >/dev/null 2>&1; then
  # A test profile started with the bare plan command (`process-compose -f
  # process-compose.test.yaml up -D`) lands on the default port 8080 — but so
  # does a DEV instance. Only down it if it looks like the test profile
  # (api+commerce only; dev also runs infra/web/admin).
  PROCS="$(process-compose process list -p 8080 2>/dev/null || true)"
  if echo "$PROCS" | grep -qE '\b(web|admin|infra)\b'; then
    echo "process-compose on :8080 looks like the DEV stack — leaving it alone" >&2
  else
    echo "stopping app processes (process-compose down -p 8080)..."
    process-compose down -p 8080 || rc=1
  fi
else
  echo "no process-compose instance found (ports $PC_PORT/8080) — skipping"
fi

# App ports should be free now; orphans would block the next run.
sleep 1
for port in 3001 9000; do
  if lsof -ti ":$port" >/dev/null 2>&1; then
    echo "warning: port $port still busy after process-compose down — kill manually (lsof -ti :$port | xargs kill)" >&2
    rc=1
  fi
done

# ── 2. Tear down the ephemeral infra (volumes included) ──────────────────────
echo "tearing down infra (docker compose -p $PROJECT down -v)..."
if [[ -f "$ENV_FILE" ]]; then
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "$PROJECT" down -v --remove-orphans || rc=1
else
  # All IBX_TEST_* interpolation vars have defaults — down works without the env file.
  docker compose -f "$COMPOSE_FILE" -p "$PROJECT" down -v --remove-orphans || rc=1
fi

if [[ $rc -eq 0 ]]; then
  echo "test stack torn down."
else
  echo "test stack teardown finished with warnings — review output above." >&2
fi
exit "$rc"
