# H3 Investigation — Synthesis

**Wave:** 4 parallel investigators (schema, compliance, cross-db, test-fixtures) — all reported
**Synthesizer:** orchestration kernel
**Source reports:**
- [schema.md](./schema.md) — Prisma surface + writer/reader + per-surface strategy
- [compliance.md](./compliance.md) — LGPD Art. 18 alignment + audit-trail tensions
- [cross-db.md](./cross-db.md) — Medusa compensation pattern + API surface
- [test-fixtures.md](./test-fixtures.md) — T4 conformance suite shape + fixture builder

---

## TL;DR

H3 implementation is **scope-locked** and **architecturally settled** — but **expanded from 3 → 5 G2 sub-decisions** that need user sign-off before sub-agent dispatch.

Consolidated approach:
- 7 in-process surfaces — per-surface anonymize strategies confirmed (mix of null-out, placeholder, delete-row, full-replace-json).
- 1 cross-DB surface (Medusa) — **compensation + retry pattern** using existing outbox / NATS / BullMQ infra; no new infra required.
- T4 conformance suite — **Postgres testcontainer + declarative `PIIFixtureSpec`** builder pattern.
- Total effort: **~3-4 days** end-to-end (H3 implementation ~2 days; T4 ~10-15h post-impl).

Open risks:
- **Medusa v2 API endpoint for customer scrub** needs production-verified path (PATCH `/admin/customers/{id}` is the cross-db investigator's best guess but must be confirmed).
- **Medusa customer `metadata` JSON** may carry undocumented PII from integrations — needs an inventory pass.

Misc: the compliance investigator surfaced a CLOSED concern as P0 (cancel-vs-resolve race, already closed at `df25dbf` via R2-2). Their institutional-memory was half-stale. Treating as benign noise; not actionable.

---

## Consolidated per-surface anonymize strategies

| # | Surface | Strategy (Schema-Inv recommendation) | LGPD class (Compliance-Inv) | T4 fixture path |
|---|---|---|---|---|
| 1 | `OrderProjection.customerEmail` | null-out | direct identifier | populator |
| 1 | `OrderProjection.customerName` | null-out | direct identifier | populator |
| 1 | `OrderProjection.customerPhone` | null-out | direct identifier | populator |
| 1 | `OrderProjection.shippingAddressJson` | full-replace JSON `{anonymized:true}` | derived (address) | populator |
| 2 | `ConversationMessage.content` | placeholder `[anonymized]` | behavioral (chat history) | populator |
| 3 | `Conversation.customerId` | null-out (already nullable) | pseudo-identifier | populator |
| 4 | `OrderStatusHistory.actorId` | null-out where `actor='customer'` | pseudo-identifier | populator |
| 5 | `OrderEventLog.payload` | **full-replace JSON OR audit-carve-out — G2 SUB-DECISION** | append-only audit log (LGPD tension) | populator |
| 6 | `LoyaltyAccount` | delete-row (Cascade WON'T fire on in-place anonymize) | pseudo-identifier + derived balance | populator |
| 7 | `Reservation.specialRequests` | null-out | behavioral (health/access notes) | populator |
| 8 | Medusa-side customer row | compensation + retry job (eventual-consistent ~5-30 min) | direct identifier | requires Medusa testcontainer — out of T4 scope; deferred to P0-9b |

**FK surprises from schema investigator (load-bearing):**
- `OrderStatusHistory.actorId` is NOT a Prisma relation — it's a raw `String` column (can reference Staff OR Customer). No automatic Cascade / SetNull; manual scrub required.
- `LoyaltyAccount` declares `onDelete: Cascade` but anonymize is **in-place** (not Customer DELETE) — Cascade does not fire. Explicit delete-row in the executor needed.
- `Reservation` has `onDelete: Restrict` toward Customer — blocks Customer DELETE; **does not block in-place anonymize**.

---

## G2 sub-decisions — EXPANDED (was 3, now 5)

The H3 task file originally enumerated 3 G2 sub-decisions. The compliance investigator surfaced two more. **All 5 need user picks before sub-agent dispatch.**

### G2-a — Medusa-side scrub approach

| Option | Rationale |
|---|---|
| **Compensation + retry job (recommended by both Cross-DB-Inv and H3 task file)** | Uses existing outbox + NATS + BullMQ infra; eventual-consistent ~5-30 min; idempotent; auditable. |
| 2PC distributed transaction | Over-engineered for low-concurrency destructive op. Rejected. |
| Saga (formal state machine) | Over-engineered. Rejected. |
| Direct synchronous Medusa call | Split-brain risk on partial failure. Rejected. |

**Recommendation:** compensation + retry.

### G2-b — `OrderProjection.shippingAddressJson` strategy

| Option | Rationale |
|---|---|
| **Full-replace JSON `{anonymized: true}` (recommended)** | Simple, verifiable, no parsing complexity. Matches schema-inv recommendation. |
| Key-scrub JSON (walk + null specific keys) | Preserves shape; adds parsing complexity + schema-drift risk. |

**Recommendation:** full-replace.

### G2-c — `LoyaltyAccount` policy (NEEDS STAKEHOLDER PICK — product/legal)

| Option | Rationale |
|---|---|
| Delete-row entirely | Cleanest; eliminates linkability. May lose aggregate accounting context. |
| Scrub `customerId` linkage + reset balance to 0 | Preserves aggregate stats for accounting. May still be "tagged as anonymized customer's row" if linkability is forensically reconstructible. |
| Scrub `customerId` + retain balance + emit `loyalty.account.anonymized` event | Preserves all aggregate data. Highest forensic-replay value. Most coupling to downstream consumers. |

**Default recommendation (H3 task file):** scrub linkage + reset balance to 0. **Needs explicit product/legal pick.**

### G2-d — `OrderEventLog` append-only carve-out (NEW — surfaced by Compliance-Inv)

The `OrderEventLog` table is schema-declared as **append-only audit log**. LGPD Art. 18 §III ("eliminação dos dados pessoais tratados") does NOT exempt audit trails from erasure rights. Tension:

| Option | Rationale |
|---|---|
| **Full-replace `payload` JSON with `{anonymized: true}` (recommended)** | Honors LGPD erasure; audit trail loses payload-level forensic detail but retains row + timestamp + actor anonymized FK. |
| Carve-out: declare OrderEventLog payload exempt under "legitimate interest" (LGPD Art. 7 §IX) | Preserves full forensic replay; requires legal opinion that "audit-trail necessity" qualifies as legitimate interest. Higher ANPD audit risk. |
| Selective scrub: walk payload JSON, null only direct PII keys | Hybrid; complex; relies on knowing every key that could carry PII (high schema-drift risk). |

**Default recommendation:** full-replace. **Needs product/legal sign-off if carve-out is the desired posture.**

### G2-e — W7 remediation status (NEW — surfaced by Compliance-Inv as a verification gate)

The compliance investigator flagged the cancel-vs-resolve race + the JWT whitespace-bypass as items requiring W7 verification before H3 dispatch. **Both are actually closed** in this very session:
- Cancel-vs-resolve race: `df25dbf` (R2-2 SETNX mutex) + `4c82a22` (E2 Fix-b post-SETNX re-check)
- JWT whitespace-bypass: `fae8dc5` (R1-4 middleware/auth.ts trim)

**No action required for G2-e** — the investigator's flag was based on stale memory. Documented here to close the open question.

---

## H3 implementation plan (post-G2-pick)

**Sequencing — recommended:**

```
Wave A (parallel, 2 sub-agents):
  - Agent A1: in-process anonymize extension
    - Surfaces 1-7 (skip Medusa)
    - Per-surface strategy from G2-a/b/c/d picks
    - Atomic Prisma transaction
    - Audit-emit per surface
    
  - Agent A2: T4 conformance suite + PIIFixtureSpec builder
    - New Postgres testcontainer helper
    - PIIFixtureSpec interface
    - Pre/post snapshot + JSON-stringification scan
    - Initial 50-100 conformance assertions

Wave B (sequential, 1 sub-agent):
  - Agent B: Medusa cross-DB scrub
    - Emit customer.anonymize.medusa.pending after Wave-A Prisma commit
    - New subscriber: customer-anonymize-medusa-resolver.ts
    - BullMQ retry-pending job
    - Audit-emit customer.anonymize.medusa.confirmed
    - Cannot start until Wave A is integrated (depends on Prisma scrub completing first)

Wave C (parallel, 1 sub-agent + docs):
  - Agent C1: ANPD compliance doc refresh
    - New docs/compliance/lgpd-anonymize-coverage.md
    - Surface-by-surface coverage proof
    - Reference Wave-A + Wave-B commits
```

**Wall-clock estimate:**
- Wave A: ~1-2 days (in-process anonymize ~6-8h + T4 suite ~10-15h)
- Wave B: ~0.5-1 day (subscriber + retry + audit + tests)
- Wave C: ~2-3h
- **Total: ~3-4 days**

---

## Open risks + verifications-needed-before-implementation

1. **Medusa v2 API endpoint for customer scrub** — Cross-DB-Inv's best guess is `PATCH /admin/customers/{medusaId}`. Needs:
   - Confirmation that the endpoint exists in the deployed Medusa v2 version.
   - Confirmation of the field-set the endpoint accepts (name, email, phone, addresses, metadata).
   - If the endpoint only accepts partial updates, may need 2+ calls.
   
   **Recommend:** Wave-B sub-agent's first step is to verify the endpoint via `curl` to local Medusa testcontainer OR read the deployed Medusa version's API docs.

2. **Medusa customer `metadata` JSON undocumented PII** — Cross-DB-Inv flagged that integrations (Stripe-customer-id, third-party loyalty IDs, ...) may have written PII into the `metadata` blob without documentation. Needs:
   - Production audit of actual `metadata` content (sample 100 customers, classify keys).
   - Decision: scrub the whole `metadata` JSON, or selective key-scrub?
   
   **Recommend:** treat as G2-f (a 6th sub-decision) once the production audit lands. Could be deferred to a Wave-B follow-up if scrubbing whole-blob is acceptable for v1.

3. **T4 Docker availability in CI** — Test-Fixture-Inv flagged this as a CI prerequisite (mirrors the existing Redis testcontainer requirement). Should be fine since R2-2 and T6 already use testcontainers, but worth verifying CI YAML before Wave A's T4 lands.

---

## Sub-agent prompts (ready to spawn post-G2-pick)

Three sub-agent prompts ready to dispatch:

- **Wave A1 — In-process anonymize extension** — see [`h3-wave-a1-in-process-anonymize.md`](TBD — generate after G2 picks)
- **Wave A2 — T4 conformance suite + fixture builder** — see [`h3-wave-a2-t4-conformance.md`](TBD)
- **Wave B — Medusa cross-DB scrub** — see [`h3-wave-b-medusa-cross-db.md`](TBD)

The orchestrator will generate these per-wave task files (with full atomized scope, acceptance criteria, hard stops) once user picks the G2 sub-decisions.

---

## Synthesis observations (orchestrator-level)

Across the 4 investigators:

- **Convergence**: schema + compliance + cross-db + test-fixture all agree on the 7 in-process + 1 cross-DB surface partition. The H3 task file's original scope is structurally sound.
- **Divergence**: compliance investigator's institutional memory was a half-step stale (flagged closed items as open). The investigator-council pattern works — by cross-referencing the schema + recent commits, the orchestrator can correct this without re-spawning.
- **New scope revealed**: G2 expanded from 3 → 5 sub-decisions (OrderEventLog carve-out + W7 status — the latter is a verification rather than a real decision). Potentially 6 (Medusa `metadata` strategy) if the production audit surfaces undocumented PII.
- **Effort estimate stable**: 3-4 days is consistent with the original H3 task file estimate. The expanded scope (G2-d) is a doc/policy decision, not implementation overhead.
- **No major surprises** — schema + cross-DB + test-fixture all came back close to the H3 task file's expectations. The investigation was efficient.

---

## Recommended next action

**Surface the 4 G2 sub-decisions (a/b/c/d — skip e as already-closed) to the user** with default recommendations. Once picked, the orchestrator generates the 3 wave-specific task files and dispatches Wave A in parallel + queues Wave B for post-Wave-A.
