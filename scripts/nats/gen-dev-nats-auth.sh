#!/usr/bin/env bash
# scripts/nats/gen-dev-nats-auth.sh — provision per-machine NATS auth (T3-10).
#
# The dev compose NATS server (docker-compose.yml + infra/nats/
# nats-server.app.conf) now REFUSES unauthenticated clients. This script mints
# one user nkey pair and writes it into the target env file:
#   • NATS_NKEY_SEED        — client credential (@ibatexas/nats-client)
#   • NATS_APP_NKEY_PUBLIC  — server-side authorization (interpolated into the
#                             NATS config by docker compose)
#
# Existing empty assignments (the .env.example placeholders) are filled
# in-place; missing vars are appended. Non-empty values are PRESERVED unless
# --force is passed (rotation: regenerate, then restart the nats container AND
# every app process). Values are never printed.
#
# Usage:
#   ./scripts/nats/gen-dev-nats-auth.sh            # provision .env
#   ./scripts/nats/gen-dev-nats-auth.sh --force    # rotate (new pair)
#   ./scripts/nats/gen-dev-nats-auth.sh --env-file /path/to/.env [--force]
#
# The production compose surface (docker-compose.prod.yml) uses the same two
# vars in its .env; the dev-EC2 / ECS surfaces carry them in SSM / Secrets
# Manager instead (see docs/security/NATS-AUTH-REQUIREMENTS.md).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --env-file) ENV_FILE="${2:?--env-file needs a path}"; shift 2 ;;
    *) echo "error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "error: node not found on PATH" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "error: $ENV_FILE not found (copy .env.example first)" >&2; exit 1; }

# Refuse to overwrite live credentials without --force.
existing_nonempty() {
  # true when VAR is assigned a non-empty value in the env file
  grep -qE "^$1=..*" "$ENV_FILE"
}
if [[ "$FORCE" != "1" ]] && { existing_nonempty NATS_NKEY_SEED || existing_nonempty NATS_APP_NKEY_PUBLIC; }; then
  echo "error: NATS_NKEY_SEED / NATS_APP_NKEY_PUBLIC already set in $ENV_FILE — pass --force to rotate" >&2
  exit 1
fi

read -r SEED PUBLIC < <(node "$REPO_ROOT/scripts/nats/gen-nkey-user.mjs")
[[ -n "$SEED" && -n "$PUBLIC" ]] || { echo "error: nkey generation failed" >&2; exit 1; }

set_var() {
  local var="$1" value="$2" tmp
  tmp="$(mktemp)"
  if grep -qE "^$var=" "$ENV_FILE"; then
    awk -v var="$var" -v value="$value" 'index($0, var "=") == 1 { print var "=" value; next } { print }' \
      "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"
    printf '%s=%s\n' "$var" "$value" >> "$tmp"
  fi
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

set_var NATS_NKEY_SEED "$SEED"
set_var NATS_APP_NKEY_PUBLIC "$PUBLIC"

echo "wrote NATS_NKEY_SEED + NATS_APP_NKEY_PUBLIC to $ENV_FILE (values not shown)." >&2
echo "Restart the nats container and the apps to pick them up (e.g. docker compose up -d nats)." >&2
