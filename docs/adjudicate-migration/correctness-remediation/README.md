# `correctness-remediation/` — Waves 6-9 pre-cutover correctness work

## What's in this directory

Closure artefacts for Waves 6, 7, and 9 of correctness-remediation — the
arc that followed the deep-audit "NO-GO" verdict and culminated in the
IBX-IGE v3.0 always-on cutover (`f3bea43`). The directory holds:

- 4 Wave-6 verifier reports (red-team, operational drill, integration E2E, governance coverage)
- 1 W6→W7 final synthesis (`FINAL-SYNTHESIS.md`)
- 4 Wave-7 closure docs (synthesis + 3 decision logs)
- 1 Wave-7 independent verifier report
- 1 Wave-9 backlog (cart-store medusa egress — now closed)
- 4 supporting subdirectories: `evidence/` (per-fix before/after diffs),
  `reproductions/` (single repro test), `w7-evidence/`, `wave7-verifier-evidence/`

All findings here have been worked through. The "tier 1/3/4 rollout"
framework these documents assume was deleted by the cutover; per
`CLAUDE.md` rule #9 the kernel is now always authoritative.

## Classification

| File | Classification | One-line summary |
|---|---|---|
| `FINAL-SYNTHESIS.md` | Historical preserved | Master W6 synthesis: "CONDITIONAL GO" for Tier 1, "NO-GO" for Tier 3+4. Tier rollout no longer exists. |
| `W7-SYNTHESIS.md` | Historical preserved | Master W7 closure: all 4 pre-merge gates closed; 5 NEW findings (NEW-W7-V1..V5) handed to Wave 8. |
| `W7-DECISIONS.md` | Historical preserved | Index of three discretionary W7 calls (D1 P2 deferral, D2 CLI two-person rule, D3 OWNER role). |
| `W7-DECISIONS-admin.md` | Historical preserved | Full rationale for W7-D1 — `DEFERRED_ADMIN_LOW_RISK` allowlist for 10 admin scheduler/tables/zones sites. |
| `W7-DECISIONS-ops.md` | Historical preserved | Full rationale for W7-D2 (CLI as solo-emergency surface) and W7-D3 (OWNER role for kill-switch) — the kill-switch CLI was deleted by the cutover. |
| `wave6-governance-coverage.md` | Historical preserved | W6 exhaustive mutation-surface scan; ~65% adjudication coverage finding drove the W7-W9 closure work. |
| `wave6-operational-drill.md` | Historical preserved | W6 on-call drills against the (now-deleted) `SHADOW-ENFORCE-ROLLOUT.md` runbook + kill-switch CLI. |
| `wave6-red-team.md` | Historical preserved | W6 adversarial review — 17/21 fixes held; the 2 exploitable findings (whitespace customerId, template-literal bypass) closed in W7. |
| `wave6-replay-integration.md` | Historical preserved | W6 integration E2E — 7/7 paths, 94/94 assertions PASS against real Docker Redis. |
| `wave7-verifier-report.md` | Historical preserved | Independent W7 verifier — surfaced 5 NEW findings (V1-V5) for Wave 8 input. |
| `WAVE9-CART-EGRESS-BACKLOG.md` | Historical preserved (Wave 9 now closed) | The "backlog" title is stale — Wave 9 was completed: `medusaStoreAdjudicated` is implemented in `packages/tools/src/medusa/store-adjudicated.ts` and adopted by all 6 cart tool files (`add-to-cart`, `apply-coupon`, `create-checkout`, `get-or-create-cart`, `remove-from-cart`, `update-cart`). |
| `evidence/` (directory) | Historical preserved | 30+ before/after evidence text files per-P0/P1 fix from W1+W3. Forensic record only. |
| `reproductions/` (directory) | Historical preserved | Single P0-7 framework-bug reproduction test (now closed). |
| `w7-evidence/` (directory) | Historical preserved | Per-W7-finding before/after text dumps. |
| `wave7-verifier-evidence/` (directory) | Historical preserved | W7-Verifier evidence dump. |

## Notes on closed-but-named-as-backlog work

`WAVE9-CART-EGRESS-BACKLOG.md` was authored when the cart-store egress
wrapper (`medusaStoreAdjudicated`) was a future task. The wrapper is now
live at `packages/tools/src/medusa/store-adjudicated.ts` (719 lines, 27
test cases) and all 6 cart tools in `packages/tools/src/cart/` consume
it. Treat the doc as historical record of why that wrapper was needed,
not as an open backlog.

## Current-state pointers

- **Closeout status (authoritative as of 2026-05-24):** [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md)
- **Constitutional rule:** `CLAUDE.md` rule #9 — "LLM Authority — IBX Intent-Gated Execution v3.0"
- **Always-on cutover commit:** `f3bea43` (deleted the tier-rollout / kill-switch / shadow-enforce framework)
- **Successor `medusaStoreAdjudicated` wrapper:** `packages/tools/src/medusa/store-adjudicated.ts` (closes WAVE9-CART-EGRESS-BACKLOG)
- **Civilization-health meta-review:** [`../CIVILIZATION-HEALTH-2026-05-24.md`](../CIVILIZATION-HEALTH-2026-05-24.md)
