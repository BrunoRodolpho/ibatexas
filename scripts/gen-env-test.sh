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

command -v node >/dev/null 2>&1 || { echo "error: node not found on PATH (needed for NATS nkey generation)" >&2; exit 1; }

gen() { openssl rand -hex 24; }
# T3-10: one NATS user nkey pair per test-plane role ("SEED PUBLIC" on stdout;
# never echoed to the terminal).
nkey_pair() { node "$REPO_ROOT/scripts/nats/gen-nkey-user.mjs"; }

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
SIM_PW="$(gen)"
# T2-1: the Stripe webhook secret is the paid-state fixture's signing trust
# anchor (template value is `whsec___GENERATE__` — the whsec_ prefix survives).
STRIPE_WH="$(gen)"
FINGERPRINT="ibx-test-$(openssl rand -hex 16)"
# T3-10: three per-machine NATS nkey pairs — app (publish+subscribe), capture
# (subscribe-only), trigger (publish ibatexas.> only). Seeds are client
# credentials; public keys go to the server config via docker-compose.test.yml.
read -r NKEY_APP_SEED NKEY_APP_PUBLIC < <(nkey_pair)
read -r NKEY_CAPTURE_SEED NKEY_CAPTURE_PUBLIC < <(nkey_pair)
read -r NKEY_TRIGGER_SEED NKEY_TRIGGER_PUBLIC < <(nkey_pair)
for v in "$NKEY_APP_SEED" "$NKEY_APP_PUBLIC" "$NKEY_CAPTURE_SEED" "$NKEY_CAPTURE_PUBLIC" "$NKEY_TRIGGER_SEED" "$NKEY_TRIGGER_PUBLIC"; do
  [[ -n "$v" ]] || { echo "error: NATS nkey generation failed (scripts/nats/gen-nkey-user.mjs)" >&2; exit 1; }
done

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
  -v oracle="$ORACLE_PW" -v simw="$SIM_PW" -v stripewh="$STRIPE_WH" \
  -v fp="$FINGERPRINT" -v anthropic="$ANTHROPIC_KEY" \
  -v tapiport="${TEST_API_PORT:-3001}" -v tcommport="${TEST_COMMERCE_PORT:-9000}" \
  -v nkappseed="$NKEY_APP_SEED" -v nkapppub="$NKEY_APP_PUBLIC" \
  -v nkcapseed="$NKEY_CAPTURE_SEED" -v nkcappub="$NKEY_CAPTURE_PUBLIC" \
  -v nktrgseed="$NKEY_TRIGGER_SEED" -v nktrgpub="$NKEY_TRIGGER_PUBLIC" '
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
  /^IBX_TEST_SIM_PASSWORD=|^SIM_DATABASE_URL=/ { subst(simw) }
  /^STRIPE_WEBHOOK_SECRET=/           { subst(stripewh) }
  /^IBX_TEST_FINGERPRINT=/            { gsub(/__GENERATE__/, fp) }
  /^ANTHROPIC_API_KEY=/               { gsub(/__FROM_DEV_ENV__/, anthropic) }
  # FE-D25: app ports — override the template defaults with the environment
  # (TEST_API_PORT / TEST_COMMERCE_PORT) when set, else keep 3001 / 9000. This
  # is what lets the ephemeral stack coexist with dev without hand-patching.
  /^TEST_API_PORT=/                   { print "TEST_API_PORT=" tapiport; next }
  /^TEST_COMMERCE_PORT=/              { print "TEST_COMMERCE_PORT=" tcommport; next }
  # T3-10 NATS nkey tokens are globally unique — substitute on any line.
  {
    gsub(/__GENERATE_NKEY_APP_SEED__/, nkappseed)
    gsub(/__GENERATE_NKEY_APP_PUBLIC__/, nkapppub)
    gsub(/__GENERATE_NKEY_CAPTURE_SEED__/, nkcapseed)
    gsub(/__GENERATE_NKEY_CAPTURE_PUBLIC__/, nkcappub)
    gsub(/__GENERATE_NKEY_TRIGGER_SEED__/, nktrgseed)
    gsub(/__GENERATE_NKEY_TRIGGER_PUBLIC__/, nktrgpub)
  }
  { print }
' "$TEMPLATE" > "$TARGET"
chmod 600 "$TARGET"

# Fail closed if any placeholder survived on an assignment line (comment lines
# may legitimately mention the placeholders) — template drift => contract drift.
if grep -qE '^[A-Za-z_]+=.*(__GENERATE(_[A-Z_]+)?__|__FROM_DEV_ENV__)' "$TARGET"; then
  echo "error: unresolved placeholders remain in $TARGET — .env.test.example added a var this script does not know; update scripts/gen-env-test.sh" >&2
  grep -nE '^[A-Za-z_]+=.*(__GENERATE(_[A-Z_]+)?__|__FROM_DEV_ENV__)' "$TARGET" | cut -d= -f1 >&2
  rm -f "$TARGET"
  exit 1
fi

echo "wrote $TARGET (mode 600). Secrets generated: IBX_TEST_POSTGRES_PASSWORD," >&2
echo "IBX_TEST_REDIS_PASSWORD/REDIS_PASSWORD, IBX_TEST_TYPESENSE_API_KEY/TYPESENSE_API_KEY," >&2
echo "JWT_SECRET, STAFF_JWT_SECRET, COOKIE_SECRET, SESSION_HMAC_SECRET, PHONE_HASH_PEPPER," >&2
echo "WEB_GATEWAY_SIGNING_KEY, AUDIT_REDACT_SECRET, ADMIN_API_KEY, MEDUSA_ADMIN_PASSWORD," >&2
echo "IBX_TEST_ORACLE_PASSWORD/ORACLE_DATABASE_URL (T1a-9 read-only oracle role)," >&2
echo "IBX_TEST_SIM_PASSWORD/SIM_DATABASE_URL (T1b-5 sim-store writer role)," >&2
echo "STRIPE_WEBHOOK_SECRET (T2-1 paid-state fixture signing anchor)," >&2
echo "NATS nkey pairs x3 (T3-10 — app pub+sub / capture subscribe-only / trigger publish-only)." >&2
echo "ANTHROPIC_API_KEY interpolated from .env; IBX_TEST_FINGERPRINT minted (values not shown)." >&2
