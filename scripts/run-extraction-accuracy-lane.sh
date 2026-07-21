#!/usr/bin/env bash
# scripts/run-extraction-accuracy-lane.sh — FE-T08: the local-execution path
# for the extraction-accuracy meter's Nemotron lane (non-certifying — see
# docs/ops/runbooks/extraction-accuracy-nemotron-lane.md). Runs the SAME
# `ibx journey extraction-accuracy` invocation
# .github/workflows/nemotron-extraction-lane.yml wraps, usable RIGHT NOW
# with no self-hosted runner: this is the path FE-T07's PR #263 actually
# used for its 9 recorded live runs.
#
# Usage:
#   scripts/run-extraction-accuracy-lane.sh [--env-file <path>] [--api-base-url <url>] [-- <extra ibx flags>]
#
# Defaults: --env-file .env.test, --api-base-url http://localhost:3001.
# Always verifies against the committed baseline (exit 1 on regression) —
# pass `-- --json` to also get machine-readable output.
#
# ── If .env.test's own secrets don't match your running dev API ────────────
# .env.test is generated for the EPHEMERAL test-profile stack
# (scripts/gen-env-test.sh + scripts/test-stack-up.sh) — a DIFFERENT
# Postgres/Redis/API instance from an ad-hoc `ibx dev` checkout. Driving
# this lane against an ad-hoc dev stack instead (as FE-T07's live proof
# did) needs a small SCRATCH env file with the secrets that stack's API
# process actually loaded. The diagnostic sequence that surfaced this the
# first time (adapt paths/ports to your setup):
#
#   # Which secrets does .env.test have vs. what the running API loaded?
#   grep '^STAFF_JWT_SECRET\|^AUDIT_REDACT_SECRET' .env.test
#   grep '^STAFF_JWT_SECRET\|^AUDIT_REDACT_SECRET' .env
#
#   # Is there already an ibx_oracle_ro role on the dev Postgres?
#   psql "postgresql://<admin>@localhost:<port>/<db>" -c '\du'
#   # If not, provision one directly (safe — genuinely read-only; the
#   # existing script works against ANY Postgres instance, dev included):
#   #   scripts/test-stack/create-readonly-role.sql (substitute
#   #   __ORACLE_PASSWORD__ and run as the migration/admin role)
#
#   # Which repo checkout / process is the API actually running from?
#   lsof -i :3001 -sTCP:LISTEN
#
# Build the scratch file (STAFF_JWT_SECRET from the REAL running api's env,
# AUDIT_REDACT_SECRET="" is valid/tolerated if that's what the api uses,
# ORACLE_DATABASE_URL pointing at the role you provisioned/found,
# REDIS_URL + IBX_TEST_FINGERPRINT — see the runbook for the full list),
# then pass it via --env-file.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE=".env.test"
API_BASE_URL="http://localhost:3001"
EXTRA_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --api-base-url)
      API_BASE_URL="$2"
      shift 2
      ;;
    --)
      shift
      EXTRA_ARGS=("$@")
      break
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ ! -f packages/cli/dist/index.js ]; then
  echo "packages/cli/dist/index.js missing — building the CLI + workspace deps first..." >&2
  npx turbo run build --filter="@ibatexas/cli..."
fi

echo "extraction-accuracy lane: env-file=$ENV_FILE api-base-url=$API_BASE_URL" >&2

exec node packages/cli/dist/index.js journey extraction-accuracy \
  --env-file "$ENV_FILE" \
  --api-base-url "$API_BASE_URL" \
  --verify-file packages/journeys/governance/extraction-accuracy-baseline.json \
  "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
