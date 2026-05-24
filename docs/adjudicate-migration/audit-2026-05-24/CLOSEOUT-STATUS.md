# Post-R3 closeout status — 2026-05-24 evening

**Branch:** `feat/kernel-always-on-cutover` @ `8ea3795` (post-P2-4)
**Upstream divergence:** all commits through `1dec1a0` already on origin; `8ea3795` (P2-4) is the first post-push commit. 1 commit behind `origin/main` (merge of dev → main during the audit-2026-05-24 sweep) — branch-push not affected.
**Method:** memory snapshot + live-code reconciliation against the [SYNTHESIS.md](./SYNTHESIS.md) baseline
**Supersedes (in part):** "Outstanding items" section of `[[project-ibatexas-adjudicate-migration]]` memory entry as of mid-2026-05-24

This is the authoritative "what remains" snapshot AFTER R3-1 (conformance suites) and R3-2 (P2-1 / P2-2 UX polish + tests) landed.

---

## TL;DR

The audit-2026-05-24 adversarial sweep produced **9 P0 + 8 P1 + 8 P2** findings. After R1 / R2 / R3 commit waves on this branch:

- **9 / 9 P0** closed in code (P0-4 wrapper auditSink and P0-9 LGPD scope have epic-track residue — see below)
- **8 / 8 P1** closed in code
- **8 / 8 P2** closed (P2-1, P2-2, P2-3, P2-4, P2-5, P2-6, P2-7, P2-8)
- **5 / 7 hardening conformance suites** landed (T1, T3, T5, T6, T7); **2 still open** (T2 AuditSink wrapper-call — blocked on H2; T4 LGPD scrub — blocked on H3)

**Two epic-track items remain:**
- **H2** — wrapper `auditSink` dep-cycle. User picked **A1 (pure builder + boot-time DI)** + **Include scope (28 sites)** on 2026-05-24 evening. Ready to re-dispatch.
- **H3** — LGPD anonymize scope expansion to 8 surfaces (incl. Medusa cross-DB). ~1-2d epic. Still gated on G2.

**Surfaced during conformance work (NEW findings):**
- **E2 (re-opens P0-2)** — T6 sweeper-resolver race conformance test demonstrates the R2-1 SETNX mutex DOES NOT fully serialize sweeper-vs-resolver. The sweeper releases the `defer:resuming:*` mutex AFTER publishing `intent.defer.timeout` and DELing the parkKey, allowing the resolver (which already GET'd the blob into memory) to SETNX-acquire post-release and dispatch the same mutation a second time. Empirical violation rate: **1–4% per 100 iterations** with random 0–50ms jitter. T6 currently tolerates 10% (2× upper-observed) so the suite passes — but the production race is real. Three candidate fixes flagged: (a) sweeper holds mutex until parkKey TTL, (b) resolver re-checks parkKey existence post-SETNX before dispatching, (c) separate mutex namespaces for sweeper vs resolver. **Recommendation:** (b) — cheapest and correct. **This needs a follow-up ticket; not in current scope.**
- **E1 (minor redactor gap)** — `pix.charge.refund.reason` is a free-form admin text field with no per-kind redactor rule. Already documented in T3's `KNOWN_REDACTOR_GAPS` map; surfaces as `console.warn` on each test run. ~5-min fix when the user wants to close it.

The cutover claim "kernel is authoritative and audited" is now **TRUE for the order-actions route family** and **STILL FALSE for cart tool + whatsapp client egress** until H2 lands.

---

## Closed since SYNTHESIS.md was written

| ID | Finding | Closing commit(s) |
|---|---|---|
| P0-1 | NX-park wrapper had 0 production callers → 4 callers migrated | `de207b2`, `f793cbd` |
| P0-2 | Sweeper-vs-resume race → SETNX `defer:resuming:` mutex + new pix-defer-timeout-resolver | `a1fbb25` |
| P0-3 | Anonymize cancel-vs-resolve race → SETNX `anonymize:active:` lock | `df25dbf` |
| P0-5 | Redactor `whatsapp.handoff.request` typo + `templateVariables` miss | `a487cb3` |
| P0-6 | 14 intent kinds missing free-form field redactor rules | `a487cb3` |
| P0-7 | Random `randomUUID()` nonces → 5 priority sites + 6 amend-order sites + Twilio/Stripe stale-PI on allowlist | `f793cbd`, `6dda950` |
| P0-8 | anonymize-grace-resolver emitted no audit record | `40f0813` |
| P1-1 | `update_preferences` zeros stored allergens → REFUSE | `fae8dc5` |
| P1-2 | Redactor doesn't walk `decision.rewritten.payload` | `a487cb3` |
| P1-3 | resume-dispatcher silently dropped kernel-covered tool resumes (task-22) | `3179227` |
| P1-4 | Audit row duplication: forward-compatible dedup hook code landed; **op-side UNIQUE constraint migration still pending** | `3179227` |
| P1-5 | defer-resolver missing `supersedes` linkage | `40f0813` |
| P1-6 | `middleware/auth.ts` accepts whitespace `sub` | `fae8dc5` |
| P1-7 | `intent.defer.timeout` had no PIX consumer | `a1fbb25` |
| P1-8 | NX-wrapper quota counter leak on park-throw | `a1fbb25` |
| P2-1 | Twilio retry treated REFUSE as transient → 3 audit emissions per refusal | `7d4af68` |
| P2-2 | W4 cart catches swallowed `MedusaStoreAdjudicateRefusedError.userFacing` | `7d4af68` |
| P2-3 | D3 audit record lost original `pickup`/`dine_in` vocab fidelity → `httpVocab` field | `fae8dc5` |
| P2-4 | NATS subscriber queue groups | `8ea3795` |
| P2-5 | Force-* payloads omitted `expectedVersion` | `f793cbd` |
| P2-6 | Customer-intent-gateway: `actor.principal` forgery defense | `5531a95` |
| P2-7 | Customer-intent-gateway: `taint: "TRUSTED"` forgery defense | `5531a95` |
| P2-8 | Split `medusa.store.cart.{email,metadata}.update` taxonomy | `87c0474` |
| T1 | NX-park static-import conformance suite | `6dda950` |
| T3 | Per-intent-kind redactor conformance + 42-entry PII_FREE_KIND_ALLOWLIST | `5979b70` |
| T5 | DEFER+resume integrity integration test | `6dda950` |
| T6 | Sweeper-resolver race conformance (100 iterations, 10% tolerance) | `5979b70` |
| T7 | Idempotency-key conformance suite + 14-entry allowlist | `6dda950` |

R3-1 surfaced **7 previously-unenumerated idempotency-key allowlist entries** (6 amend-order Medusa sites + 1 stripe stale-PI cancel) — all justified with "self-deduping upstream" rationale; documented in the T7 allowlist.

---

## Still open (post-R3)

### H2 — Wrapper auditSink dep-cycle (P0-4 residue)

**Status:** Architectural decision pending; first H2 dispatch found scope was 2× larger than originally enumerated AND the proposed "Option A" rested on a wrong premise (the AuditSink interface is already in `@adjudicate/audit`).
**Corrected blast radius:** **28 wrapper-call sites** (not 14) silently skip audit emit — 26 in `packages/tools/src/cart/*` (incl. 7 in create-checkout, 9 in amend-order, 2 in reorder.ts, 1 in `_shared.ts:54` factory) + 2 in `apps/api/src/whatsapp/client.ts`. The 18 sites in `apps/api/src/routes/{cart, stripe-webhook, admin/products}.ts` plus 5 in order-actions.ts are already correctly threading `auditSink`.
**Architectural reality:** `AuditSink` interface lives in `@adjudicate/audit` (registry leaf — no extraction needed). `getAuditSink()` lives in `packages/llm-provider/src/intent-audit-wiring.ts` with load-bearing deps on `@ibatexas/tools` (Redis), `@ibatexas/domain` (Prisma), and `@ibatexas/nats-client`. A naïve extract creates the inverse cycle.
**Three real sub-options (G1):** **A1** pure builder + boot-time DI / **A2** adapters move with leaf + type-only imports / **A3** thin interface leaf + app-side registration (recommended). See task file.
**Scope sub-decision:** include or exclude `reorder.ts` (2 sites) + `_shared.ts:54` factory wire (1 site). Default: include.
**Task file:** [tasks/h2-wrapper-audit-sink-architecture.md](./tasks/h2-wrapper-audit-sink-architecture.md) — updated 2026-05-24 evening with corrected scope + 3 sub-options.

### H3 — LGPD anonymize scope expansion (P0-9)

**Status:** Scoped, not started. Epic-track work pending user gate.
**Blast radius:** ANPD non-compliance. Customer can request anonymize, the destructive op runs, and the following surfaces still carry PII linked to the customer:
- `OrderProjection.{customerEmail, customerName, customerPhone, shippingAddressJson}`
- `ConversationMessage.content`, `Conversation.customerId`
- `OrderStatusHistory.actorId`, `OrderEventLog.payload`
- `LoyaltyAccount` (customer-linked record retains balance + history)
- `Reservation.specialRequests`
- **Medusa-side customer row** (separate database — cross-DB compensation or 2PC required)

**Verified live state:** `packages/domain/src/services/customer.service.ts:591` scrubs only Customer profile (name/email/phone/cpf/medusaId), Address (delete), CustomerPreferences (delete), Review.comment. The 8 enumerated surfaces are untouched.

**Decision required (G2):** see [Decision Gates](#decision-gates) below.
**Task file:** [tasks/h3-lgpd-anonymize-scope-expansion.md](./tasks/h3-lgpd-anonymize-scope-expansion.md)

### P2 polish — all closed

### Follow-ups surfaced by sub-agents (out of audit-2026-05-24 scope)

| Item | File | Source | Notes |
|---|---|---|---|
| Migrate gateway callers from `buildEnvelope` to `buildCustomerEnvelope` | `apps/api/src/routes/{cart,me,order-actions}.ts` (8+ sites) | Polish-B | Closes the "wider-type back-door" so the structural defense is total. Mechanical sweep, ~1-2h. |
| Stale `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE` env-var stubs | `apps/api/src/__tests__/cart-routes.test.ts` SEC-001 suite (3 failing tests) | Polish-B | Tests pre-date the cutover; the kernel no longer reads those env vars. Delete the stubs or replace with proper kernel-mock setup. ~30min. |
| Workspace `dist/`-build requirement for cross-package tests | `packages/tools/` (172 pre-existing typecheck errors), `packages/llm-provider/` (78 pre-existing typecheck errors), `apps/api/` cross-package tests | Polish-A + P2-8 v2 | Source-imports-from-dist pattern means each package must be built before consumers can type-check or test against it. Forced both agents to either skip cross-package tests OR run `pnpm -F <pkg> build` (allowed only when scope-minimal). Workspace ergonomics — worth considering a `tsc --build` orchestration or source-imports config. |
| Possible documentation correction in P2-8 task file premise | `docs/adjudicate-migration/audit-2026-05-24/tasks/p2-remaining-polish.md` §"P2-8" | P2-8 v2 | Task file claimed "the existing `medusa.store.cart.email.update` rule stays" — no such rule existed. Also instructed "add per-kind rule" — but `medusa.store.*` is by-design outside `KNOWN_INTENT_KINDS` (W5-7 / D10 policy at `packages/llm-provider/src/intent-kinds.ts:30-38`), so the correct call is to leave audit-redactor untouched. Future task files for the medusa namespace should reflect this. |

### Hardening conformance — 4 suites remaining

| Suite | Purpose | Notes |
|---|---|---|
| T2 | AuditSink wrapper-call conformance — assert every wrapper-call passes `auditSink` | Blocked on H2 — pointless until the dep-cycle resolves and wrappers can require the sink |
| T3 | Per-intent-kind redactor conformance — for each kind in `KNOWN_INTENT_KINDS`, either a per-kind rule exists OR the payload is provably PII-free | ~2-3h |
| T4 | LGPD scrub conformance — snapshot every table reachable from customerId; post-anonymize zero rows match the pre-anonymize PII fixtures | Blocked on H3 — useless before scope expansion lands |
| T6 | Sweeper-resolver race regression test — schedule both within 50ms; assert at most one mutation fires | ~1-2h |

**Total ~3-5h for T3 + T6** (the only two unblocked).
**Task file:** [tasks/hardening-conformance-followup.md](./tasks/hardening-conformance-followup.md)

### F2 — `kernel.intent_dispatched` basis code (sibling repo)

**Status:** Sibling `adjudicate/main` is clean and ready for the PR. Never landed.
**Effort:** ~15min in `adjudicate/packages/core/src/basis-codes.ts` + version bump + `pnpm install` in ibatexas to consume.
**Task file:** [tasks/f2-sibling-basis-code.md](./tasks/f2-sibling-basis-code.md)

### WhatsApp `lastCustomerMessageAt` state-builder

**Status:** Design not yet done. Unblocks ~7 deferred subscriber/job sites (notification.send, handoff-subscriber, cart-tier-escalation, …).
**Effort:** 1-2d once design lands.
**Decision required (G5):** worth a focused design session, or defer further?
**Task file:** [tasks/whatsapp-state-builder-design.md](./tasks/whatsapp-state-builder-design.md)

### Operator-action items (not engineering)

- Apply audit-postgres SQL migrations + Postgres provisioning. P1-4 dedup landed forward-compatible code waiting on the `(intent_hash, recorded_at)` UNIQUE constraint to actually fire. Until the migration runs in prod, every audit row still lands twice.
- NATS auth deployment.

### Pre-existing latent bugs (out of audit-2026-05-24 scope, but tracked)

- `get_loyalty_balance` is READ_ONLY-classified but triggers a Postgres upsert.
- `submit_review` has no cross-customer ownership check (a customer can submit a review for an orderId belonging to another customer).

Add to backlog; not part of this closeout.

---

## Decision Gates

The following are explicit go/no-go decisions for the user. Implementation sub-agents WILL NOT be spawned for the gated items until each decision is made.

### G1 — Wrapper auditSink architecture (blocks H2 + T2) — **CORRECTED 2026-05-24 evening**

Original "Option A" rested on a wrong premise: `AuditSink` is already in `@adjudicate/audit` (registry leaf), nothing to extract there. `getAuditSink()` has runtime deps on `@ibatexas/tools`/`@ibatexas/domain` that would create an inverse cycle on naïve extract. After the H2-recon agent surfaced this, three real sub-options emerged:

| Sub-option | Mechanism | Effort | Risk | Trade-off |
|---|---|---|---|---|
| **A1** | New leaf `@ibatexas/audit-sink` = pure builder; boot-time `__setAuditSinkDependencies({redis, prisma, logger, nats})` from app. Leaf has zero runtime deps on tools/domain. | 6-8h | med | Cleanest layering; boot-order coupling |
| **A2** | New leaf includes adapters; leaf imports `@ibatexas/tools` only via `import type` (type-only, no runtime cycle). Lazy-singleton fallback preserved. | 5-7h | low-med | Smaller behavioral delta; needs import-discipline rule |
| **A3** | New leaf is thin: re-exports `AuditSink` from `@adjudicate/audit` + `registerAuditSink`/`getAuditSink` interface. `intent-audit-wiring.ts` STAYS in `@ibatexas/llm-provider`; calls `registerAuditSink(sink)` at boot. Tools imports the leaf interface. | 3-4h | low | **Smallest blast radius; fail-closed by construction** |

**Default recommendation:** **A3** — smallest blast radius, lowest risk, fastest. Other two buy more architectural purity but cost more hours for marginal gain over A3's strict-leaf-with-registration shape.

**Scope sub-decision:** include or exclude `cart/reorder.ts` (2 sites) + `cart/_shared.ts:54` factory wire (1 site)? Both are real LLM-callable / system-actor mutation paths. **Default recommendation:** include (28 sites total instead of 26).

### G2 — H3 epic timing + scope

LGPD anonymize scope expansion is ~1-2d wall-clock with two non-trivial sub-decisions:
- **a.** Medusa-side customer row scrub — cross-DB transaction (2PC) or compensation pattern with retry?
- **b.** `OrderProjection.shippingAddressJson` is a JSON blob — full-replace with `{anonymized: true}` or in-place key scrub?

**Default recommendation:** Compensation pattern with `customer.anonymize.medusa.pending` audit kind + retry job (no 2PC dependency); full-replace JSON to keep the executor simple.

### G3 — Push 11 unpushed commits to origin

11 commits on `feat/kernel-always-on-cutover` (`a487cb3..7d4af68`) are local-only. The branch is also 1 commit behind `origin/main` (main moved during the sweep) — a fast-forward is no longer possible without a rebase or merge.

**Sub-decisions:**
- Push as-is and resolve the 1-commit gap on `main` later?
- Rebase the 11 commits over `origin/main` first, then push?
- Open the gap with a separate merge commit?

**Default recommendation:** Rebase 11 commits over `origin/main` (small, predictable; preserves linear history), then push.

### G4 — F2 sibling-repo release cadence

Cutting a minor on `@adjudicate/core` requires (1) PR in sibling repo, (2) npm publish, (3) git tag, (4) bump ibatexas's pin in `package.json` and `pnpm install`. This is a release event; not a quick win.

**Sub-decisions:**
- Land F2 alone, or wait and bundle with the next sibling-repo change?
- Coordinate with any pending sibling-repo work?

**Default recommendation:** Bundle F2 with any other near-term sibling work; F2 alone is small enough that a release event is overhead.

### G5 — WhatsApp `lastCustomerMessageAt` state-builder design

Currently 7 subscriber/job sites can't be governed until the state-builder exists. A focused design session would produce the design doc; implementation is ~1-2d after.

**Sub-decisions:**
- Schedule design session in the next session, or defer until other priorities clear?

**Default recommendation:** Defer until H2 lands — H2 changes the wrapper-meta surface area, and the state-builder design will need to settle on top of the final wrapper shape.

---

## Recommended sequencing (orchestrator's view)

```
       ┌─ Phase A (parallel, no gate) ──────────────────────────────┐
       │  • P2 polish — 3 sub-agents on disjoint files             │
       │  • T3 + T6 conformance — 1 sub-agent                       │
       │  • F2 sibling-repo PR — 1 sub-agent (after G4)            │
       └────────────────────────────────────────────────────────────┘
                                │
                                ▼
       ┌─ Phase B (gated on G1) ────────────────────────────────────┐
       │  • H2 wrapper auditSink — 1 sub-agent on chosen option    │
       │  • T2 AuditSink wrapper-call conformance — same agent     │
       └────────────────────────────────────────────────────────────┘
                                │
                                ▼
       ┌─ Phase C (gated on G2) ────────────────────────────────────┐
       │  • H3 LGPD anonymize scope — epic, 1 sub-agent serial     │
       │  • T4 LGPD scrub conformance — same agent                 │
       └────────────────────────────────────────────────────────────┘
                                │
                                ▼
       ┌─ Phase D (gated on G3) ────────────────────────────────────┐
       │  • Rebase + push 11 commits to origin                     │
       └────────────────────────────────────────────────────────────┘

       ┌─ Phase E (operator action, not engineering) ──────────────┐
       │  • audit-postgres SQL migrations applied in prod          │
       │  • NATS auth deployment                                    │
       └────────────────────────────────────────────────────────────┘
```

**Wall-clock estimate if all gates pass favorably:**
- Phase A: ~6-8h (parallel sub-agents)
- Phase B: 4-6h (Option A) + 1-2h T2 conformance
- Phase C: 1-2 days
- Phase D: 30min (rebase + push)
- Total non-epic engineering: ~2-3 sessions

---

## What this closeout does NOT cover

- Independent re-verification of every commit's tests — relied on commit metadata + spot-checks. A sweep agent could run the full test matrix if desired.
- Cross-repo conformance matrix execution (`@adjudicate/conformance` harness exists, top-level CI gate doesn't).
- Latency / load regression post-cutover.
- WhatsApp inbound prompt-injection threat model refresh.
- Threat-model coverage of the cutover-deleted operational surfaces.
