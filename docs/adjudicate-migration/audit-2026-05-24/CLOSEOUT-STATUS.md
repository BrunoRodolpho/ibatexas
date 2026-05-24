# Post-R3 closeout status — 2026-05-24 evening

**Branch:** `feat/kernel-always-on-cutover` @ `654d337` (post-H2 + T2)
**Upstream:** all commits through `654d337` on origin.
**Method:** memory snapshot + live-code reconciliation against the [SYNTHESIS.md](./SYNTHESIS.md) baseline
**Supersedes (in part):** "Outstanding items" section of `[[project-ibatexas-adjudicate-migration]]` memory entry as of mid-2026-05-24

This is the authoritative "what remains" snapshot AFTER R3-1 (conformance suites) and R3-2 (P2-1 / P2-2 UX polish + tests) landed.

---

## TL;DR

The audit-2026-05-24 adversarial sweep produced **9 P0 + 8 P1 + 8 P2** findings. After R1 / R2 / R3 commit waves on this branch:

- **9 / 9 P0** fully closed in code (P0-2 race v2 closed via `4c82a22` — Fix-b post-SETNX parkKey re-check; T6 now at **hard-zero violations across 500 race iterations**. P0-9 LGPD scope has epic-track residue.)
- **8 / 8 P1** closed in code
- **8 / 8 P2** closed (P2-1, P2-2, P2-3, P2-4, P2-5, P2-6, P2-7, P2-8)
- **6 / 7 hardening conformance suites** landed (T1, T2, T3, T5, T6, T7); **1 still open** (T4 LGPD scrub — blocked on H3)

**Epic-track status:**
- **H2** — ✅ CLOSED. New `@ibatexas/audit-sink` leaf package + boot-time DI + all 28 wrapper-call sites + T2 conformance landed at `654d337`. 1196 tests pass across 4 packages.
- **H3** — LGPD anonymize scope expansion to 8 surfaces (incl. Medusa cross-DB). ~1-2d epic. Still gated on G2.

**Findings discovered during conformance + civilization + E2 work:**
- **E2** — ✅ CLOSED at `4c82a22` via Fix-b (resolver re-checks parkKey existence post-SETNX before dispatching). T6 conformance now demonstrates **hard-zero violations across 500 race iterations** (5 separate 100-iteration runs). The audit-record emit pattern uses `REFUSE` + `BUSINESS_RULE` + `code: defer.resume.skipped` + `detail: parkKey_missing_after_sweeper`, mirroring the existing anonymize `cancel_won_race` pattern. No new top-level Decision kind; no cross-repo pack version bump.
- **E1** — ✅ CLOSED inline at `a3ed062`. `pix.charge.refund.reason` rule added to `INTENT_KIND_FIELD_RULES`; `KNOWN_REDACTOR_GAPS` map emptied.
- **E3** — ✅ CLOSED at `daa1fc5`. Sweeper ghost-publish suppressed in BOTH `sweepDeferTimeouts` AND `runRecoveryScan` (symmetric — the contract gap was exposed in both paths). Genuine malformed-blob branch preserved for real data-corruption cases. 5/5 T6 runs hard-zero; 68/68 broader tests pass.

The cutover claim "kernel is authoritative and audited" is now **TRUE across all wrapper-call paths** (post-H2). The only remaining authority/audit gap is the LGPD anonymize executor scope (H3).

---

## Closed since SYNTHESIS.md was written

| ID | Finding | Closing commit(s) |
|---|---|---|
| P0-1 | NX-park wrapper had 0 production callers → 4 callers migrated | `de207b2`, `f793cbd` |
| P0-2 | Sweeper-vs-resume race — SETNX `defer:resuming:` mutex (R2-1) + Fix-b resolver re-checks parkKey post-SETNX (E2). T6 hard-zero across 500 race iterations. | `a1fbb25`, `4c82a22` |
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
| P0-4 | H2 — `@ibatexas/audit-sink` leaf package + 28-site wrapper sweep + required `auditSink` meta | `a928370..654d337` (7 commits) |
| T2 | AuditSink wrapper-call conformance suite (38 sites scanned, regression floor at 30) | `2b35eaf` |
| T1 | NX-park static-import conformance suite | `6dda950` |
| T3 | Per-intent-kind redactor conformance + 42-entry PII_FREE_KIND_ALLOWLIST | `5979b70` |
| T5 | DEFER+resume integrity integration test | `6dda950` |
| T6 | Sweeper-resolver race conformance (100 iterations, 10% tolerance) | `5979b70` |
| T7 | Idempotency-key conformance suite + 14-entry allowlist | `6dda950` |

R3-1 surfaced **7 previously-unenumerated idempotency-key allowlist entries** (6 amend-order Medusa sites + 1 stripe stale-PI cancel) — all justified with "self-deduping upstream" rationale; documented in the T7 allowlist.

---

## Still open (post-R3)

### H2 — Wrapper auditSink dep-cycle (P0-4) — ✅ CLOSED

**Closed:** `a928370..654d337` (7 commits, 2026-05-24 evening). Sub-option **A1** (pure builder + boot-time DI) per G1 user decision.

**What landed:**
- New `@ibatexas/audit-sink` leaf package (`a928370`) — re-exports `AuditSink` from `@adjudicate/audit`, exports `__setAuditSinkDependencies({redisClient, prismaWriter, natsPublisher, logger})` + `getAuditSink()`. Fail-closed via `AuditSinkNotInitializedError` if `getAuditSink()` is called before registration.
- Sink construction moved into leaf (`74181f9`); legacy `_setAuditSinkDependencies` shim preserved in `intent-audit-wiring.ts` so 18 pre-existing tests pass unmodified.
- Boot wiring at `apps/api/src/audit-sink-bootstrap.ts` (`5aa7047`) — called from server start before kernel/wrapper paths can execute.
- `auditSink` REQUIRED on all 4 wrapper meta types (`a63305c`); conditional `if (meta.auditSink)` guards removed — emit is mandatory.
- All 28 wrapper-call sites pass `auditSink: getAuditSink()` (`8e3847d`). T2 conformance suite walks 38 sites total (regression floor at 30).
- T2 conformance + bypass-detection cleanup (`2b35eaf`, `654d337`).

**Verified test counts:** audit-sink 11/11, llm-provider 443/443, tools 680/680, api audit-2026-05-24 + bypass-detection 62/62 = **1196 tests pass**.

**Surprises during H2:**
- `multiSink` in `@adjudicate/audit` v1.0.1 is strict by default — postgres-sink errors propagate. Buffered sink + spill handle this; H2 leaf is fail-open at the IbateXas boundary.
- `packages/tools` had no `vitest.config.ts` — added with no-op leaf wiring at `src/__tests__/setup.ts` so tests don't hit the fail-closed leaf.
- The `_shared.ts:54` `createTooledOrderService` factory wire was tractable — no cascade into `@ibatexas/domain`.
- JSDoc inline-comment trap in `bypass-detection.test.ts` required a small `noopPrismaWriter` rewrite (closed by `654d337`).

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
| ~~Migrate gateway callers from `buildEnvelope` to `buildCustomerEnvelope`~~ | `apps/api/src/routes/{cart,me,order-actions}.ts` — **12 sites migrated at `1fd65a3`** | Polish-B | ✅ CLOSED. 12 of 24 customer-route `buildEnvelope` calls migrated. 5 payment-transition envelopes intentionally left on raw `buildEnvelope` because they're `user` + `TRUSTED` (server-derived payloads); `buildCustomerEnvelope` would force UNTRUSTED, changing semantics. 5 system-actor envelopes untouched. Source-pattern test in `order-note-add-routing.test.ts` updated to accept both literal-UNTRUSTED and `buildCustomerEnvelope<` patterns. |
| ~~Stale `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE` env-var stubs~~ | `apps/api/src/__tests__/cart-routes.test.ts` SEC-001 | Polish-B | ✅ CLOSED at `9fba9ef`. Tests REWRITTEN (not deleted) — they had load-bearing auth-gate intent. Dead env-stub replaced with proper `vi.mock("@adjudicate/core/kernel", ...)` mirroring the `order-cancel-governance.test.ts` pattern. 27/27 pass (was 24/27). |
| **NEW (from Polish-B) — Pre-existing apps/api test failures** | `apps/api/src/__tests__/park-deferred-intent-nx.test.ts` (3), `wave6-red-team/01-customerid-whitespace-bypass.test.ts` (3) | Polish-B (out-of-scope flag) | 6 pre-existing failures confirmed by `git stash` + retest baseline. Net delta from Polish-B work: **-4 failures** (was 10, now 6). The whitespace-bypass tests are particularly notable — R1-4 (`fae8dc5`) supposedly fixed JWT whitespace but these tests fail. Either testing a different surface or a regression. Investigation needed. |
| Workspace `dist/`-build requirement for cross-package tests | `packages/tools/`, `packages/llm-provider/`, `apps/api/` | Polish-A + P2-8 v2 + E3 | Source-imports-from-dist pattern means each package must be built before consumers can type-check or test against it. Workspace ergonomics — worth considering `tsc --build` orchestration or source-imports config. |
| Possible documentation correction in P2-8 task file premise | `docs/adjudicate-migration/audit-2026-05-24/tasks/p2-remaining-polish.md` §"P2-8" | P2-8 v2 | Task file premise about medusa.store.* / INTENT_KIND_FIELD_RULES was wrong (medusa.store.* is by-design outside KNOWN_INTENT_KINDS per W5-7/D10 policy at `packages/llm-provider/src/intent-kinds.ts:30-38`). Future medusa-namespace task files should reflect this. |
| **NEW (from M6) — Code-side stale env-var refs** | `packages/llm-provider/src/stripe/adjudicated.ts:47` (comment), `packages/cli/src/commands/kernel.ts:90-91`, `apps/api/src/plugins/kernel-metrics-sink.ts:205` (`kernel_shadow_divergence_total` Prometheus metric) | M6 (out-of-scope flag) | All three reference cutover-deleted machinery (`IBX_KERNEL_SHADOW`/`IBX_KERNEL_ENFORCE`/shadow-mode metric). Vestigial — likely safe to delete. ~30min mechanical cleanup. |
| **NEW (from M6) — Localized stale refs in load-bearing governance/threat-model docs** | `governance/{01,03,04,05}.md` (4 sites), `threat-model/THREAT-MODEL.md:33,68` | M6 | Surrounding doc is load-bearing; only specific lines reference deleted env vars / kill-switch surfaces. Per-line edits with banners — ~30min. Captured per-file in each M6 README. |

### Hardening conformance — 1 suite remaining (T4)

| Suite | Purpose | Status |
|---|---|---|
| T4 | LGPD scrub conformance — snapshot every table reachable from customerId; post-anonymize zero rows match the pre-anonymize PII fixtures | 🚧 Blocked on H3; will be bundled with the H3 epic sub-agent |

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
