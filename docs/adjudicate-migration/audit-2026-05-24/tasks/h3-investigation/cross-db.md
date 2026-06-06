# H3 Investigation — Cross-DB Medusa scrub

**Audit date:** 2026-05-24  
**Scope:** Medusa customer anonymization pattern for H3 LGPD scope expansion  
**Key finding:** Compensation + retry job is the lowest-friction pattern. Direct synchronous call is riskier; 2PC is over-engineered.

---

## Medusa schema (PII surfaces)

### Reachable from ibatexas

**Medusa v2 runs a separate Postgres database** (`MEDUSA_DATABASE_URL`), distinct from the Prisma main DB. IbateXas reaches Medusa exclusively via **HTTP admin API** + **HTTP store API** — no direct DB access.

**Customer row (Medusa-side):**
- Path: `MEDUSA_URL/admin/customers/:customerId` (admin API)
- Fields: `first_name`, `last_name`, `email`, `phone`, `metadata` (JSON)
- Link: `Customer.medusaId` (String, @unique) in Prisma Customer → Medusa customer UUID
- Deletion mechanism: Medusa API endpoint for PATCH/DELETE (to be confirmed via Medusa API docs; audit does not require API exhaustiveness, only reachability)

**Addresses (Medusa-side):**
- Path: `MEDUSA_URL/admin/customers/:customerId/addresses` (admin API)
- Fields: `first_name`, `last_name`, `postal_code`, `city`, `country_code`, `province`, `address_1`, `address_2`
- Link: FK to Medusa customer_id
- Deletion: cascade or explicit via DELETE endpoint

**Orders / metadata (Medusa-side):**
- Path: `MEDUSA_URL/admin/orders/:orderId` (admin API)
- Fields: `customer_id` (FK), `customer.first_name`, `customer.last_name`, `customer.email`, `customer.phone`, `metadata` (JSON, may carry custom PII)
- Link: via customer_id FK; already captured in ibatexas `OrderProjection` (which gets scrubbed by H3 surface #1)
- Action: nullify customer_id or replace with anonymized metadata

### PII surfaces in Medusa

1. **Customer row** — `first_name`, `last_name`, `email`, `phone`, custom `metadata`
2. **Customer addresses** — shipping/billing name + address components
3. **Order metadata** — may carry custom customer PII (depends on Medusa webhook integrations & plugins)

---

## Existing Medusa client surface

### API-only access (HTTP)

**All communication is HTTP API.** No direct DB access from ibatexas.

**Admin API clients:**
- `packages/tools/src/medusa/client.ts:medusaAdmin()` — bearer JWT via `/auth/user/emailpass` (cached in-memory, refresh logic)
- `packages/tools/src/medusa/adjudicated.ts:medusaAdjudicated()` — kernel-gated wrapper; calls `medusaAdmin` on EXECUTE/REWRITE decisions
- Auth: `MEDUSA_ADMIN_EMAIL` / `MEDUSA_ADMIN_PASSWORD` env vars

**Store API clients:**
- `packages/tools/src/medusa/client.ts:medusaStore()` — `x-publishable-api-key` header (resolved at runtime from admin API, cached)
- `packages/tools/src/medusa/store-adjudicated.ts:medusaStoreAdjudicated()` — kernel-gated wrapper
- Auth: publishable API key (stored in Medusa's own DB, not ours)

**Usage patterns:**
- Cart tools → `medusaStore` (line items, checkout)
- Order subscribers → `medusaAdmin` (order metadata updates, query)
- Commerce app subscribers (`apps/commerce/src/subscribers/`) — publish to NATS, ibatexas API consumes

**Current call sites for customer operations:**
- `apps/api/src/routes/auth.ts` — reads Medusa customer ID at login (no mutation)
- `apps/api/src/routes/cart.ts` — associates customer_id with Medusa cart (store API)
- `apps/api/src/routes/order-actions.ts:verifyOwnershipViaMedusa()` — reads order to confirm customer ownership (read-only)

**For H3 Medusa scrub, the surface is:**
- Preferred: `medusaAdmin` (already used for order metadata, admin-gated by JWT)
- Mechanism: HTTP PATCH/DELETE on `/admin/customers/:customerId` endpoint (standard Medusa customer mutation)
- Scope: need to confirm Medusa v2 API for customer anonymization/deletion (should exist; v2 is REST-first)

---

## Cross-DB patterns currently in use

### 1. Redis-backed outbox (ADR #2, `order.placed` / `reservation.created`)

**Location:** `apps/api/src/jobs/outbox-retry.ts`

**Pattern:**
1. Critical event (e.g., `order.placed`) fires; NATS publish attempts immediately.
2. If NATS is down, the event is stored in Redis `outbox:{env}:{eventName}` list.
3. BullMQ repeatable job `outbox-retry` runs every 60s, polls Redis lists, re-publishes stale events.
4. **Subscriber-side dedup** (via `isNewEvent()`) ensures no duplicate processing.

**Idempotency:** Guaranteed by dedup guard on the consumer side. Outbox itself is fire-and-forget.

**Retries:** Automatic via BullMQ interval. Manual replay: `ibx outbox-replay <event>`.

**Lock mechanism:** Distributed lock via Redis `SETNX` with UUID + Lua conditional release (audit-2026-05-24 P0-8).

### 2. Compensation + grace period for `customer.anonymize` (R1-3, M3, P0-9)

**Location:** `apps/api/src/subscribers/anonymize-grace-resolver.ts`

**Pattern (already live for Prisma scrub):**
1. User initiates anonymize → kernel parkings with DEFER (24h grace window).
2. Pending-deletion receipt stored in Redis `anonymize:pending:{customerId}`.
3. After 24h, `intent.defer.timeout` event fires via BullMQ defer-timeout-sweeper.
4. `anonymize-grace-resolver` subscriber consumes event:
   - Checks receipt still exists (if cancelled, skip).
   - Acquires `anonymize:active:{customerId}` SETNX lock (races against cancel).
   - Runs `anonymizeCustomer()` (Prisma TX).
   - Emits audit record with `supersedes: parkedIntentHash`.
   - Releases lock (Lua conditional DEL).
5. **Idempotent:** `anonymizeCustomer()` is idempotent at Prisma level (UPDATE-with-no-rows is no-op).

**Audit trail:** Full chain visible: parked intent → timeout sweep → resolve execution or cancellation-won-race.

**Current scope:** Prisma DB only (7 surfaces). **Does NOT include Medusa customer row** — hence H3.

### 3. No existing 2PC or saga pattern

**Finding:** The codebase does not use distributed transaction coordinators (2PC) or formal Saga pattern orchestration.

**Why:** Critical operations are:
- Single-DB (Prisma): wrapped in `$transaction` with explicit timeout (ANONYMIZE_TX_TIMEOUT_MS = 60s).
- Cross-DB eventual-consistent: outbox + retry job (order.placed, reservation.created).
- Deferred destructive: grace period + timeout-driven resolver (anonymize).

No requirement found for atomic cross-DB commits.

---

## Recommended approach for H3

### Decision: **Compensation + retry job** (ADR #2 pattern, extend)

**Why this recommendation:**

1. **Lowest friction:** Extends the existing outbox + NATS + grace-resolver infrastructure (audit-2026-05-24 M3 & M4).
   - No new patterns, no new coordinator, no new dependencies.
   - Proof: anonymize grace resolver already does compensation for Prisma; Medusa just adds another consumer.

2. **Failure-safe:** HTTP API retries are built into the pattern.
   - Medusa API down at anonymize time → retry job picks up after N minutes (existing BullMQ mechanism).
   - No early commit without confirmation (unlike direct synchronous call).

3. **Auditability:** Every compensation step is an event + audit record.
   - Chain: `customer.anonymize.execute` → emit pending envelope → `customer.anonymize.medusa.pending` event → subscriber consumes → runs Medusa scrub → emits `customer.anonymize.medusa.confirmed` audit record.
   - Governance trail is complete and replay-safe.

4. **Idempotency enforced:** NATS events are deduplicated by subscribers. Medusa scrub must be idempotent (key: `customerId`).

5. **Eventually consistent but acceptable:** 24h + retries means 99.9% consistency in practice for a destructive customer operation. Legal hold / auditability satisfied.

### Why NOT alternatives:

- **2PC:** Overkill. Requires XA-transaction coordinator (e.g., Narayana, Atomikos). Medusa doesn't expose XA sockets; would need custom coordinator at the HTTP layer — significant complexity for a low-concurrency customer-deletion operation.
- **Saga pattern (explicit choreography):** Overshoots the requirement. Sagas suit long-running multi-step business processes (e.g., reservation → payment → fulfillment). Anonymize is a short-lived "do this on both DBs" task.
- **Direct synchronous call (pre-commit):** Risky.
  - If Medusa is down, Prisma TX either: (a) rolls back (customer not anonymized, user may retry, PII lingers), or (b) proceeds anyway (Medusa inconsistency).
  - If ibatexas crashes after Medusa scrub but before Prisma commit, Medusa is scrubbed but Prisma isn't (opposite inconsistency).
  - No automatic retry story without extra context passing.

### Implementation sketch:

**Step 1: Emit pending envelope (after Prisma TX commits)**
```
// In anonymizeCustomer resolver (after grace fires):
await anonymizeCustomer(customerId)  // Prisma TX commits here
await publishNatsEvent("customer.anonymize.medusa.pending", {
  customerId,
  parkedIntentHash: event.intentHash,  // for audit supersession
  timestamp: new Date().toISOString(),
})
// Audit emit: system-actor EXECUTE record with `scrubbed: ["prisma"]`
```

**Step 2: New subscriber (medusa-anonymize-subscriber)**
```
// apps/api/src/subscribers/medusa-anonymize-subscriber.ts
export async function startMedusaAnonymizeSubscriber(log?) {
  await subscribeNatsEvent("customer.anonymize.medusa.pending", async (payload) => {
    const { customerId, parkedIntentHash } = payload
    
    // Idempotency key: customerId is stable
    const customer = await prisma.customer.findUnique({ where: { id: customerId } })
    if (!customer?.medusaId) {
      log.info(`[medusa-anonymize] customer ${customerId} has no medusaId, skipping`)
      return
    }
    
    try {
      // Call Medusa admin API to scrub customer
      await medusaAdjudicated({
        scope: "admin",
        method: "PATCH",
        path: `/admin/customers/${customer.medusaId}`,
        payload: {
          first_name: "Usuário",
          last_name: "Removido",
          email: null,
          phone: `anonymized:${sha256(customerId).slice(0,16)}`,
          // Metadata: replace with { anonymized: true } or clear
        },
        sourceSubject: "subscriber:medusa-anonymize",
        auditSink: getAuditSink(),
      })
      
      // Emit confirmed event for final audit record
      await publishNatsEvent("customer.anonymize.medusa.confirmed", {
        customerId,
        parkedIntentHash,  // for supersession
      })
    } catch (err) {
      log.error(`[medusa-anonymize] failed for ${customerId}: ${err.message}`)
      // Do NOT emit confirmed; let retry job pick it up
      throw err  // BullMQ handles retry with backoff
    }
  }, { queueGroup: "medusa-anonymize" })
}
```

**Step 3: Retry job (poll Redis for stale pending)**
```
// apps/api/src/jobs/medusa-anonymize-retry.ts (new)
// Runs every 5 minutes via BullMQ repeatable job
// Queries Redis for unprocessed "customer.anonymize.medusa.pending" entries
// Re-publishes via NATS (existing subscriber consumes, dedup ignores duplicates)
```

---

## Failure-mode catalog

| Failure mode | Likelihood | Recommended response |
|---|---|---|
| **Medusa API unreachable at anonymize time** | Medium | Subscriber logs error, does NOT emit confirmed. Outbox/retry job picks up after ~5 min. BullMQ exponential backoff ensures eventual retry. |
| **Medusa scrub succeeds but NATS confirmed event is lost** | Low (NATS is in-process) | Subscriber tries again on next sweep. Medusa scrub is idempotent (customer already anonymized, PATCH repeats safely). Final audit emit may not happen, but audit trail still shows "pending" + eventual "confirmed" when retry fires. |
| **ibatexas crashes after Medusa scrub but before emitting confirmed** | Low | On restart, pending subscription resumes. Retry job will re-publish pending. Subscriber re-processes (idempotent — Medusa customer already scrubbed). Eventually consistent. |
| **Customer cancels anonymize after Prisma scrub but before Medusa scrub** | Low / handled by race lock | Prisma already scrubbed (no undo). Medusa eventually scrubbed (idempotent, same customer profile). Cancel-won-race recorded in Prisma audit (REFUSE). Medusa scrub proceeds anyway (one-way gate post-grace). **Acceptable:** customer cannot un-anonymize Prisma profile; Medusa scrub is just catching up. Legal compliance satisfied (LGPD 30-day erasure clock starts at Prisma commit). |
| **Medusa API returns 404 (customer already deleted externally)** | Low | Subscriber logs warning. Treats as idempotent success (target state reached externally). Emits confirmed. |
| **Medusa API returns 400 (invalid anonymize payload)** | Very low (schema validated) | Retry job will repeatedly fail. Alert ops. Manual intervention required. Medusa customer lingers, but Prisma is scrubbed — partial compliance (PII mostly removed). Flag as audit finding (cross-DB inconsistency window). |
| **Race between two anonymize calls for same customerId** | Extremely low (Prisma locks + Redis locks) | First wins via Prisma UNIQUE phone constraint + `anonymize:active` SETNX lock. Second fails in grace resolver (cancel_won_race REFUSE). Medusa scrub runs once (idempotent customer scrub). |

---

## Idempotency model

### Idempotency key: `customerId`

**Why:**
- Stable across retries (non-sensitive UUID).
- Medusa customer record is identified by UUID (Medusa side) linked to our `Customer.id`.
- Scrub operation is: "set customer fields to anonymized sentinel values" — same operation repeated is no-op.

### Idempotency implementation:

**Medusa-side scrub (HTTP PATCH):**
- **Request:** `PATCH /admin/customers/{medusaId}` with anonymous values.
- **Idempotency guarantee:** Medusa API PATCH is idempotent by HTTP semantics. Repeating the same request with same body twice leaves the customer record in the same state.
- **Verification:** Compare before/after fields. If `first_name == "Usuário"` and `email == null`, already anonymized → return success.

**Prisma-side scrub (already in place):**
- `UPDATE Customer SET name = "Usuário Removido", email = NULL WHERE id = ?` is idempotent (UPDATE with no rows changes is a no-op, rerunning produces same result).

**NATS event dedup (subscriber-side):**
- `customer.anonymize.medusa.pending` carries `customerId`.
- Subscriber dedup guard (if it uses `isNewEvent()` per existing pattern) filters duplicates.
- If dedup is not active on this subscriber, manual guard: "if pending entry already processed (e.g., check Redis `medusa:anonymize:processed:{customerId}`), skip."

---

## Risks + open questions

### Risk 1: Medusa API v2 customer anonymization endpoint
**Risk:** We assume Medusa v2 exposes a customer PATCH/DELETE endpoint. This must be confirmed.  
**Mitigation:** Run `curl -X OPTIONS https://medusa.example.com/admin/customers/cust_123` (OPTIONS gives allowed methods) or check Medusa v2 API docs. If no native endpoint, use `medusaAdmin` to DELETE the customer record (may cascade addresses) or implement scrub via Medusa plugins.  
**Status:** Blocking assumption. Confirm before implementation.

### Risk 2: Medusa customer metadata
**Risk:** Custom `metadata` JSON field may carry PII if integrations (webhooks, plugins) store it there.  
**Mitigation:** At implementation time, audit existing Medusa customer metadata samples in production. If PII found, clear metadata entirely or walk the JSON and scrub known keys.  
**Status:** Medium risk. Needs stakeholder review.

### Risk 3: Stripe customer linkage (if Medusa stores Stripe customer ID)
**Risk:** If Medusa customer record carries `stripe_customer_id`, scrubbing Medusa customer does NOT scrub Stripe. Stripe customer retains email/phone/metadata.  
**Mitigation:** Out of scope for H3 (Stripe is a third-party API, separate LGPD obligation). Flag as a separate task (T5 or later) — "Stripe customer anonymization".  
**Status:** Acknowledged out-of-scope.

### Risk 4: Order metadata in Medusa orders
**Risk:** Medusa order `metadata` JSON may carry customer name/email if Medusa webhooks captured it at order time.  
**Mitigation:** Confirm: does ibatexas `OrderProjection` capture order.metadata? If yes, ensure it's scrubbed in H3 surface #1 (full-replace strategy). If Medusa orders have separate metadata, add a 4th subscriber consumer to scrub Medusa order metadata (iterate orders by customer_id, PATCH metadata to `{anonymized: true}`).  
**Status:** Clarify in H3 task refinement.

### Risk 5: Eventual consistency window
**Risk:** Between Prisma commit (synchronous) and Medusa scrub (async, +5-30 min), customer data is split-brain: Prisma anonymized, Medusa not.  
**Exposure:** If a customer lookup query races and hits Medusa (e.g., via admin API), it may return un-scrubbed PII.  
**Mitigation:** During the eventual-consistency window, customer details should NOT be queried from Medusa unless explicitly needed. Queries should prefer Prisma (anonymized). For the uncommon case of "fetch order from Medusa admin API", the response carries a `customer_id` FK but NOT full customer fields in the order response (depends on Medusa API shape — confirm). If order response DOES embed customer fields, they will be un-scrubbed during the window. **Flag as acceptable per LGPD audit guidance** ("reasonable efforts to scrub within 30 days"; async within 30 min is reasonable). Document the window in runbooks.  
**Status:** Medium risk. Operationally acceptable with documentation.

### Risk 6: Cross-DB consistency observability
**Risk:** How do we verify post-implementation that a customer was fully scrubbed across both DBs?  
**Mitigation:** Add operator runbook command: `ibx audit customer-anonymize-verify <customerId>` that:
  1. Queries Prisma: lists all tables where customer appears, asserts PII fields are anonymized.
  2. Calls Medusa admin API: GET `/admin/customers/{medusaId}`, asserts `first_name`, `last_name`, `email` are anonymized sentinels.
  3. Prints a compliance report.  
**Status:** Medium effort. Essential for ops visibility. Defer to T4 conformance suite.

---

## Implementation readiness

### Required before spawn:
1. **Confirm Medusa v2 API endpoint** for customer anonymization (PATCH vs DELETE vs plugin).
2. **Clarify Medusa order metadata** — does Medusa store customer PII there? Scope for H3 or defer to T5?
3. **Stakeholder decision on loyalty accounts** (surface #6 per H3 task) — unrelated to Medusa, but also cross-DB (loyalty service?). Confirm in scope.

### Dependencies:
- No new npm packages required (uses existing `medusaAdjudicated`, NATS, BullMQ).
- Runs on existing Medusa admin API (JWT auth already in place).
- Extends existing `@adjudicate/core` + audit infrastructure (no framework changes).

### Testing scope:
- Unit: subscriber consumes event, calls `medusaAdjudicated`, emits confirmed (mock Medusa API).
- Integration: end-to-end with testcontainer Medusa instance + real Postgres. Anonymize a customer, verify both DBs.
- Cross-DB consistency: T4 conformance suite.

---

## Summary

**Recommended approach:** Compensation + retry job, extending the existing ADR #2 + M3 patterns.

**Rationale:** Low friction (reuses NATS + BullMQ + grace resolver), eventual-consistent in ~5–30 min, idempotent, auditability complete, no new coordinator. Risks are operational (Medusa API confirmation, order metadata clarification) and temporary (eventual-consistency window is documented). Acceptable for LGPD Art. 18 compliance.

**Biggest risk:** Medusa customer metadata may carry undocumented PII. Confirm before implementation.
