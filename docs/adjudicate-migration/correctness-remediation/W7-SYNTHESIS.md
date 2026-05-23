# Correctness Remediation — Wave 7 Synthesis

**Date:** 2026-05-23 (post-Wave 7 closure)
**Branch:** `feat/correctness-w7-close-w6-findings` — 14 W7 closure commits + 1 verifier-report commit on top of W6 baseline `94964f0`
**Verifier:** Independent adversarial agent (W7-Verifier), report at `docs/adjudicate-migration/correctness-remediation/wave7-verifier-report.md`

This document closes the Wave 7 cycle that targeted the 4 pre-merge gates (G1–G4), 6 governance bypass categories (P1–P6), and 5 operational findings (O1–O5) surfaced by the Wave 6 verifier sweep. Read alongside `FINAL-SYNTHESIS.md` (W6 baseline) and `wave7-verifier-report.md` (independent re-test of every claimed closure).

---

## TL;DR

W7 closed the W6 pre-merge gates cleanly — **G1, G2, G3, G4 all PASS** under adversarial re-test, including the Wave 6 red-team's whitespace-customerId and template-literal-bypass exploits flipping from passing-as-EXPLOIT to failing-as-CLOSED. Tier 1 shadow rollout is unblocked.

Of the 6 governance findings: **P1, P3, P4 PASS clean.** **P2 PASS by deferral** (path (b) — `DEFERRED_ADMIN_LOW_RISK` allowlist, justified in W7-DECISIONS-admin). **P5 and P6 are PARTIAL.** A coordination seam between W7-Stripe-Wrapper (P5) and W7-Govern-Order (P6) left three LLM-callable cart tools (`cancel-order`, `amend-order`, `check-order-status`) instantiating `createOrderService` without the `adminAdjudicated` option — they silently hit the legacy bare-`fetchAdmin` fallback and **bypass kernel adjudication for medusa egress today**. Plus one residual bare `stripe.paymentIntents.update(...)` survives in `apps/api/src/routes/stripe-webhook.ts:308`.

All 5 operational findings (O1–O5) PASS.

**The W7-Verifier surfaced 5 NEW findings** for Wave 8 input (NEW-W7-V1 through V5), of which V1 is a P0 blocker for Tier 3 shadow and V3/V4 compound to block Tier 4 enforce.

**Tier verdicts (verifier-authoritative):**
- 🟢 **Tier 1 shadow: GREEN** — pre-merge gates closed.
- 🟡 **Tier 3 shadow: YELLOW** — NEW-W7-V1 (cart-tool hand-off seam, P0) blocks; close before real customer traffic.
- 🔴 **Tier 4 enforce: RED** — NEW-W7-V1 + NEW-W7-V4 (no CI scan for `packages/tools/src/cart/` medusa bypasses) + NEW-W7-V3 (G3 hoist incomplete — only `actorPrincipal`, not `version/nonce/taint`) compound.

**Recommended next step:** spawn a small Wave 8 to close NEW-W7-V1 (P0) and NEW-W7-V2 (P1) — both are well-scoped, ~1 day of work. Trade-off detailed in §"Recommended next step".

---

## Wave-by-wave ledger (updated through W7)

| Wave | Theme | Verdict |
|---|---|---|
| Deep audit | 14 P0 findings cataloged | Baseline |
| W1 | Reproduction-and-fix (19 P0/P1 closures, 4 clusters) | Substantially closed deep-audit P0s |
| W3 | Operational reality (4 agents + Medusa migration) | 11 ghost metrics real; 13 deferred Medusa bypasses migrated; CLI + admin endpoint live |
| W6 | Adversarial verification (5 verifiers, ~3,500 lines findings, 17 red-team tests) | 2 new exploitable bypasses + 6 new P0 bypass categories surfaced; `verifyParkedEnvelopeHash` inert |
| **W7** | **Close W6 findings (6 agents, 14 commits, 1 verifier)** | **All 4 pre-merge gates PASS; 3 of 6 governance closures PASS clean; 2 PARTIAL with hand-off gap; all 5 ops PASS; verifier surfaces 5 NEW** |

### W7 per-finding ledger

| ID | Scope | Owner agent | Commit (actual content) | Verifier verdict | Notes |
|---|---|---|---|---|---|
| G1 | whitespace customerId trim | W7-Gates | `b9575bc` | PASS | W6 red-team `01-customerid-whitespace-bypass.test.ts` EXPLOIT cases flip to failing; `05-whitespace-rejected.test.ts` (8/8) pins behaviour |
| G2 | backtick widening in bypass-detection regex | W7-Gates | `497e7c7` (msg says P6) | PASS | 31/31 bypass-detection tests pass; 4 documented residuals tracked as NEW-W7-V5 |
| G3 | hoist `actorPrincipal` in NX-park adapter | W7-Gates | `e1e1e10` | PASS (with sub-gap) | Tamper-at-rest detection now live; **but** only `actorPrincipal` is hoisted — see NEW-W7-V3 |
| G4 | `kernel_audit_sink_spill_size` canonical metric | W7-Gates | `d922671` | PASS | Programmatic allowlist; sed-edit of alert.yaml correctly fails build |
| P1 | reservation tool layer | W7-Govern-Customer | `8cc3fb3` | PASS | 3 of 4 sites use `*FromEnvelope`; `join-waitlist` documented-blocked on missing `joinWaitlistFromEnvelope` service method (sub-finding) |
| P2 | admin scheduler/tables/zones | W7-Govern-Admin | `dbf077e` | PASS (by deferral) | Path (b) — `DEFERRED_ADMIN_LOW_RISK` allowlist with 10 sites (W6 undercounted by 4); see W7-D1 |
| P3 | customer onboarding upserts | W7-Govern-Customer | `1efa47a` / `4924228` / `b5ab090` (3 commits all labeled P3 due to index race; one re-applied, two are mislabeled — actual content varies) | PASS | `auth.ts:430` + `whatsapp/session.ts:177` wrap via `createFromEnvelope`; 78 tests pass |
| P4 | `prisma.orderNote.create` x4 | W7-Govern-Order | `77cef72` | PASS | 0 production `prisma.orderNote.create` calls left; all 4 sites route through `order.note.add` |
| P5 | `stripeAdjudicated` + 6 cart migrations | W7-Stripe-Wrapper | `508b979` (msg says O4) | PARTIAL | 6 `packages/tools/src/cart/` sites migrated; wrapper sound; **but** bare `stripe.paymentIntents.update()` survives in `stripe-webhook.ts:308` (NEW-W7-V2) |
| P6 | `fetchAdmin` order.service | W7-Govern-Order | `508b979` (bundled with O4 + P5) | PARTIAL | 6 sites in order.service.ts route through `medusaAdjudicated` when `adminAdjudicated` is injected; stripe-webhook wires it; **but** 3 cart-tool callers don't inject it — silent fallback at `order.service.ts:133-139` (NEW-W7-V1) |
| O1 | `ibx kernel defer resume <sessionId>` CLI | W7-Ops | `bda5973` | PASS | 5 unit tests pass; G3 dependency wired; runbook reference added |
| O2 | `pnpm migrate` phantom command | W7-Ops | `b5ab090` (msg says P3) | PASS | Replaced with executable `for f in ../adjudicate/packages/audit-postgres/migrations/*.sql; do psql $DATABASE_URL -v ON_ERROR_STOP=1 -f "$f"; done` |
| O3 | CLI vs admin two-person rule | W7-Ops | `5cfbede` | PASS | Path (b) — `--yes-i-am-solo-on-call` flag + TTY guardrail + Sentry breadcrumb; runbook line added; see W7-D2 |
| O4 | MANAGER vs OWNER role | W7-Ops | `508b979` (bundled with P5+P6) | PASS | Route at `apps/api/src/routes/admin/kernel.ts:183,290` uses `requireOwnerRole`; 10 tests pass; strategy doc aligned; see W7-D3 |
| O5 | runbook Redis-key references | W7-Ops | `9fbd335` | PASS | `ibatexas:foo` literals replaced with `<APP_ENV>:foo` placeholders + `rk()` helper citation; docs-only commit per RULE G |

**Counts:** PASS = 9 / 11 governance+ops findings + 4/4 gates. PARTIAL = 2 / 11 (P5, P6). FAIL = 0.

---

## NEW findings from Wave 7 verifier

The W7-Verifier ran independent adversarial re-tests against every closure, plus three structural probes (unicode whitespace, escaped backticks, field-omission against G3), plus a forensic table of the commit-message scramble. Output: 5 NEW findings carried into the Wave 8 backlog.

### NEW-W7-V1 — **P0**: cart tools (`cancel_order`, `amend_order`, `check_order_status`) bypass kernel for medusa egress

**Category:** correctness / governance
**Layer:** tool layer hand-off (P5 ↔ P6 coordination seam)
**Severity:** P0 — LLM-callable surface, financial-state-adjacent

**Reproduction:**

```
grep -n "createOrderService(medusaAdmin)" packages/tools/src/cart/
```

Three callers:
- `packages/tools/src/cart/cancel-order.ts:34`
- `packages/tools/src/cart/amend-order.ts:187`
- `packages/tools/src/cart/check-order-status.ts:18`

All three instantiate `createOrderService(medusaAdmin)` **without** the `adminAdjudicated` option. The `order.service.ts` `mutate()` helper (line 116) silently falls back to bare `fetchAdmin` (line 133-139) when `adminAdjudicated` is undefined.

`cancel-order.ts` calls `svc.cancelOrder(...)` → `mutate({ path: '/admin/orders/<id>/cancel', method: 'POST' })`. The kernel is NOT consulted; no `order.cancel` audit record emitted; the policy bundle is not adjudicated. `amend-order.ts` calls `svc.cancelItem(...)` and follow-up edits via `mutate({ method: 'POST' })` calls — all hit the fallback.

**Why W7 didn't close this:** W7-Govern-Order (P6) explicitly punted to W7-Stripe-Wrapper in `w7-evidence/P6-after.txt:127-131`: _"The remaining createOrderService callers in packages/tools/src/cart/ (cancel-order.ts, amend-order.ts, check-order-status.ts) are W7-Stripe-Wrapper's scope and are NOT migrated by this agent."_ W7-Stripe-Wrapper (P5) closed the bare-`stripe.*` calls but did NOT pick up the `createOrderService` injection wiring (its file pertains to medusa-egress, not Stripe-egress). **No agent owned this seam.** It is a coordination failure, not an implementation failure.

**Suggested fix:** in `packages/tools/src/cart/_shared.ts` (or similar) create a shared `createTooledOrderService()` that wires `adminAdjudicated` from the cart tool layer's `medusaAdjudicated` shim, and migrate the three callers. Then turn the silent fallback at `order.service.ts:133-139` into a hard `throw new Error(...)` so future regressions fail loud.

**Tier impact:** **Tier 3 (LLM-callable) cannot flip to shadow with real customer traffic until this closes.** Tier 1 intents are unaffected because they do not exercise the cart-tool `order.service` caller paths.

### NEW-W7-V2 — **P1**: bare `stripe.paymentIntents.update(...)` in stripe-webhook

**Category:** correctness / governance
**Layer:** api/routes
**Severity:** P1 (webhook is post-auth and idempotency-guarded, but still a real PSP-state mutation)

**Reproduction:**

```
grep -n "stripe\.paymentIntents\.\(update\|create\|confirm\|cancel\)" apps/api/src/routes/
```

One survivor: `apps/api/src/routes/stripe-webhook.ts:308`:

```ts
const stripe = getStripe();
await stripe.paymentIntents.update(paymentIntent.id, {
  metadata: { ...paymentIntent.metadata, medusaOrderId: orderId },
});
```

Metadata-write only (not amount/state), but it bypasses the `stripeAdjudicated.paymentIntents.update(...)` wrapper that W7-P5 introduced. **Note:** the `getStripe()` factory in this route file is unrelated to the `getStripe()` in `packages/tools/src/cart/_stripe-helpers.ts` — both files define a private factory.

**Why W7 didn't close this:** W7-P5's scope was explicitly `packages/tools/src/cart/` per the W6 synthesis text. The webhook route lives outside that scope.

**Suggested fix:** route through `stripeAdjudicated.paymentIntents.update(...)` with the webhook-event context as `sourceSubject` and an idempotency key keyed on `event.id:metadata-update:<piId>`. Single-line change. Bypass-detection scan should be widened to cover this file (currently scanned for medusa egress only).

### NEW-W7-V3 — **P2**: G3 hoist covers only `actorPrincipal`, not `version/nonce/taint`

**Category:** correctness (hardening)
**Layer:** `apps/api/src/adapters`
**Severity:** P2 (no current production caller trips it; structural gap only — but upgrade to P1 if Tier 4 enforces LGPD-anonymize or refund-issue)

**Reproduction:** `docs/adjudicate-migration/correctness-remediation/wave7-verifier-evidence/probe-g3-fields-missing.test.ts`. Park a blob via `parkDeferredIntentWithNxGuard()` with envelope omitting `version/nonce/taint` at the top level (only `actor.principal` nested). Read back the raw Redis blob and run `verifyParkedEnvelopeHash(parked)` — returns `{verified: null, reason: "missing_fields"}`. Tamper-at-rest detection silently disabled for that blob.

**Why W7 didn't close this fully:** the W7-G3 hoist in `apps/api/src/adapters/park-deferred-intent-nx.ts:175-195` defensively re-derives `actorPrincipal` from `actor.principal`. Inline comment (lines 173-174) explicitly notes that the other three fields have no canonical fallback. Current production callers (`me.ts`, `kernel-executor.ts`, `llm-responder.ts`) do all pass the fields — but a future contributor adding a new caller can miss the contract, and the failure mode is silent.

**Suggested fix:** make the adapter REFUSE-with-error if `version/nonce/taint` are missing at the top level (fail-loud). Silent degradation of tamper detection is exactly what G3 was meant to fix.

### NEW-W7-V4 — **P2**: bypass-detection scan dirs do not cover `packages/tools/src/cart/` for medusa egress

**Category:** governance regression-prevention
**Layer:** test infra
**Severity:** P2

`MEDUSA_SCAN_DIRS` at `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts:72` is:

```
["apps/api/src/routes", "apps/api/src/jobs", "apps/api/src/subscribers"]
```

It does NOT include `packages/tools/src/` or `packages/domain/src/`. The W6 synthesis explicitly called this out as the reason the W5 stripe-webhook bypass slipped past; W7-P4 fixed the orderNote sites and W7-P5 fixed the cart Stripe sites, but **neither widened the scan dirs to detect regressions on these surfaces.** A future contributor reintroducing a bare `stripe.*` call in `packages/tools/src/cart/` will NOT be flagged by CI.

This is **regression-prevention**, not active-correctness — but it is the structural reason the W5 bypass and the W7 P5↔P6 hand-off gap were both invisible to CI.

**Suggested fix:** widen `MEDUSA_SCAN_DIRS` to include `packages/tools/src/` with `packages/tools/src/medusa/adjudicated.ts` in `ALLOWED_MEDUSA_DIRECT`. Mirror for any analogous Stripe scan. ~30 min work.

### NEW-W7-V5 — **P2**: Unicode-quote / string-concat / variable-bound options still evade bypass-detection regex

**Category:** governance regression-prevention
**Layer:** test infra
**Severity:** P2 (documented Q2 backlog)

W7-G2's backtick widening closed the specific Wave 6 finding. The W7-Verifier's adversarial probe (`probe-g2-template-eval.test.ts`) confirms the regex still misses:
- Unicode quotes `"POST"` (U+201C / U+201D)
- String concatenation `method: "PO" + "ST"`
- Backtick with interpolation `` `PO${"ST"}` ``
- Variable-bound options (`const opts = { method: "POST" }; medusaStore(url, opts)`)

The last two are documented in source comments at `bypass-detection.test.ts:163-166`. Q2 backlog item is "move to AST-based scanning (typescript-eslint custom rule)." Not blocking Tier 1; should be tracked.

---

## Production-readiness verdict (per tier)

### 🟢 Tier 1 shadow rollout: GREEN

All four W6 pre-merge gates that blocked Tier 1 are closed. The Wave 6 red-team's EXPLOIT cases flip for G1 and G2 (passing → failing as designed); G3 enables previously-inert tamper-at-rest detection; G4 makes the spill metric canonical across sink/dashboard/alert/validation-test. The G3 partial gap on non-`actorPrincipal` fields (NEW-W7-V3) is structural-only — current production callers populate all four fields. Tier 1 intents (`reservation.create`, `order.note.add`, `customer.preferences.update`, `whatsapp.message.send` system) do not exercise the cart-tool order.service caller paths that NEW-W7-V1 implicates.

**Blockers: none. Ship Tier 1 shadow.**

### 🟡 Tier 3 shadow rollout: YELLOW

**One P0 blocker:** NEW-W7-V1. The LLM-callable `cancel_order` and `amend_order` cart tools silently bypass kernel adjudication for medusa egress today, because three callers instantiate `createOrderService(medusaAdmin)` without the `adminAdjudicated` option and hit the legacy fallback. P5 closed the Stripe-egress side of the cart tools cleanly; P6 closed the order-service mutate-helper side cleanly; **but the wiring between them was orphaned by the agent-handoff.**

**One P1 follow-on:** NEW-W7-V2. The stripe-webhook metadata-update bypass is a small post-auth idempotent-guarded mutation, but it does bypass the stripeAdjudicated wrapper. Should close alongside V1.

**Blockers: NEW-W7-V1 (P0) before any Tier 3 intent flips to shadow with real customer traffic. NEW-W7-V2 (P1) before any Tier 3 financial-state intent flips to enforce.**

### 🔴 Tier 4 enforce: RED

Two compounding reasons:

1. **NEW-W7-V1** is even more severe for Tier 4 (refund-issue, LGPD-anonymize) than for Tier 3 — these are precisely the highest-blast intents where silent kernel-bypass is unacceptable.
2. **NEW-W7-V4** — the bypass-detection scanner is gate-blind to `packages/tools/src/cart/` for medusa egress. A future Tier-4 regression in those dirs would not surface in CI. The W5 stripe-webhook bypass that slipped past was exactly this class of gap; we did not widen the gate.
3. **NEW-W7-V3** — the G3 hoist incompleteness means tamper-at-rest detection is only as strong as the human-discipline contract that all callers populate `version/nonce/taint`. For LGPD-anonymize and refund-issue, silent degradation of tamper detection is unacceptable. Upgrade NEW-W7-V3 from P2 to P1 in the Tier-4 enforce context.

**Blockers: NEW-W7-V1, NEW-W7-V3 (upgraded for Tier 4), NEW-W7-V4. Plus the W6-baseline blockers that haven't moved (NATS auth deployment, Postgres migrations applied + flipped enabled, stuck-DEFER recovery procedure documented — O1 closes the CLI side of this last item but the runbook integration is still pending).**

---

## Cumulative work since deep-audit synthesis

- **44 commits** total on the correctness branches (30 through W6 + 14 W7 closures + 1 W7-verifier-report) — though see §"Audit-trail integrity" for the commit-scramble caveat
- **~15,300 lines** of net code change (W6 baseline ~7,000 + W7 aggregate +8,274 / -547 = +7,727 net)
- **19 deep-audit P0/P1 closures** with paired failing→passing test evidence (W1)
- **13 deferred Medusa bypasses migrated** (W3)
- **14 cross-cluster broken tests rescued** via real Redis testcontainers (W3)
- **11 ghost metrics now real** with 4 Grafana dashboards + 14 alert YAMLs (W3)
- **6 new P0 bypass categories closed (or deferred-with-justification)** in W7: P1 reservation tool, P2 admin (deferred), P3 customer onboarding, P4 orderNote x4, P5 stripeAdjudicated wrapper + 6 cart sites, P6 fetchAdmin in order.service
- **2 of 6 governance categories shipped PARTIAL** (P5/P6 — hand-off gap captured as NEW-W7-V1, V2)
- **5 of 5 operational findings shipped PASS** (O1 defer-resume CLI + 5 unit tests, O2 phantom command replaced with executable psql loop, O3 two-person-rule reconciliation with TTY guardrail, O4 OWNER role enforced, O5 runbook key conventions corrected)
- **3 W7-Verifier adversarial probe files** under `wave7-verifier-evidence/` (G1 unicode-whitespace, G2 template-eval limits, G3 fields-missing)
- **5 NEW findings** surfaced for Wave 8 backlog (V1-P0, V2-P1, V3-P2, V4-P2, V5-P2)

---

## Honest framing — shared-branch model: where it paid off vs costs

### Where it paid off

1. **Throughput.** Wave 7 closed 11 findings in 14 commits across 6 parallel agents in <1 day of wall-clock work. Sequentially this would have been 5-7 days. For waves whose work has clearly-bounded file scopes (W3 ran this way; W5 ran this way; W7's G1/G2/G3/G4/O1/O2/O3/O4/O5/P1/P3/P4 all ran this way), the shared-branch model is the right choice.
2. **Disjoint scope discipline.** When the per-agent file scopes are disjoint, the index race produces zero content collisions. Wave 7 had zero source-file content collisions; every collision was at the commit-message layer (which is recoverable) and at the evidence-file layer (which we segregated under `w7-evidence/`).
3. **Verifier-as-net.** The independent W7-Verifier agent is structurally how shared-branch correctness gets enforced. It found NEW-W7-V1 (the P5↔P6 hand-off gap) — exactly the class of bug a self-certifying agent would miss.
4. **Evidence-first artifact ordering.** The `w7-evidence/{G,P,O}{n}-{before,after}.txt` files DID land correctly under their naming convention. Those are the actually-reliable artifact for an audit-trail reader, far more reliable than commit messages.

### What it cost

**1. The 14-commit log has 4 commits whose messages don't describe their content (29% scramble rate).**

The verifier's forensic table is reproduced below:

| SHA | Claimed scope (msg) | Actual content | Match? |
|---|---|---|---|
| `bda5973` | cli,docs,correctness-w7-O1 — defer resume CLI | matches | YES |
| `1efa47a` | api/auth,whatsapp,correctness-w7-P3 — onboarding upserts | matches | YES |
| `d922671` | infra,cli,correctness-w7-G4 — sink metric rename | matches | YES |
| `4924228` | api/auth,whatsapp,correctness-w7-P3 — onboarding upserts | **W7-P4 routing test + P4 evidence** | **NO** |
| `77cef72` | api,correctness-w7-P4 — orderNote x4 | matches | YES |
| `b5ab090` | api/auth,whatsapp,correctness-w7-P3 — onboarding upserts | **W7-O2 evidence + cli/kernel.ts psql-path + cli kernel.test.ts** | **NO** |
| `8cc3fb3` | tools/reservation,correctness-w7-P1 | matches | YES |
| `e1e1e10` | api/adapters,correctness-w7-G3 | matches | YES |
| `5cfbede` | cli,correctness-w7-O3 | matches | YES |
| `dbf077e` | governance,correctness-w7-P2 | matches | YES |
| `508b979` | api/admin,correctness-w7-O4 — kill-switch role to OWNER | **Bundles O4 + P5 + P6 + stripe-webhook** | **NO** |
| `497e7c7` | domain/order.service,correctness-w7-P6 — fetchAdmin routing | **W7-G2 backtick widening + template-literal fixture + G2 evidence** | **NO** |
| `9fbd335` | runbooks,correctness-w7-O5 | matches | YES |
| `b9575bc` | api,correctness-w7-G1 | matches | YES |

**Operational impact:** an audit-trail reader searching `git log --grep correctness-w7-P5` finds **zero commits** — the actual P5 work landed under the `correctness-w7-O4` message header in `508b979`. Likewise `--grep correctness-w7-G2` lands on `497e7c7` whose message says P6. An incident investigator must read `git show --stat <sha>` for each commit and cross-reference manually rather than relying on commit messages. The bundled commit `508b979` mixes 4 separate concerns under a misleading label.

**The content is intact.** Every claimed closure has its file diff in some commit, and the evidence files under `w7-evidence/` land correctly under their naming convention. But the audit trail at the commit-message layer is fuzzy. Future readers must rely on file diffs, not commit messages.

**2. Hand-off seam failures (NEW-W7-V1 is the canonical example).**

W7-Govern-Order explicitly punted the three cart-tool callers to W7-Stripe-Wrapper. W7-Stripe-Wrapper's scope was Stripe-only and did not include medusa-admin wiring. No agent owned the seam between them. A pre-flight RACI matrix of overlapping responsibilities — or a sentinel test that fails if any caller of `createOrderService` omits the `adminAdjudicated` option — would have caught this.

**3. No global "what fell through" check until the verifier.**

The W7 brief listed 11 findings. The 6 agents each saw their slice. No agent re-ran the full list to confirm no orphan. The adversarial verifier is structurally how that gap closes — but a lighter mechanism (a manifest of "claimed-closed" with an automated test that the closure actually landed) would catch issues earlier in the wave.

**4. The W6 inventory was wrong by 4 sites.**

W7-Govern-Admin reported 10 admin sites in the deferred allowlist, not the 6 that W6 §"10 — New bypasses discovered" rows 6–11 listed. The W6 inventory undercounted by 4 (holiday add, holiday remove, override delete, delivery-zone delete). All 4 share the same operator-only / `requireManagerRole` risk profile as the 6 known sites, and all 10 were folded into `DEFERRED_ADMIN_LOW_RISK` with per-entry rationale comments. **Lesson:** every wave should grep the surface independently rather than trusting the prior wave's count.

**5. W7-Govern-Customer reported a sub-finding the orchestrator brief didn't anticipate.**

`join-waitlist` could NOT be migrated because the service-side `joinWaitlistFromEnvelope` does not exist (the pack already declares the `reservation.waitlist.join` intent kind; only the service-side wrapper is missing). W7-Govern-Customer documented the block and pointed at the service-side TODO. Recommendation: open a follow-up task for the packages/domain owner. Tracked here for visibility; not blocking Tier 1.

**6. W7-Stripe-Wrapper kept `getStripe()` as a bare `new Stripe(key)` factory** in `packages/tools/src/cart/_stripe-helpers.ts:19` per the D8 parallel-surface convention (the wrapper sits beside the factory; the factory still exists for read-only callers; mutating callers must use the wrapper). The W7-Verifier flags this as **accepted but with future-regression risk** — a future contributor with the `getStripe()` reference in hand can `stripe.paymentIntents.<verb>(...)` without bypass-detection catching it, because the scan dirs don't cover `packages/tools/src/cart/`. Closing NEW-W7-V4 (widen scan dirs) is what makes the D8 parallel-surface convention safe long-term.

---

## Recommended next step

Two paths. The user picks.

### Option A — Spawn a tight Wave 8 (recommended)

Close NEW-W7-V1 (P0) and NEW-W7-V2 (P1) in a single ~1-day push. Both are well-scoped:

- **V1:** create `packages/tools/src/cart/_shared.ts` with a `createTooledOrderService()` factory that wires `adminAdjudicated`; migrate the three callers (`cancel-order.ts`, `amend-order.ts`, `check-order-status.ts`); then turn `order.service.ts:133-139`'s silent fallback into `throw new Error('createOrderService called without adminAdjudicated injection')` so future regressions fail loud.
- **V2:** route `stripe-webhook.ts:308` through `stripeAdjudicated.paymentIntents.update(...)` with `event.id:metadata-update:<piId>` idempotency key. Single-line change in the route file.
- **V4 (combine for free):** widen `MEDUSA_SCAN_DIRS` to include `packages/tools/src/`. ~30 min. Once V4 lands, the bypass-detection test sentinel against future regression in cart-tools is in place.

**Total estimate: 1 day for a single engineer, 4 hours for 2 in parallel.** Unblocks Tier 3 shadow and removes one of the three Tier 4 blockers (the other two, V3 and the W6-baseline ops items, are independent).

**Pro:** the verifier already wrote the reproduction probes — there's no re-investigation cost. Cuts directly to the smallest change that unblocks Tier 3.

**Con:** spawning a Wave 8 forces continued attention on this branch instead of letting the team move to the next epic. Mitigated by it being a tight 1-day push.

### Option B — Treat residual V1/V2/V3/V4/V5 as backlog

Cut Tier 1 shadow now under the GREEN verdict; queue V1/V2 into the next planning cycle as part of the kernel-rollout-Tier-3 epic; document V3/V4/V5 in the long-tail correctness backlog.

**Pro:** lets the team ship the Tier 1 win immediately and absorb the Tier 3 work into the natural Tier-3-rollout milestone rather than a one-off Wave 8.

**Con:** the longer V1 sits open, the higher the risk that a Tier 3 stakeholder reads "shadow rollout safe" without realising the Tier 3 LLM-callable surface is silently bypassing the kernel today. The NEW-W7-V1 finding is exactly the class of bug that gets lost between waves.

### Recommendation: **Option A.**

The V1/V2/V4 trio is small enough (1 day total) and well-scoped enough (reproduction probes already written) that doing it now is cheaper than re-loading the context later. V3 and V5 are honestly long-tail and belong in backlog. Spawn a "W8-close-cart-seam" task with the three deliverables; close it within the week; then declare correctness done and move on.

---

## What worked exceptionally well (W7 highlights)

1. **The verifier caught the hand-off seam.** NEW-W7-V1 was invisible to every individual agent because each saw only their slice. The verifier ran the full claimed-closed list and found the orphan. This is structurally why we have verifiers — and it justifies running one on every shared-branch wave.
2. **Evidence files held discipline even when commits scrambled.** The 25 `w7-evidence/` files all land correctly under the agreed naming. An audit-trail reader following file paths gets a clean story even when commit messages are wrong.
3. **The adversarial probes were small and reusable.** The verifier's three probe test files under `wave7-verifier-evidence/` are 235 lines total and pin the residual gaps (G1 unicode-whitespace partial, G2 documented limits, G3 fields-missing). They cost <1 day to write and will catch any regression.
4. **Per-agent decision docs (W7-DECISIONS-{admin,ops}.md) captured the discretionary calls.** Path (b) for P2 deferral and O3 two-person rule are not obviously the right call without the written rationale — having the rationale in the repo means a Wave 8 reviewer doesn't re-litigate.

## What we should change for Wave 8+ (if we have a Wave 8)

1. **Isolated worktrees per agent + final merge sweep.** The shared-branch index race produced 29% commit-message scramble. Worktrees per agent (with a final commit-message rewrite sweep before merge) would preserve audit-trail integrity. Alternative: sequential commit gating where each agent's commit is reviewed by the orchestrator before the next can land. Either trades a small amount of throughput for clean history.
2. **Sentinel test against any unwired `createOrderService` caller.** Add a test that greps `packages/tools/src/cart/` for `createOrderService(medusaAdmin)` calls and asserts each one includes `, { adminAdjudicated: ` (or fails build). Cheap, high-value, would have caught NEW-W7-V1 at PR time.
3. **Pre-flight RACI matrix for cross-package work.** When an agent's scope ends mid-seam (P6 ends at the service layer; P5 begins at the Stripe layer), the orchestrator brief should explicitly call out the seam and assign an owner. The W7 brief did say "P5 covers cart-stripe, P6 covers order-service" — what it didn't say was "who owns the wiring of `createOrderService` injection inside the cart tools." Future briefs need to make seam-ownership explicit.
4. **Wider bypass-detection scan.** The single most common Wave-N→Wave-N+1 regression class is "a category we fixed in routes/jobs/subscribers but didn't fix in packages/tools/src." Widening the scan once (NEW-W7-V4) prevents this class permanently.

---

## Appendix A — References

- W6 baseline synthesis: `docs/adjudicate-migration/correctness-remediation/FINAL-SYNTHESIS.md`
- W7 verifier full report: `docs/adjudicate-migration/correctness-remediation/wave7-verifier-report.md`
- W7 per-agent decision fragments (canonical consolidation in `W7-DECISIONS.md`):
  - `docs/adjudicate-migration/correctness-remediation/W7-DECISIONS-admin.md` (W7-D1 — P2 deferral)
  - `docs/adjudicate-migration/correctness-remediation/W7-DECISIONS-ops.md` (W7-D2 — O3 path b, W7-D3 — O4 OWNER, plus mechanical O1/O2/O5)
- 25 evidence files: `docs/adjudicate-migration/correctness-remediation/w7-evidence/{G,P,O}{n}-{before,after,evidence}.txt`
- 3 verifier adversarial probes: `docs/adjudicate-migration/correctness-remediation/wave7-verifier-evidence/probe-{g1-unicode,g2-template-eval,g3-fields-missing}.test.ts`
- 14 W7 closure commits + 1 verifier-report commit: `git log --oneline 94964f0..HEAD`
- W7 aggregate change footprint: `git diff --stat 94964f0..HEAD` (83 files, +8274/-547 lines)

End of W7 synthesis.
