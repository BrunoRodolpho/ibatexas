#!/usr/bin/env bash
# scripts/gen-env-test.sh — generate the real .env.test from .env.test.example.
#
# T1a-11a env contract. Produces a gitignored .env.test at the repo root:
#   • every __GENERATE__ placeholder → a fresh `openssl rand -hex 24` value
#     (48 hex chars — >=32-char requirement met, URL-safe so it can be embedded
#     in DATABASE_URL/REDIS_URL), each occurrence of a given VAR gets the SAME
#     value so compose interpolation vars and app URLs stay in sync.
#   • ANTHROPIC_API_KEY → interpolated from the developer's .env (never
#     committed, never printed by this script).
#   • IBX_TEST_FINGERPRINT → unique per generation (D-010: only the test
#     profile carries it; /health exposes it as testFingerprint).
#
# Distinctness guarantees asserted before writing:
#   • JWT_SECRET != STAFF_JWT_SECRET (server refuses to boot if they match).
#   • REDIS_PASSWORD == IBX_TEST_REDIS_PASSWORD and the password inside
#     REDIS_URL/DATABASE_URL matches its standalone var.
#
# Usage:
#   ./scripts/gen-env-test.sh           # refuses to overwrite an existing .env.test
#   ./scripts/gen-env-test.sh --force   # regenerate (new secrets + fingerprint)
#
# Exit codes: 0 written; 1 precondition failed (missing .env / ANTHROPIC_API_KEY
# / template, or .env.test exists without --force).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO_ROOT/.env.test.example"
TARGET="$REPO_ROOT/.env.test"
DEV_ENV="$REPO_ROOT/.env"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "error: template not found: $TEMPLATE" >&2
  exit 1
fi
if [[ -f "$TARGET" && "${1:-}" != "--force" ]]; then
  echo "error: $TARGET already exists — pass --force to regenerate (new secrets + fingerprint)" >&2
  exit 1
fi
if [[ ! -f "$DEV_ENV" ]]; then
  echo "error: $DEV_ENV not found — ANTHROPIC_API_KEY is interpolated from it" >&2
  exit 1
fi

# Extract ANTHROPIC_API_KEY from the dev .env without ever echoing it.
# Strips surrounding whitespace, optional quotes, and trailing inline comments.
ANTHROPIC_KEY="$(awk -F= '/^ANTHROPIC_API_KEY=/ { sub(/^[^=]*=/, ""); sub(/[[:space:]]+#.*$/, ""); gsub(/^[[:space:]"'"'"']+|[[:space:]"'"'"']+$/, ""); print; exit }' "$DEV_ENV")"
if [[ -z "$ANTHROPIC_KEY" ]]; then
  echo "error: ANTHROPIC_API_KEY is empty/missing in $DEV_ENV" >&2
  exit 1
fi

gen() { openssl rand -hex 24; }

# One secret per variable; reused everywhere that variable's value is embedded.
POSTGRES_PW="$(gen)"
REDIS_PW="$(gen)"
TYPESENSE_KEY="$(gen)"
JWT="$(gen)"
STAFF_JWT="$(gen)"
COOKIE="$(gen)"
SESSION_HMAC="$(gen)"
PHONE_PEPPER="$(gen)"
WEB_GATEWAY="$(gen)"
AUDIT_REDACT="$(gen)"
ADMIN_KEY="$(gen)"
MEDUSA_PW="$(gen)"
ORACLE_PW="$(gen)"
FINGERPRINT="ibx-test-$(openssl rand -hex 16)"

if [[ "$JWT" == "$STAFF_JWT" ]]; then
  echo "error: generated JWT_SECRET == STAFF_JWT_SECRET (astronomically unlikely) — rerun" >&2
  exit 1
fi

# Render the template. Placeholder substitution is variable-aware so that the
# same value lands in the standalone var AND inside composed URLs.
awk \
  -v pg="$POSTGRES_PW" -v redis="$REDIS_PW" -v ts="$TYPESENSE_KEY" \
  -v jwt="$JWT" -v staff="$STAFF_JWT" -v cookie="$COOKIE" \
  -v hmac="$SESSION_HMAC" -v pepper="$PHONE_PEPPER" -v gw="$WEB_GATEWAY" \
  -v redact="$AUDIT_REDACT" -v admin="$ADMIN_KEY" -v medusa="$MEDUSA_PW" \
  -v oracle="$ORACLE_PW" \
  -v fp="$FINGERPRINT" -v anthropic="$ANTHROPIC_KEY" '
  function subst(value) { gsub(/__GENERATE__/, value); }
  /^IBX_TEST_POSTGRES_PASSWORD=/      { subst(pg) }
  /^DATABASE_URL=|^DIRECT_DATABASE_URL=/ { subst(pg) }
  /^IBX_TEST_REDIS_PASSWORD=|^REDIS_PASSWORD=|^REDIS_URL=/ { subst(redis) }
  /^IBX_TEST_TYPESENSE_API_KEY=|^TYPESENSE_API_KEY=/ { subst(ts) }
  /^JWT_SECRET=/                      { subst(jwt) }
  /^STAFF_JWT_SECRET=/                { subst(staff) }
  /^COOKIE_SECRET=/                   { subst(cookie) }
  /^SESSION_HMAC_SECRET=/             { subst(hmac) }
  /^PHONE_HASH_PEPPER=/               { subst(pepper) }
  /^WEB_GATEWAY_SIGNING_KEY=/         { subst(gw) }
  /^AUDIT_REDACT_SECRET=/             { subst(redact) }
  /^ADMIN_API_KEY=/                   { subst(admin) }
  /^MEDUSA_ADMIN_PASSWORD=/           { subst(medusa) }
  /^IBX_TEST_ORACLE_PASSWORD=|^ORACLE_DATABASE_URL=/ { subst(oracle) }
  /^IBX_TEST_FINGERPRINT=/            { gsub(/__GENERATE__/, fp) }
  /^ANTHROPIC_API_KEY=/               { gsub(/__FROM_DEV_ENV__/, anthropic) }
  { print }
' "$TEMPLATE" > "$TARGET"
chmod 600 "$TARGET"

# Fail closed if any placeholder survived on an assignment line (comment lines
# may legitimately mention the placeholders) — template drift => contract drift.
if grep -qE '^[A-Za-z_]+=.*(__GENERATE__|__FROM_DEV_ENV__)' "$TARGET"; then
  echo "error: unresolved placeholders remain in $TARGET — .env.test.example added a var this script does not know; update scripts/gen-env-test.sh" >&2
  grep -nE '^[A-Za-z_]+=.*(__GENERATE__|__FROM_DEV_ENV__)' "$TARGET" | cut -d= -f1 >&2
  rm -f "$TARGET"
  exit 1
fi

echo "wrote $TARGET (mode 600). Secrets generated: IBX_TEST_POSTGRES_PASSWORD," >&2
echo "IBX_TEST_REDIS_PASSWORD/REDIS_PASSWORD, IBX_TEST_TYPESENSE_API_KEY/TYPESENSE_API_KEY," >&2
echo "JWT_SECRET, STAFF_JWT_SECRET, COOKIE_SECRET, SESSION_HMAC_SECRET, PHONE_HASH_PEPPER," >&2
echo "WEB_GATEWAY_SIGNING_KEY, AUDIT_REDACT_SECRET, ADMIN_API_KEY, MEDUSA_ADMIN_PASSWORD," >&2
echo "IBX_TEST_ORACLE_PASSWORD/ORACLE_DATABASE_URL (T1a-9 read-only oracle role)." >&2
echo "ANTHROPIC_API_KEY interpolated from .env; IBX_TEST_FINGERPRINT minted (values not shown)." >&2
