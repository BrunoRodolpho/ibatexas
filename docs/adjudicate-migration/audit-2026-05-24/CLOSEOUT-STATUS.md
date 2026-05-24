# Post-R3 closeout status — 2026-05-24 evening

**Branch:** `feat/kernel-always-on-cutover` @ `7d4af68`
**Upstream divergence:** 219 commits ahead of `origin/main` (11 unpushed past last `git push`), 1 commit behind `origin/main` (`main` moved during the audit-2026-05-24 sweep)
**Method:** memory snapshot + live-code reconciliation against the [SYNTHESIS.md](./SYNTHESIS.md) baseline
**Supersedes (in part):** "Outstanding items" section of `[[project-ibatexas-adjudicate-migration]]` memory entry as of mid-2026-05-24

This is the authoritative "what remains" snapshot AFTER R3-1 (conformance suites) and R3-2 (P2-1 / P2-2 UX polish + tests) landed.

---

## TL;DR

The audit-2026-05-24 adversarial sweep produced **9 P0 + 8 P1 + 8 P2** findings. After R1 / R2 / R3 commit waves on this branch:

- **9 / 9 P0** closed in code (P0-4 wrapper auditSink and P0-9 LGPD scope have epic-track residue — see below)
- **8 / 8 P1** closed in code
- **4 / 8 P2** closed (P2-1, P2-2, P2-3, P2-5); **4 still open** (P2-4, P2-6, P2-7, P2-8)
- **3 / 7 hardening conformance suites** landed (T1 NX-park, T5 DEFER+resume, T7 idempotency); **4 still open** (T2 AuditSink wrapper-call, T3 per-intent-kind redactor, T4 LGPD scrub, T6 sweeper-resolver race regression)

**Two epic-track items remain** and both need user gating before sub-agent delegation:
- **H2** — wrapper `auditSink` dep-cycle architectural decision (Option A / B / C). Closes the P0-4 hole at all 12 cart + 2 whatsapp wrapper-call sites that currently silently skip audit emit. ~4-6h post-decision.
- **H3** — LGPD anonymize scope expansion to 8 surfaces (incl. Medusa cross-DB). ~1-2d epic.

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
| P2-5 | Force-* payloads omitted `expectedVersion` | `f793cbd` |
| T1 | NX-park static-import conformance suite | `6dda950` |
| T5 | DEFER+resume integrity integration test | `6dda950` |
| T7 | Idempotency-key conformance suite + 14-entry allowlist | `6dda950` |

R3-1 surfaced **7 previously-unenumerated idempotency-key allowlist entries** (6 amend-order Medusa sites + 1 stripe stale-PI cancel) — all justified with "self-deduping upstream" rationale; documented in the T7 allowlist.

---

## Still open (post-R3)

### H2 — Wrapper auditSink dep-cycle (P0-4 residue)

**Status:** Architectural decision pending; cannot delegate until user picks an option.
**Blast radius:** 12 cart-tool sites + 2 `apps/api/src/whatsapp/client.ts` sites silently skip audit emit. Stripe PIX `billing_details.{name, email, tax_id}` is the worst offender (`packages/tools/src/cart/create-checkout.ts:68`).
**Verified live state:** all 4 wrappers (`twilio/adjudicated.ts:381`, `stripe/adjudicated.ts:355`, `medusa/store-adjudicated.ts:539`, `medusa/adjudicated.ts:501`) still declare `readonly auditSink?: AuditSink` as optional. `apps/api/src/routes/order-actions.ts` (5 sites) successfully passes `auditSink: getAuditSink()` because `apps/api/` can import from `@ibatexas/llm-provider`. The cycle is between `@ibatexas/tools` → `@ibatexas/llm-provider`.
**Decision required (G1):** see [Decision Gates](#decision-gates) below.
**Task file:** [tasks/h2-wrapper-audit-sink-architecture.md](./tasks/h2-wrapper-audit-sink-architecture.md)

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

### P2 polish — 4 items remaining

| # | Finding | File | Effort |
|---|---|---|---|
| P2-4 | `subscribeNatsEvent` no queue group → N-way handler inflation | NATS subscriber wiring | 1h |
| P2-6 | Latent forgery: `actor.principal: "system"` mintable from customer HTTP routes | customer-intent-gateway | 2h |
| P2-7 | Latent forgery: `taint: "TRUSTED"` mintable from customer HTTP routes | customer-intent-gateway | 1h |
| P2-8 | C1 taxonomy mismatch (`medusa.store.cart.email.update` used for metadata-only carts.update) | `packages/tools/src/medusa/store-adjudicated.ts` (`carts.update` site) | 30min |

**Total ~4.5h.** Parallel-safe across 2-3 sub-agents (P2-6 + P2-7 share a file → 1 agent).
**Task file:** [tasks/p2-remaining-polish.md](./tasks/p2-remaining-polish.md)

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

### G1 — Wrapper auditSink architecture (blocks H2 + T2)

The dep-cycle is `@ibatexas/tools` cannot import `getAuditSink` from `@ibatexas/llm-provider`. Three options trade off differently:

| Option | Mechanism | Effort | Trade-off |
|---|---|---|---|
| **A** | Extract `getAuditSink` (and dependencies) into a new leaf package, e.g. `@ibatexas/audit-sink`. Both `tools` and `llm-provider` import from the leaf. | 4-6h + new package wiring | Cleanest; needs a new workspace package + version pin |
| **B** | DI: attach `auditSink` to the wrapper-meta at boot via a default-meta injector. Callers don't pass it; the wrapper reads from a module-scoped default if `meta.auditSink` is undefined. | 3-4h | Less churn at call sites; introduces module-scoped state |
| **C** | Remove `auditSink` from wrapper meta entirely; callers emit the audit record themselves after the wrapper returns. | 4-6h + 14 call-site edits | Inverts ownership; wrapper no longer "audited by construction" |

**Default recommendation:** Option A — leaf-package extract. Aligns with the existing `@adjudicate/*` separation of concerns, makes T2 enforceable at compile time, no module-scoped state.

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
