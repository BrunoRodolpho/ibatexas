#!/usr/bin/env bash
# scripts/healthcheck.sh
# Verifies that all local infrastructure services are up and healthy.
# Run this after `docker compose up -d` to confirm everything is ready.

set -uo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # no colour

# ── Load .env if present (silently skip if missing) ──────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/.env" 2>/dev/null || true

# Port defaults — override via .env
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
REDIS_PORT="${REDIS_PORT:-6379}"
NATS_PORT="${NATS_PORT:-4222}"
TYPESENSE_PORT="${TYPESENSE_PORT:-8108}"
API_PORT="${PORT:-3001}"
COMMERCE_PORT="${COMMERCE_PORT:-9000}"
WEB_PORT="${WEB_PORT:-3000}"

PASS=0
FAIL=0

check() {
  local name="$1"
  local cmd="$2"
  if eval "$cmd" &>/dev/null; then
    echo -e "${GREEN}✓${NC}  $name"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}✗${NC}  $name"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "IbateXas — Local Infrastructure Health Check"
echo "─────────────────────────────────────────────"
echo ""

# ── Docker containers ──────────────────────────────────────────────────────────
echo "Docker containers:"
check "PostgreSQL"  "docker inspect --format='{{.State.Health.Status}}' ibatexas-postgres 2>/dev/null | grep -q healthy"
check "Redis"       "docker inspect --format='{{.State.Health.Status}}' ibatexas-redis    2>/dev/null | grep -q healthy"
check "NATS"        "docker inspect --format='{{.State.Health.Status}}' ibatexas-nats     2>/dev/null | grep -q healthy"
check "Typesense"   "docker inspect --format='{{.State.Health.Status}}' ibatexas-typesense 2>/dev/null | grep -q healthy"

echo ""

# ── Network connectivity ───────────────────────────────────────────────────────
echo "Network connectivity:"
check "PostgreSQL  :${POSTGRES_PORT}"  "bash -c 'echo > /dev/tcp/localhost/${POSTGRES_PORT}' 2>/dev/null"
check "Redis       :${REDIS_PORT}"     "bash -c 'echo > /dev/tcp/localhost/${REDIS_PORT}' 2>/dev/null"
check "NATS        :${NATS_PORT}"      "bash -c 'echo > /dev/tcp/localhost/${NATS_PORT}' 2>/dev/null"
check "Typesense   :${TYPESENSE_PORT}" "bash -c 'echo > /dev/tcp/localhost/${TYPESENSE_PORT}' 2>/dev/null"

echo ""

# ── App services (only checked if port is open) ────────────────────────────────
APP_CHECKS=0

check_app() {
  local name="$1"
  local port="$2"
  local url="$3"
  # Skip silently if the app is not running
  if ! bash -c "echo > /dev/tcp/localhost/$port" 2>/dev/null; then
    return
  fi
  APP_CHECKS=$((APP_CHECKS + 1))
  if curl -sf "$url" &>/dev/null; then
    echo -e "${GREEN}✓${NC}  $name"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}✗${NC}  $name"
    FAIL=$((FAIL + 1))
  fi
}

check_app "API         :${API_PORT}"      "${API_PORT}"      "http://localhost:${API_PORT}/health"
check_app "Commerce    :${COMMERCE_PORT}" "${COMMERCE_PORT}" "http://localhost:${COMMERCE_PORT}/health"
check_app "Web         :${WEB_PORT}"      "${WEB_PORT}"      "http://localhost:${WEB_PORT}"

if [ "$APP_CHECKS" -gt 0 ]; then
  echo ""
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo "─────────────────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}All checks passed ($PASS/$((PASS + FAIL)))${NC}"
  echo ""
  echo "Ready. Run: pnpm install && turbo dev"
else
  echo -e "${RED}$FAIL check(s) failed${NC} — $PASS/$((PASS + FAIL)) passed"
  echo ""
  echo -e "${YELLOW}Tip:${NC} run 'docker compose up -d' and wait ~10 seconds, then retry."
  exit 1
fi
echo ""
