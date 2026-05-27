# Cutover Status — Operator Record

> Maps the 15 verification signals from the master plan PART IX onto 11
> ibatexas-side cutover IDs (`C-01..C-11`). Each row records current state,
> evidence command, and (if it fails) which upstream agent owns the bug.

**Snapshot date:** 2026-05-26
**Branch:** `feat/claustrum-cutover` (NOT pushed)
**Recovery tag:** `pre-claustrum-cutover` (local-only)
**Last cutover commit:** `4b6cb68` (Phase 6, IMPL-08)

---

## Legend

- **CLOSED** — done. Phase 1-6 work is on disk and verified locally.
- **PENDING** — implementation done; awaiting real-world signal (typically
  a live Twilio smoke turn) before promoting to CLOSED.
- **DEFERRED** — friction item the user (not Claude) owns. Listed for
  visibility; not a blocker for the local cutover.

---

## C-01 — Recovery tag exists

- **Maps to:** PART IX §12 (`git tag --list pre-claustrum-cutover` non-empty)
- **State:** **CLOSED**
- **Evidence:**
  ```bash
  cd /Users/thaisrodolpho/projects/ibatexas
  git tag --list pre-claustrum-cutover
  # expected: pre-claustrum-cutover
  ```
- **Blamed agent if fail:** `ibatexas-cutover-builder` (Phase 6 prerequisite)

---

## C-02 — Claustrum bootstrap exists and composes Conductor

- **Maps to:** PART IX §6 (`@claustrum/core` listed as dep + bootstrap wires it)
- **State:** **CLOSED**
- **Evidence:**
  ```bash
  cd /Users/thaisrodolpho/projects/ibatexas
  test -f apps/api/src/claustrum-bootstrap.ts && \
    grep -q "createConductor" apps/api/src/claustrum-bootstrap.ts && \
    cat apps/api/package.json | jq '.dependencies."@claustrum/core"'
  # expected: file exists, createConductor referenced, dep is "workspace:*"
  ```
- **Blamed agent if fail:** `ibatexas-cutover-builder`

---

## C-03 — Three routes delegate to Conductor

- **Maps to:** PART IX (no direct signal; supports §7 and §8)
- **State:** **CLOSED**
- **Files:**
  - `apps/api/src/routes/chat.ts` (POST flow opens capsule + handleTurn)
  - `apps/api/src/routes/whatsapp-webhook.ts` (delegates after Twilio guards)
  - `apps/api/src/routes/__shared__/customer-intent-gateway.ts` (envelope
    narrowing + Decision switch)
- **Evidence:**
  ```bash
  grep -l "conductor\." apps/api/src/routes/chat.ts \
    apps/api/src/routes/whatsapp-webhook.ts \
    apps/api/src/routes/__shared__/customer-intent-gateway.ts
  # expected: all 3 files listed
  ```
- **Blamed agent if fail:** `ibatexas-cutover-builder`

---

## C-04 — First-pass tool packs registered

- **Maps to:** Gate E acceptance (≥1 tool registered in claustrum's
  ToolRegistry from ibatexas's bootstrap)
- **State:** **CLOSED** (3 representative tools: cart.addItem, cart.checkout,
  order.cancel)
- **Note:** Full 25-tool roster is incremental, not a cutover blocker.
- **Evidence:**
  ```bash
  grep -c "makeTool" apps/api/src/tools/register-ibatexas-tool-packs.ts
  # expected: 3 or higher (will grow as tools are added)
  ```
- **Blamed agent if fail:** `ibatexas-cutover-builder`

---

## C-05 — Typecheck has zero claustrum-related errors

- **Maps to:** Phase 6 acceptance from IMPL-08
- **State:** **CLOSED**
- **Note:** 27 pre-existing errors remain in `apps/api/` related to
  `OrderCommandService.transitionStatus` and `PaymentCommandService.create`
  — these predate the branch and are unrelated to the cutover.
- **Evidence:**
  ```bash
  cd /Users/thaisrodolpho/projects/ibatexas
  pnpm --filter @ibatexas/api typecheck 2>&1 | grep -c "claustrum\|@claustrum"
  # expected: 0
  ```
- **Blamed agent if fail:** `ibatexas-cutover-builder` (claustrum-related
  errors) or pre-existing technical debt (the 27 baseline errors)

---

## C-06 — `ibx dev` boots without errors

- **Maps to:** PART IX §7 (`cd ibatexas && timeout 30 ibx dev; echo $?` = 0)
- **State:** **PENDING** (needs a clean boot in a fresh env once
  pnpm-workspace.yaml's `../claustrum/packages/*` entries resolve to actual
  package symlinks — depends on claustrum repo being checked out locally
  alongside ibatexas).
- **Evidence:**
  ```bash
  cd /Users/thaisrodolpho/projects/ibatexas
  timeout 30 ibx dev
  echo $?
  # expected: 0 (no boot errors); ibx exits cleanly on timeout
  ```
- **Blamed agent if fail:** `ibatexas-cutover-builder` (boot wiring) or
  `repo-skeleton-builder` (if claustrum package metadata is malformed)

---

## C-07 — End-to-end WhatsApp turn produces full audit chain

- **Maps to:** PART IX §8 (envelope → Decision → mutation → AuditRecord →
  Twilio reply)
- **State:** **PENDING** (requires live Twilio smoke test; the user owns
  this step before any deletion happens)
- **Evidence:**
  ```bash
  # Drive a real Twilio inbound webhook, then:
  psql $DATABASE_URL -c "SELECT envelope_id, decision_kind, capability \
                          FROM intent_audit \
                          ORDER BY ts DESC LIMIT 1;"
  # expected: 1 new row with decision_kind=EXECUTE, capability=cart.addItem (or similar)
  # ALSO expected: the Twilio reply was delivered to the test number
  ```
- **Blamed agent if fail:** `ibatexas-cutover-builder` (if envelope is
  malformed); `channel-adapters-builder` (if WhatsApp channel doesn't park
  or render); `core-spine-builder` (if `handleTurn` skips adjudicate);
  `memory-adapter-builder` (if `intent_audit` write path is broken)

---

## C-08 — `@ibatexas/llm-provider` deletion (post-smoke)

- **Maps to:** PART IX §4 (find returns empty) and §5 (grep returns empty)
- **State:** **DEFERRED** (user-owned — execute only after C-07 is CLOSED)
- **Recipe:**
  ```bash
  cd /Users/thaisrodolpho/projects/ibatexas
  rm -rf packages/llm-provider/
  # Remove @ibatexas/llm-provider dep from apps/api/package.json
  pnpm install
  pnpm --filter @ibatexas/api typecheck
  git add -A && git commit -m "chore: delete @ibatexas/llm-provider package"
  ```
- **Blamed agent if fail:** N/A (mechanical removal; if typecheck breaks,
  it means a non-route file still imports from `@ibatexas/llm-provider` and
  must be migrated to `@claustrum/*`)

---

## C-09 — Sibling glue files deleted (post-smoke)

- **Maps to:** Phase 6 IMPL-08 deferred deletion list
- **State:** **DEFERRED** (user-owned). Files:
  - `apps/api/src/plugins/kernel-bootstrap.ts` (already absent on main)
  - `apps/api/src/plugins/kernel-metrics-sink.ts` (already absent on main)
  - `apps/api/src/whatsapp/{session,client}.ts`
  - `packages/domain/src/services/__shared__/with-adjudicate.ts`
  - `apps/api/src/subscribers/__shared__/system-actor-envelope.ts`
- **Blamed agent if fail:** N/A (mechanical)

---

## C-10 — claustrum repo created on GitHub and pushed

- **Maps to:** PART IX §1 (`npm view @claustrum/core` returns published
  package) and §2 (CI green on `BrunoRodolpho/claustrum` main)
- **State:** **DEFERRED** (user-owned: `gh repo create BrunoRodolpho/claustrum`,
  `git push -u origin main`, `npm publish` from `@claustrum/eslint-config`
  outward to grab the scope)
- **Blamed agent if fail:** `repo-skeleton-builder` (if scaffolding's wrong);
  otherwise user friction

---

## C-11 — `feat/claustrum-cutover` branch pushed

- **Maps to:** None directly; precondition for opening a PR
- **State:** **DEFERRED** (user explicitly asked the branch NOT be pushed
  until smoke and review are done)
- **Evidence:**
  ```bash
  cd /Users/thaisrodolpho/projects/ibatexas
  git rev-parse --abbrev-ref HEAD                       # feat/claustrum-cutover
  git rev-parse --abbrev-ref --symbolic-full-name @{u}  # should error: no upstream yet
  ```
- **Blamed agent if fail:** N/A — explicit user choice

---

## Summary table

| ID | State | Owner |
|---|---|---|
| C-01 Recovery tag | CLOSED | ibatexas-cutover-builder |
| C-02 Bootstrap composes | CLOSED | ibatexas-cutover-builder |
| C-03 Routes delegate | CLOSED | ibatexas-cutover-builder |
| C-04 Tool packs registered | CLOSED | ibatexas-cutover-builder |
| C-05 Typecheck clean (claustrum-side) | CLOSED | ibatexas-cutover-builder |
| C-06 `ibx dev` boots | PENDING | ibatexas-cutover-builder |
| C-07 E2E Twilio turn → AuditRecord | PENDING | multiple (see row) |
| C-08 llm-provider deleted | DEFERRED | user |
| C-09 Glue files deleted | DEFERRED | user |
| C-10 claustrum repo + npm publish | DEFERRED | user |
| C-11 Branch pushed | DEFERRED | user |

**Cutover green-light condition:** C-06 AND C-07 are CLOSED → user may
proceed with C-08 / C-09 deletion commits → C-11 push.
