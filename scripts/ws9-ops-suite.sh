#!/usr/bin/env bash
# scripts/ws9-ops-suite.sh — the WS9 ops-plane LIVE SUITE.
#
# Turns the ad-hoc 2026-07-04 ops-plane live proofs into a committed, repeatable
# harness. It drives the REAL planner through POST /api/admin/ops/chat against an
# ALREADY-RUNNING dev/test stack (api :3001 + Postgres + Redis) and asserts the
# outcome in the DBs. It NEVER boots the stack (see packages/journeys/src/live/README.md for that) and it
# is SAFE TO RE-RUN: every money scenario seeds its OWN fresh, governed order.
#
# Scenarios (see --list for the SCN mapping):
#   OPS-86            86 an item by name -> EXECUTE + egress, then revert
#   OPS-ROLE          an ATTENDANT 86 -> REFUSE staff_role_violation, no egress
#   OPS-REFUND-PARK   refund -> REQUEST_CONFIRMATION + park, then "não" clears it
#   OPS-REFUND-CONFIRM refund -> park -> "sim" -> EXECUTE + refund written
#   OPS-REFUND-ESCALATE >R$1000 refund -> ESCALATE, nothing parks
#   OPS-PARTIAL       "reembolsa 10 reais" -> R$ 10,00 parked (BKL-094 pin)
#
# MODEL-FLAKE vs ASSERT-FAIL (the WS9 bar without CI held hostage to a 4B mood):
#   The suite drives the REAL planner, which may wobble. If the planner never
#   emits the scenario's capability after N retries (WS9_RETRIES) with distinct
#   phrasings, the scenario is a MODEL-FLAKE (flake-skip, loudly marked) — the
#   suite still exits 0. If the capability IS emitted but the kernel decision or
#   the DB state is wrong, that is an ASSERT-FAIL (hard fail, exit 1): a money /
#   governance regression is never a "flake".
#
# Requirements on PATH: curl, jq, psql, docker, node (+ the repo's tsx). The
# suite sources the dev .env (WS9_ENV_FILE) for DATABASE_URL / STAFF_JWT_SECRET /
# REDIS_PASSWORD, or reads them from the environment.
#
# Exit: 0 = every scenario PASS or (marked) flake/skip; 1 = any ASSERT-FAIL or a
# preflight failure.

set -uo pipefail

# ── Layout ───────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE_DIR="$REPO_ROOT/packages/journeys/src/live"
TSX="${WS9_TSX:-$REPO_ROOT/node_modules/.bin/tsx}"

# ── Config knobs (all defaulted) ─────────────────────────────────────────────
IBX_API="${IBX_API:-http://localhost:3001}"
WS9_ENV_FILE="${WS9_ENV_FILE:-$HOME/projects/ibatexas/.env}"
WS9_RETRIES="${WS9_RETRIES:-2}"          # planner retries per scenario (distinct phrasings)
WS9_HTTP_TIMEOUT="${WS9_HTTP_TIMEOUT:-90}"
WS9_OWNER_PHONE="${WS9_OWNER_PHONE:-+12174174509}"     # Bruno R (OWNER) — seeded
WS9_MANAGER_PHONE="${WS9_MANAGER_PHONE:-+5519900000900}" # Tainá (MANAGER) — seeded
WS9_ATTENDANT_PHONE="${WS9_ATTENDANT_PHONE:-+5511970000097}" # suite-managed
WS9_86_PRODUCT="${WS9_86_PRODUCT:-Feijão Tropeiro}"     # a catalog item to 86 + restore (net-zero; override per seed)
WS9_REDIS_CONTAINER="${WS9_REDIS_CONTAINER:-ibatexas-redis}"
WS9_JSON="${WS9_JSON:-}"                  # optional path for the machine-readable summary
WS9_RESULT_JSON=""                        # accumulated per-scenario JSON objects
OWNER_ID=""                               # resolved at preflight (active OWNER staffId)

# ── Colours (tty only) ───────────────────────────────────────────────────────
if [[ -t 1 ]]; then C_G=$'\033[32m'; C_R=$'\033[31m'; C_Y=$'\033[33m'; C_B=$'\033[34m'; C_0=$'\033[0m'
else C_G=""; C_R=""; C_Y=""; C_B=""; C_0=""; fi

log()  { printf '%s\n' "$*"; }
info() { printf '%s• %s%s\n' "$C_B" "$*" "$C_0"; }
step() { printf '  %s\n' "$*"; }

# ── SCN mapping (a green run = evidence for these passes_live rows) ───────────
print_scn_map() {
  cat <<'EOF'
WS9 ops-plane live suite — scenario → tracker row mapping

  OPS-86             SCN-112 (OPS-02 "86 an item"), SCN-113 (OPS-03 "Restore an 86'd item")
                     also exercises OPS-002 (staff verb) via product.availability.set EXECUTE
  OPS-ROLE           SCN-125 (OPS-15 "Non-staff / insufficient-role tries a staff command")
                     the ATTENDANT staff_role_violation refusal (kernel AUTH, zero egress)
  OPS-REFUND-PARK    SCN-120 (OPS-10 "Approve an escalated refund"), OPS-009 ("Refund payment")
  OPS-REFUND-CONFIRM SCN-120, OPS-009, OPS-054 (payment.status_changed subscriber: refunded→cancel)
  OPS-REFUND-ESCALATE SCN-120 (the ≥R$1000 ESCALATE band), OPS-009
  OPS-PARTIAL        OPS-009, BKL-094 (spoken partial-refund amount threading — live regression pin)
EOF
}

if [[ "${1:-}" == "--list" ]]; then print_scn_map; exit 0; fi

# ── Env + tooling preflight ──────────────────────────────────────────────────
die() { printf '%serror:%s %s\n' "$C_R" "$C_0" "$*" >&2; exit 1; }

for bin in curl jq psql docker node; do
  command -v "$bin" >/dev/null 2>&1 || die "$bin not found on PATH"
done
[[ -x "$TSX" ]] || die "tsx not found at $TSX (run pnpm install at the repo root)"

if [[ -f "$WS9_ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$WS9_ENV_FILE"
  set +a
fi
[[ -n "${DATABASE_URL:-}" ]]    || die "DATABASE_URL not set (source the dev .env or export it)"
[[ -n "${STAFF_JWT_SECRET:-}" ]] || die "STAFF_JWT_SECRET not set (needed to mint staff tokens)"
WS9_REDIS_PASSWORD="${REDIS_PASSWORD:-}"

# The tsx helpers must NEVER see NODE_ENV=production (they refuse) and we unset it
# so prisma's dev query-logging stays off — stdout then carries only clean JSON.
run_helper() { NODE_ENV="" "$TSX" "$@" 2>/dev/null | grep -E '^\{' | tail -n1; }

# ── DB / Redis assertion primitives (read-only against the domain) ───────────
q() { psql "$DATABASE_URL" -tAc "$1" 2>/dev/null; }
redis_cli() { docker exec "$WS9_REDIS_CONTAINER" redis-cli -a "$WS9_REDIS_PASSWORD" "$@" 2>/dev/null; }

# now() as a Postgres-comparable timestamptz captured on the DB clock (avoids host skew).
db_now() { q "select now()"; }

# Count intent_audit rows since $1 (a captured db_now) matching kind $2, decision $3,
# and optional refusal_code $4. Serial suite ⇒ a time window uniquely scopes a turn.
audit_count() {
  local since="$1" kind="$2" decision="$3" refusal="${4:-}"
  local extra=""
  [[ -n "$refusal" ]] && extra="and refusal_code = $(sql_lit "$refusal")"
  q "select count(*) from public.intent_audit
       where recorded_at > $(sql_lit "$since")
         and kind = $(sql_lit "$kind")
         and decision_kind = $(sql_lit "$decision")
         $extra"
}
sql_lit() { printf "'%s'" "${1//\'/\'\'}"; }

# The OWNER/MANAGER staffId → the Redis ops-session key. Clears stale parks so a
# prior scenario's confirmation can never resume the next one.
clear_park() {
  local staff_id="$1" k
  while IFS= read -r k; do
    [[ -n "$k" ]] && redis_cli DEL "$k" >/dev/null
  done < <(redis_cli --scan --pattern "*claustrum:session:system:staff:${staff_id}")
}

# Read a staff session's first parked confirmation payload as JSON (best-effort).
park_payload_json() {
  local staff_id="$1" k val
  k="$(redis_cli --scan --pattern "*claustrum:session:system:staff:${staff_id}" | head -n1)"
  [[ -z "$k" ]] && return 1
  val="$(redis_cli GET "$k")"
  [[ -z "$val" ]] && return 1
  printf '%s' "$val" | jq -c '.pendingConfirmations[0].envelope.payload // empty' 2>/dev/null
}

# ── HTTP: one ops-chat turn ──────────────────────────────────────────────────
# ONE POST = one real turn (parking is stateful — never double-send). Echoes the
# response body {reply, decision, executed, proposedKinds}; on a 5xx the body is
# an {error:...} shape, which the resp_* readers tolerate (empty decision/kinds).
ops_chat() {
  local cookie="$1" message="$2" body
  body="$(jq -nc --arg m "$message" '{message:$m}')"
  curl -sS -m "$WS9_HTTP_TIMEOUT" -X POST "$IBX_API/api/admin/ops/chat" \
       -H 'content-type: application/json' -H "cookie: $cookie" \
       --data "$body" 2>/dev/null
}

# proposedKinds contains $2 ? (the "did the planner emit the capability" test).
resp_has_kind() { printf '%s' "$1" | jq -e --arg k "$2" '.proposedKinds // [] | index($k) != null' >/dev/null 2>&1; }
resp_decision() { printf '%s' "$1" | jq -r '.decision // ""' 2>/dev/null; }
resp_reply()    { printf '%s' "$1" | jq -r '.reply // ""' 2>/dev/null; }
resp_executed() { printf '%s' "$1" | jq -r '.executed // false' 2>/dev/null; }

# ── Result accumulation ──────────────────────────────────────────────────────
declare -a R_ID R_STATUS R_NOTE
record() { # id status note
  R_ID+=("$1"); R_STATUS+=("$2"); R_NOTE+=("$3")
  local colour="$C_Y"
  case "$2" in PASS) colour="$C_G";; FAIL) colour="$C_R";; esac
  printf '  %s%-6s%s %-20s %s\n' "$colour" "$2" "$C_0" "$1" "$3"
  WS9_RESULT_JSON+="$(jq -nc --arg id "$1" --arg s "$2" --arg n "$3" '{scenario:$id,status:$s,note:$n}'),"
}

# ── Token mint (with an idempotent ATTENDANT seed) ───────────────────────────
mint_cookie() { # phone → cookie  (empty on failure)
  run_helper "$LIVE_DIR/mint-staff-jwt.ts" --phone "$1" | jq -r '.cookie // ""' 2>/dev/null
}
ensure_attendant() {
  # Idempotent: `ibx auth create-staff` creates or reactivates. ATTENDANT is not
  # in the base seed, so OPS-ROLE needs the suite to guarantee one.
  ibx auth create-staff --phone "$WS9_ATTENDANT_PHONE" --name "WS9 Attendant" --role ATTENDANT >/dev/null 2>&1 || true
}

seed_order() { # amount_reais → JSON {orderId, displayId, paymentId, amountInCentavos,...}
  run_helper "$LIVE_DIR/seed-refundable-order.ts" --amount-reais "$1"
}

# ─────────────────────────────────────────────────────────────────────────────
#  Scenario drivers. Each records exactly one result. Model-emission failures are
#  FLAKE; kernel/DB assertion failures are FAIL.
# ─────────────────────────────────────────────────────────────────────────────

# Drive the planner up to WS9_RETRIES times with distinct phrasings until the
# response proposes $capability. Echoes the winning response; returns 1 if never.
# $1=cookie  $2=capability  $3..=phrasings
drive_until() {
  local cookie="$1" cap="$2"; shift 2
  local -a phrasings=("$@")
  local attempts=$(( WS9_RETRIES + 1 )) i=0 resp
  while (( i < attempts )); do
    local msg="${phrasings[$(( i % ${#phrasings[@]} ))]}"
    resp="$(ops_chat "$cookie" "$msg" 2>/dev/null)"
    if resp_has_kind "$resp" "$cap"; then printf '%s' "$resp"; return 0; fi
    (( i++ ))
  done
  return 1
}

scn_ops86() {
  local id="OPS-86" owner_cookie start dec resp reverts
  owner_cookie="$(mint_cookie "$WS9_OWNER_PHONE")"
  [[ -z "$owner_cookie" ]] && { record "$id" FAIL "could not mint OWNER token"; return; }
  clear_park "$OWNER_ID"
  start="$(db_now)"

  # 86 the item.
  resp="$(drive_until "$owner_cookie" "product.availability.set" \
      "86 o $WS9_86_PRODUCT pelo resto do dia" \
      "acabou o $WS9_86_PRODUCT, tira do cardápio" \
      "marca $WS9_86_PRODUCT como esgotado")" || {
    record "$id" FLAKE "planner never emitted product.availability.set for '$WS9_86_PRODUCT'"; return; }

  dec="$(resp_decision "$resp")"
  if [[ "$dec" != "EXECUTE" ]]; then
    # The 86 egress needs Medusa (:9000) up AND a resolvable product. An empty
    # decision (5xx), or a REFUSE whose reply is "produto não encontrado", is an
    # ENVIRONMENT gap (Medusa down / wrong product name) — not a money bug: SKIP.
    local reply86; reply86="$(resp_reply "$resp")"
    if [[ -z "$dec" ]]; then
      record "$id" SKIP "86 turn returned no decision (Medusa :9000 down — egress unreachable)"; return; fi
    if [[ "$dec" == "REFUSE" ]] && printf '%s' "$reply86" | grep -qi "não encontrado"; then
      record "$id" SKIP "product '$WS9_86_PRODUCT' not resolvable in the catalog — set WS9_86_PRODUCT to a real title"; return; fi
    record "$id" FAIL "86 emitted product.availability.set but decision=$dec (expected EXECUTE): '${reply86:0:80}'"; return
  fi
  # Governed chain: the staff verb EXECUTE + the medusa egress EXECUTE.
  local set_n egress_n
  set_n="$(audit_count "$start" "product.availability.set" "EXECUTE")"
  egress_n="$(audit_count "$start" "medusa.admin.product.update" "EXECUTE")"
  if [[ "${set_n:-0}" -lt 1 || "${egress_n:-0}" -lt 1 ]]; then
    record "$id" FAIL "86 decision=EXECUTE but audit chain incomplete (availability.set=$set_n egress=$egress_n)"; return
  fi

  # Revert (restore).
  resp="$(drive_until "$owner_cookie" "product.availability.set" \
      "voltou o $WS9_86_PRODUCT, pode vender de novo" \
      "chegou $WS9_86_PRODUCT, volta pro cardápio" \
      "reativa o $WS9_86_PRODUCT")" || {
    record "$id" PASS "86 EXECUTE + egress verified; revert flaked (planner) — 86 half proven"; return; }
  dec="$(resp_decision "$resp")"
  reverts="$(audit_count "$start" "product.availability.set" "EXECUTE")"
  if [[ "$dec" == "EXECUTE" && "${reverts:-0}" -ge 2 ]]; then
    record "$id" PASS "86 (SCN-112) + restore (SCN-113): 2× product.availability.set EXECUTE + medusa egress EXECUTE"
  else
    record "$id" FAIL "revert decision=$dec, availability.set EXECUTE count=$reverts (expected ≥2)"
  fi
}

scn_ops_role() {
  local id="OPS-ROLE" att_cookie start resp dec code egress_n
  att_cookie="$(mint_cookie "$WS9_ATTENDANT_PHONE")"
  [[ -z "$att_cookie" ]] && { record "$id" FAIL "could not mint ATTENDANT token (ensure_attendant failed?)"; return; }
  start="$(db_now)"
  resp="$(drive_until "$att_cookie" "product.availability.set" \
      "86 o $WS9_86_PRODUCT pelo resto do dia" \
      "acabou o $WS9_86_PRODUCT, tira do cardápio" \
      "marca $WS9_86_PRODUCT como esgotado")" || {
    record "$id" FLAKE "ATTENDANT planner never emitted product.availability.set"; return; }
  dec="$(resp_decision "$resp")"
  code="$(audit_count "$start" "product.availability.set" "REFUSE" "staff_role_violation")"
  egress_n="$(audit_count "$start" "medusa.admin.product.update" "EXECUTE")"
  if [[ "$dec" == "REFUSE" && "${code:-0}" -ge 1 && "${egress_n:-0}" -eq 0 ]]; then
    record "$id" PASS "ATTENDANT 86 → REFUSE staff_role_violation (kernel AUTH), zero egress (SCN-125)"
  else
    record "$id" FAIL "expected REFUSE+staff_role_violation+no-egress, got decision=$dec role_refusals=$code egress=$egress_n"
  fi
}

# Shared: drive a refund proposal on the OWNER session. Echoes the winning
# response; returns 1 (FLAKE) if the planner never proposes payment.refund.issue.
drive_refund() { # cookie amount_reais display_id
  drive_until "$1" "payment.refund.issue" \
    "reembolsa $2 reais do pedido $3" \
    "faz um estorno de $2 reais no pedido $3" \
    "devolve $2 reais pro cliente do pedido $3"
}

scn_refund_park() {
  local id="OPS-REFUND-PARK" owner_cookie seed disp pay resp dec refunded park_bal
  owner_cookie="$(mint_cookie "$WS9_OWNER_PHONE")"; clear_park "$OWNER_ID"
  seed="$(seed_order 100)"; disp="$(jq -r '.displayId' <<<"$seed")"; pay="$(jq -r '.paymentId' <<<"$seed")"
  [[ -z "$disp" || "$disp" == "null" ]] && { record "$id" FAIL "seed failed"; return; }

  resp="$(drive_refund "$owner_cookie" 50 "$disp")" || { record "$id" FLAKE "planner never proposed payment.refund.issue"; return; }
  dec="$(resp_decision "$resp")"
  if [[ "$dec" != "REQUEST_CONFIRMATION" ]]; then
    record "$id" FAIL "refund on the ops channel expected REQUEST_CONFIRMATION, got $dec"; return; fi
  # DB-stamped balance in the parked envelope (best-effort) must equal the payment row.
  park_bal="$(park_payload_json "$OWNER_ID" | jq -r '.refundableBalanceCentavos // empty' 2>/dev/null)"
  local db_bal; db_bal="$(q "select amount_in_centavos - refunded_amount_centavos from ibx_domain.payments where id = $(sql_lit "$pay")")"
  local stamp_note=""
  if [[ -n "$park_bal" ]]; then
    if [[ "$park_bal" == "$db_bal" ]]; then
      stamp_note="park stamped balance=$park_bal == DB"
    else
      record "$id" FAIL "park balance $park_bal != DB balance $db_bal (stamp mismatch)"; return
    fi
  else
    stamp_note="park-stamp read skipped (redis session shape)"
  fi
  # "não" clears the park; nothing is written.
  ops_chat "$owner_cookie" "não, deixa pra lá" >/dev/null 2>&1
  refunded="$(q "select refunded_amount_centavos from ibx_domain.payments where id = $(sql_lit "$pay")")"
  local still_parked; still_parked="$(park_payload_json "$OWNER_ID" | jq -r '.paymentId // empty' 2>/dev/null || true)"
  if [[ "${refunded:-0}" -eq 0 && -z "$still_parked" ]]; then
    record "$id" PASS "REQUEST_CONFIRMATION+park ($stamp_note); 'não' cleared it, refunded_amount=0 (SCN-120)"
  else
    record "$id" FAIL "after 'não': refunded_amount=$refunded, park cleared=$([[ -z "$still_parked" ]] && echo yes || echo no)"
  fi
}

scn_refund_confirm() {
  local id="OPS-REFUND-CONFIRM" owner_cookie seed disp pay resp dec resp2 refunded hist
  owner_cookie="$(mint_cookie "$WS9_OWNER_PHONE")"; clear_park "$OWNER_ID"
  seed="$(seed_order 100)"; disp="$(jq -r '.displayId' <<<"$seed")"; pay="$(jq -r '.paymentId' <<<"$seed")"
  local start; start="$(db_now)"

  resp="$(drive_refund "$owner_cookie" 50 "$disp")" || { record "$id" FLAKE "planner never proposed payment.refund.issue"; return; }
  dec="$(resp_decision "$resp")"
  [[ "$dec" != "REQUEST_CONFIRMATION" ]] && { record "$id" FAIL "expected REQUEST_CONFIRMATION before confirm, got $dec"; return; }

  resp2="$(ops_chat "$owner_cookie" "sim, confirma" 2>/dev/null)"
  dec="$(resp_decision "$resp2")"
  refunded="$(q "select refunded_amount_centavos from ibx_domain.payments where id = $(sql_lit "$pay")")"
  hist="$(q "select count(*) from ibx_domain.payment_status_history where payment_id = $(sql_lit "$pay") and to_status in ('refunded','partially_refunded')")"
  local exec_n; exec_n="$(audit_count "$start" "payment.refund.issue" "EXECUTE")"
  # Best-effort: the payment.status_changed subscriber auto-cancels the order.
  local subscriber; subscriber="$(audit_count "$start" "order.status.transition" "EXECUTE")"
  if [[ "$dec" == "EXECUTE" && "${refunded:-0}" -eq 5000 && "${hist:-0}" -ge 1 && "${exec_n:-0}" -ge 1 ]]; then
    record "$id" PASS "sim→EXECUTE: refunded_amount=5000, history row, refund audit EXECUTE; status_changed subscriber effects=$subscriber (SCN-120/OPS-054)"
  else
    record "$id" FAIL "confirm decision=$dec refunded=$refunded history=$hist auditEXEC=$exec_n (expected EXECUTE/5000/≥1/≥1)"
  fi
}

scn_refund_escalate() {
  local id="OPS-REFUND-ESCALATE" owner_cookie seed disp pay resp dec refunded parked
  owner_cookie="$(mint_cookie "$WS9_OWNER_PHONE")"; clear_park "$OWNER_ID"
  seed="$(seed_order 3000)"; disp="$(jq -r '.displayId' <<<"$seed")"; pay="$(jq -r '.paymentId' <<<"$seed")"
  local start; start="$(db_now)"
  resp="$(drive_refund "$owner_cookie" 1500 "$disp")" || { record "$id" FLAKE "planner never proposed payment.refund.issue"; return; }
  dec="$(resp_decision "$resp")"
  refunded="$(q "select refunded_amount_centavos from ibx_domain.payments where id = $(sql_lit "$pay")")"
  parked="$(park_payload_json "$OWNER_ID" | jq -r '.paymentId // empty' 2>/dev/null || true)"
  local esc_n; esc_n="$(audit_count "$start" "payment.refund.issue" "ESCALATE")"
  if [[ "$dec" == "ESCALATE" && "${refunded:-0}" -eq 0 && -z "$parked" && "${esc_n:-0}" -ge 1 ]]; then
    record "$id" PASS ">R\$1000 refund → ESCALATE, nothing parked, refunded_amount=0 (SCN-120 escalate band)"
  else
    record "$id" FAIL "expected ESCALATE/unwritten/unparked, got decision=$dec refunded=$refunded parked=$([[ -z "$parked" ]] && echo no || echo yes) esc=$esc_n"
  fi
}

scn_partial() {
  local id="OPS-PARTIAL" owner_cookie seed disp pay resp dec park_amt reply resp2 refunded
  owner_cookie="$(mint_cookie "$WS9_OWNER_PHONE")"; clear_park "$OWNER_ID"
  seed="$(seed_order 100)"; disp="$(jq -r '.displayId' <<<"$seed")"; pay="$(jq -r '.paymentId' <<<"$seed")"

  # The BKL-094 pin: a SPOKEN "10 reais" must thread to 1000 centavos, NOT the full balance.
  resp="$(drive_until "$owner_cookie" "payment.refund.issue" \
      "reembolsa 10 reais do pedido $disp" \
      "estorna 10 reais no pedido $disp" \
      "devolve 10 reais do pedido $disp")" || { record "$id" FLAKE "planner never proposed payment.refund.issue"; return; }
  dec="$(resp_decision "$resp")"; reply="$(resp_reply "$resp")"
  [[ "$dec" != "REQUEST_CONFIRMATION" ]] && { record "$id" FAIL "expected REQUEST_CONFIRMATION for a R\$10 ops refund, got $dec"; return; }
  # The prompt shows the parsed R$ 10,00 (not the full R$ 100,00 balance).
  if ! printf '%s' "$reply" | grep -q "10,00"; then
    record "$id" FAIL "confirm prompt did not show R\$ 10,00 (BKL-094): reply='${reply:0:120}'"; return; fi
  if printf '%s' "$reply" | grep -q "100,00"; then
    record "$id" FAIL "confirm prompt showed the FULL R\$ 100,00 balance — BKL-094 regression"; return; fi
  # The parked envelope carries the threaded 1000 centavos (the live pin).
  park_amt="$(park_payload_json "$OWNER_ID" | jq -r '.refundAmountCentavos // empty' 2>/dev/null)"
  if [[ -n "$park_amt" && "$park_amt" != "1000" ]]; then
    record "$id" FAIL "parked refundAmountCentavos=$park_amt (expected 1000) — BKL-094 regression"; return; fi
  # And "sim" writes exactly 1000.
  resp2="$(ops_chat "$owner_cookie" "sim, confirma" 2>/dev/null)"
  dec="$(resp_decision "$resp2")"
  refunded="$(q "select refunded_amount_centavos from ibx_domain.payments where id = $(sql_lit "$pay")")"
  if [[ "$dec" == "EXECUTE" && "${refunded:-0}" -eq 1000 ]]; then
    record "$id" PASS "'reembolsa 10 reais' → R\$ 10,00 parked (payload=${park_amt:-unread}) → sim EXECUTEs 1000 (BKL-094 live pin)"
  else
    record "$id" FAIL "confirm decision=$dec refunded=$refunded (expected EXECUTE/1000)"
  fi
}

# ── Preflight against the running stack ──────────────────────────────────────
preflight() {
  info "Preflight"
  local health
  health="$(curl -sS -m 10 "$IBX_API/health" 2>/dev/null || true)"
  [[ -z "$health" ]] && die "api not reachable at $IBX_API/health — bring the stack up first (see packages/journeys/src/live/README.md)"
  step "api up at $IBX_API"
  docker inspect "$WS9_REDIS_CONTAINER" >/dev/null 2>&1 || die "redis container $WS9_REDIS_CONTAINER not found"
  q "select 1" >/dev/null || die "cannot query Postgres via DATABASE_URL"
  step "Postgres + Redis reachable"
  ensure_attendant
  OWNER_ID="$(q "select id from ibx_domain.staff where phone = $(sql_lit "$WS9_OWNER_PHONE") and active")"
  [[ -z "$OWNER_ID" ]] && die "no active OWNER staff for $WS9_OWNER_PHONE (create with: ibx auth create-staff)"
  step "OWNER staffId $OWNER_ID; ATTENDANT ensured ($WS9_ATTENDANT_PHONE)"
}

main() {
  info "WS9 ops-plane live suite → $IBX_API  (retries=$WS9_RETRIES)"
  preflight
  info "Scenarios"
  scn_ops86
  scn_ops_role
  scn_refund_park
  scn_refund_confirm
  scn_refund_escalate
  scn_partial

  # ── Summary ────────────────────────────────────────────────────────────────
  local pass=0 fail=0 flake=0 skip=0 i
  for i in "${!R_ID[@]}"; do case "${R_STATUS[$i]}" in
    PASS) (( pass++ ));; FAIL) (( fail++ ));; FLAKE) (( flake++ ));; SKIP) (( skip++ ));;
  esac; done
  info "Summary: ${C_G}${pass} PASS${C_0}  ${C_R}${fail} FAIL${C_0}  ${C_Y}${flake} FLAKE  ${skip} SKIP${C_0}  (of ${#R_ID[@]})"

  local summary; summary="$(jq -nc \
    --arg api "$IBX_API" \
    --argjson pass "$pass" --argjson fail "$fail" --argjson flake "$flake" --argjson skip "$skip" \
    --argjson results "[${WS9_RESULT_JSON%,}]" \
    '{suite:"ws9-ops-live", api:$api, totals:{pass:$pass,fail:$fail,flake:$flake,skip:$skip}, scenarios:$results}')"
  printf '%s\n' "$summary"
  [[ -n "$WS9_JSON" ]] && printf '%s\n' "$summary" > "$WS9_JSON"

  (( fail == 0 )) || exit 1
}

main "$@"
