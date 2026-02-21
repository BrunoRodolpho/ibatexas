#!/usr/bin/env bash
# scripts/healthcheck.sh
# Verifies that all local infrastructure services are up and healthy.
# Run this after `docker compose up -d` to confirm everything is ready.

set -uo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # no colour

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
check "PostgreSQL  :5432" "bash -c 'echo > /dev/tcp/localhost/5432' 2>/dev/null"
check "Redis       :6379" "bash -c 'echo > /dev/tcp/localhost/6379' 2>/dev/null"
check "NATS        :4222" "bash -c 'echo > /dev/tcp/localhost/4222' 2>/dev/null"
check "Typesense   :8108" "bash -c 'echo > /dev/tcp/localhost/8108' 2>/dev/null"

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

check_app "API         :3001" 3001 "http://localhost:3001/health"
check_app "Commerce    :9000" 9000 "http://localhost:9000/health"
check_app "Web         :3000" 3000 "http://localhost:3000"

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
