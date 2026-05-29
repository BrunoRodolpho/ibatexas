# Cutover Status — Operator Record

> Maps the 15 verification signals from the master plan PART IX onto 11
> ibatexas-side cutover IDs (`C-01..C-11`). Each row records current state,
> evidence command, and (if it fails) which upstream agent owns the bug.

**Snapshot date:** 2026-05-26 · **corrected 2026-05-28 (audit remediation cycle 3, D-CUTOVERSTATUS)**
**Branch:** `fix/audit-2026-05-27`
**Recovery tag:** `pre-claustrum-cutover` (local-only)
**Last cutover commit:** `4b6cb68` (Phase 6, IMPL-08)

> ⚠️ **CORRECTION (cycle 3):** the original record marked C-02/C-03/C-04 CLOSED;
> the audit found those evidence greps only matched strings in **never-invoked**
> code. The cutover is **INERT** — `bootstrapClaustrum()` has no caller, so the
> Conductor is never instantiated and the live commerce surface is still the
> legacy direct-write routes. C-02/C-03/C-04 are corrected to **PARTIAL** below.
> Cycle-3 advanced the prerequisites (5 first-party packs restored + building
> against the fixed kernel; the Adjudicator bridge is now audited), but the
> **activation** (real planner + full registry + ~3,671-LOC handler/route
> refactor + boot wiring + e2e) is the RC-A1 work, **deferred to cycle 4** per
> the all-or-nothing rule. See the remediation `RUN-LOG.md` + `RC-A1-cycle3-plan.md`.

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
- **State:** **PARTIAL** (corrected — audit 2026-05-27 D-CUTOVERSTATUS). The
  bootstrap module exists and *composes* a Conductor, and as of remediation
  cycle 3 the Adjudicator bridge is now AUDITED (`adjudicateAndAudit` + a live
  Postgres sink; commit `2fe46c7`). BUT `bootstrapClaustrum()` has **no caller**
  in `server.ts`/`index.ts`, so `getConductor()` throws "not initialized" — the
  Conductor is never instantiated at runtime. Composing ≠ wired-at-boot.
- **Evidence (strengthened — must assert a CALLER, not just that the symbol
  exists in never-invoked code):**
  ```bash
  cd /Users/thaisrodolpho/projects/ibatexas
  # composition exists:
  grep -q "createConductor" apps/api/src/claustrum-bootstrap.ts
  # activation gate (currently FAILS by design — cutover deferred to cycle 4):
  grep -rq "bootstrapClaustrum()" apps/api/src/server.ts apps/api/src/index.ts \
    && echo "WIRED" || echo "INERT (expected until RC-A1 activation)"
  ```
- **Blamed agent if fail:** `ibatexas-cutover-builder`

---

## C-03 — Three routes delegate to Conductor

- **Maps to:** PART IX (no direct signal; supports §7 and §8)
- **State:** **PARTIAL** (corrected — D-CUTOVERSTATUS). The three routes do call
  `getConductor()`/`handleTurn`, but `getConductor()` throws because the
  bootstrap is uncalled (C-02) — so today these routes 500 rather than delegate.
  The delegation code is present but inert; the live commerce surface is still
  the legacy direct-write routes. Promotes to CLOSED only once C-02 is wired.
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
- **State:** **PARTIAL** (corrected — D-CUTOVERSTATUS). Only 3 representative
  tools are wrapped in `register-ibatexas-tool-packs.ts`, AND that function has
  no caller + the bootstrap is uncalled, so the live ToolRegistry is empty.
  **Cycle-3 advance:** the 5 first-party PolicyBundle/CapabilityPlanner packs
  (`@ibatexas/pack-{orders,payments,reservations,customer-onboarding,whatsapp}`)
  were restored from history and now BUILD against the fixed kernel (commit
  `9f0e5f8`) — the authored policies for the full capability surface exist again.
  Activation (real planner emitting envelopes + full registry + handler/route
  refactor) is the deferred RC-A1 work → cycle 4.
- **Note:** Full roster + activation is the RC-A1 cutover blocker, deferred to
  cycle 4 (see CUTOVER-STATUS-CYCLE3 note below + the remediation RUN-LOG).
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
| C-02 Bootstrap composes | PARTIAL — composes + bridge audited (cycle 3); bootstrap uncalled | ibatexas-cutover-builder |
| C-03 Routes delegate | PARTIAL — delegation code present but getConductor() throws (inert) | ibatexas-cutover-builder |
| C-04 Tool packs registered | PARTIAL — packs restored + build (cycle 3); registry not live (uncalled) | ibatexas-cutover-builder |
| C-05 Typecheck clean (claustrum-side) | CLOSED | ibatexas-cutover-builder |
| C-06 `ibx dev` boots | PENDING | ibatexas-cutover-builder |
| C-07 E2E Twilio turn → AuditRecord | PENDING (blocked on RC-A1 activation → cycle 4) | multiple (see row) |
| C-08 llm-provider deleted | DEFERRED | user |
| C-09 Glue files deleted | DEFERRED | user |
| C-10 claustrum repo + npm publish | DEFERRED | user |
| C-11 Branch pushed | DEFERRED | user |

**Cutover green-light condition:** C-06 AND C-07 are CLOSED → user may
proceed with C-08 / C-09 deletion commits → C-11 push.
