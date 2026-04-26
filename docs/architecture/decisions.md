# Architecture Decisions

> Load-bearing decisions that must not be reverted without understanding why they exist.

---

## Decisions

### 1. Redis Roles + Circuit Breaker

Redis serves seven roles: sessions, rate limiting, query/embedding cache,
WhatsApp state, abandoned cart tracking, intelligence sorted sets, and
review-prompt scheduling.

**Mitigated:** Circuit breaker (`packages/tools/src/redis/circuit-breaker.ts`)
trips after N consecutive failures. `safeRedis` wrapper: critical ops throw
`CircuitOpenError`, non-critical return null. Configurable via
`REDIS_CB_FAILURE_THRESHOLD` and `REDIS_CB_RESET_TIMEOUT_MS` env vars.

### 2. NATS Core vs JetStream

Docker Compose enables JetStream but application uses Core NATS (fire-and-forget).
Redis-backed outbox covers `order.placed` and `reservation.created` only.
Full JetStream migration is a post-launch item (EVT-001).

### 3. Cascade-to-Restrict on TimeSlot Relations

`TimeSlot -> Reservation` and `TimeSlot -> Waitlist` use `onDelete: Restrict`.
Deleting a time slot requires explicitly handling active reservations first.
**This is a load-bearing schema decision that must not be reverted.**

### 4. Three-Layer customerId Defense Model

1. **Auth middleware** (`requireAuth`) — validates JWT, sets `request.customerId`
2. **Tool registry** (`withCustomerId`) — injects `ctx.customerId`, always overriding LLM-supplied values
3. **Domain service** (`assertOwnership`) — verifies entity ownership matches caller

### 5. Reservation TOCTOU Fix

Availability check runs inside `$transaction` with `SELECT FOR UPDATE` on TimeSlot.
DB constraints: `CHECK (reserved_covers >= 0)` and `CHECK (reserved_covers <= max_covers)`.

### 6. Startup Ordering

NATS subscribers MUST register before background jobs start. Sequence:
`startCartIntelligenceSubscribers()` → then all BullMQ workers.

### 7. Hybrid State-Flow Architecture (XState)

WhatsApp bot moved from a monolithic LLM prompt (3,400 tokens, all rules every turn)
to a Hybrid State-Flow architecture using XState v5.

**Why XState:** The LLM was hallucinating business rules (asking WhatsApp users to login,
ignoring time-based availability, using multiple emojis). Moving business logic into a
deterministic state machine eliminates these failures entirely.

**The 4-layer pipeline:**
1. **Router** — keyword regex extracts structured events from messages (no LLM cost)
2. **State Machine (XState)** — processes events with guards, executes side effects (cart tools)
3. **Prompt Synthesizer** — maps machine state to a tiny prompt (~200-400 tokens)
4. **Response Agent (Claude)** — generates natural language only, no business decisions

**Key design decisions:**
- Cart/checkout tools are NEVER exposed to the LLM — state machine calls them as side effects
- XState snapshot persisted to Redis (`wa:machine:{sessionId}`, 24h TTL) for stateless handling
- Guards are deterministic: `isAvailableNow`, `isAuthenticated`, `isInDeliveryZone`
- Token reduction: 3,400 → ~400 tokens/turn (88% savings)
- Machine definition: `packages/llm-provider/src/machine/order-machine.ts`
- Full design: [docs/architecture/design/hybrid-state-flow.md](design/hybrid-state-flow.md)

### 8. Conversation Persistence via CDC

WhatsApp/web conversations were stored only in Redis with 24-48h TTL. No durable log existed for debugging, analytics, or admin visibility.

**Decision:** CDC (Change Data Capture) pattern — `appendMessages()` publishes a NATS event (`conversation.message.appended`) after writing to Redis. A subscriber (`conversation-archiver.ts`) writes to Postgres asynchronously. Redis stays the hot path for the LLM.

**Consequences:**
- Postgres becomes the durable conversation archive (queryable via `ibx chat dump --source postgres`)
- If NATS or the subscriber is down, conversations are still served from Redis but not archived until recovery
- Core NATS (not JetStream) means no guaranteed delivery — acceptable for v1. The conversation is always in Redis; Postgres is best-effort
- `meta` parameter added to `appendMessages()` (backward-compatible, optional) carries customerId and channel for the archive
- 11 scenario integration tests cover the conversation flows that keep breaking in production

**Files:**
- Publisher: `apps/api/src/session/store.ts` (fire-and-forget NATS publish)
- Subscriber: `apps/api/src/subscribers/conversation-archiver.ts`
- Domain service: `packages/domain/src/services/conversation.service.ts`
- CLI: `packages/cli/src/commands/chat.ts` (`ibx chat list/dump/clean/scenarios`)
- Tests: `packages/llm-provider/src/__tests__/scenarios/` (11 fixtures)

### 9. Intent-Gated Execution (IBX-IGE) — formerly "Zero-Trust LLM Architecture"

The system evolved from "LLM calls tools directly" to **Intent-Gated Execution**
— a framework where the LLM is a semantic parser with zero authority to mutate
state and a deterministic kernel decides what executes. Extracted from
IbateXas into the reusable `@adjudicate/*` framework (v1.0).

**Renaming rationale:** "Zero-Trust LLM" is industry-overloaded to mean "zero
trust in LLM output" (content safety). What we actually do is give the LLM
zero *authority*. "Intent-Gated Execution" (IGX, KAIJU 2026) is the named
research direction; we align with that vocabulary to be findable.

**Prior art & convergent research (2025–2026):**
- **CaMeL** ([arXiv 2503.18813](https://arxiv.org/abs/2503.18813), DeepMind, March 2025) — privileged LLM emits sandboxed DSL; custom interpreter enforces capability-based flow. Closest conceptual match; our `IntentEnvelope` + `adjudicate()` is the typed-intent variant of CaMeL's code-sandbox approach.
- **FIDES** ([arXiv 2505.23643](https://arxiv.org/abs/2505.23643), Microsoft, May 2025) — deterministic information-flow control with confidentiality/integrity labels. Inspires our v1.1 field-level `TaintedValue<T>` roadmap.
- **KAIJU** (arXiv 2604.02375, April 2026) — coins "Intent-Gated Execution (IGX)". Nearly a 1:1 restatement of our pattern with integer intent tags instead of typed envelopes.
- **Microsoft Agent Governance Toolkit** (open-sourced April 2026) — GovernanceKernel is the closest commercial analog to our `adjudicate()` — same split, policy-as-data instead of typed-intent vocabulary.
- **OWASP LLM06 (Excessive Agency)** + **OWASP Agentic Top 10 2026 ASI01/02/03/05** — our pattern directly addresses these.

**Problem (original):** Red Team audit found that the LLM could call mutating
tools directly, bypassing the XState machine's business-logic guards. A
prompt injection could trigger fraudulent orders.

**Decision — 8-layer defense (IBX-IGE v1.0):**
1. **Tool Classification** — type-enforced READ_ONLY vs MUTATING partition
2. **Prompt Synthesizer / Capability Planner** — structurally filters MUTATING tools from the LLM's visible tool list (security-sensitive, separated from the cosmetic PromptRenderer)
3. **Intent Vocabulary** — LLM emits typed `IntentEnvelope<kind, payload>` with `intentHash` + taint; never calls mutating functions directly
4. **Kernel Adjudicator** — pure function `(envelope, state, policy) → Decision`, 6-valued: `EXECUTE | REFUSE | ESCALATE | REQUEST_CONFIRMATION | DEFER | REWRITE`
5. **State Machine Gate** — XState decides transition legality; kernel consults it
6. **Taint Lattice** — `SYSTEM > TRUSTED > UNTRUSTED` with `canPropose()` gating per intent kind
7. **Execution Ledger + Audit Sinks** — hot-path replay dedup (Redis, `intentHash` keyed) vs durable governance trail (Console/NATS/Postgres sinks); the two are intentionally distinct
8. **Structured Refusal** — stratified `SECURITY | BUSINESS_RULE | AUTH | STATE`, first-class output, never an exception

**Load-bearing invariants (verified by property tests in [`@adjudicate/core/kernel`](../../packages/core/tests/kernel/invariants/)):**
- UNTRUSTED never yields EXECUTE when policy demands TRUSTED+
- Unknown envelope versions always REFUSE with `schema_version_unsupported`
- Same `intentHash` submitted twice → second call returns LedgerHit, no double execution
- Every basis.code is drawn from `BASIS_CODES[category]` — no free-form strings
- REWRITE stays in scope (sanitization/normalization/safe-capping only; never business transformation)

**Consequences:**
- `post_order` refactored from flat state to compound: `idle`, `cancelling`, `amending`, `regenerating_pix`
- Kernel executor handles post-order mutations deterministically
- Prompts rewritten: no "CHAME" (call) directives for mutating tools; LLM uses "consulte" (consult) for read-only
- Event injection whitelist: only `PIX_DETAILS_COLLECTED` and `SET_NAME` allowed post-LLM
- `apps/api` consumes `@ibatexas/llm-provider` for `runOrchestrator` + commerce-specific glue and `@adjudicate/runtime` for the generic defer-resume utilities; the framework packages have no IbateXas-specific dependencies.
- `@adjudicate/*` packages are domain-independent substrate; second-domain scaffold (clinic) builds in under a day without forking (see [`packages/runtime/examples/clinic/`](../../packages/runtime/examples/clinic/))

**Packages:**
- [`@adjudicate/core`](../../packages/core/README.md) — types + lattice + `BASIS_CODES` (top-level), `adjudicate()` + `PolicyBundle` + combinators (`./kernel`), `CapabilityPlanner` + `ToolClassification` + `PromptRenderer` (`./llm`)
- [`@adjudicate/audit`](../../packages/audit/README.md) — ledger + audit sinks + replay
- [`@adjudicate/audit-postgres`](../../packages/audit-postgres/README.md) — reference Postgres sink
- [`@adjudicate/runtime`](../../packages/runtime/README.md) — `resumeDeferredIntent` + `deadlinePromise` for orchestrators

**Files (legacy, still host the concrete implementation in v1.0 per the plan's open decision on v2.0 split timing):**
- Classification: `packages/llm-provider/src/machine/types.ts` (`TOOL_CLASSIFICATION`, `ALLOWED_POST_LLM_EVENTS`)
- Intent bridge: `packages/llm-provider/src/tool-registry.ts` (envelope wrapping in `executeTool`)
- State gate: `packages/llm-provider/src/llm-responder.ts` (`processToolCalls` + ledger + audit wiring)
- Machine: `packages/llm-provider/src/machine/order-machine.ts` (post_order sub-states)
- Kernel: `packages/llm-provider/src/kernel-executor.ts` (cancel/amend/pix handlers)

**Feature flags:**
- `IBX_LEDGER_ENABLED=true` — shadow writes to the execution ledger
- `IBX_LEDGER_ENFORCE=true` — ledger authoritative on the write path (dedup enforced)

### 10. Ownership-Based Redis Locks

All distributed locks (WhatsApp agent lock, web chat lock) now use UUID lock values with Lua conditional release scripts.

**Problem:** Red Team audit found that `releaseAgentLock()` did a plain `redis.del()` without verifying ownership. If the heartbeat failed and the lock expired, a second agent could acquire it, then the first agent would delete the second agent's lock on completion — cascading breach.

**Decision:** Store `crypto.randomUUID()` as lock value. Release via Lua: `if GET == myValue then DEL`. Heartbeat extends via Lua: `if GET == myValue then EXPIRE`. Web chat lock now has 10s heartbeat (was missing).

**Files:**
- WhatsApp: `apps/api/src/whatsapp/session.ts` (`acquireAgentLock`, `releaseAgentLock`)
- Web: `apps/api/src/streaming/execution-queue.ts` (`acquireWebAgentLock`, `releaseWebAgentLock`)

---

## Cross-Cutting Concerns

### Authorization

- **Customers:** Twilio Verify WhatsApp OTP → JWT (httpOnly cookie, 4h expiry) + refresh token (30-day, single-use rotation)
- **Staff:** Same OTP flow, differentiated by role (OWNER/MANAGER/ATTENDANT), 8h JWT, no refresh token
- **Admin:** `x-admin-key` header (timing-safe comparison) + server-side Next.js middleware
- **Guests:** Anonymous sessions in Redis (48h TTL), promoted to customer at checkout
- **JWT revocation:** Redis-based `jwt:revoked:{jti}` with TTL = remaining lifetime, checked in `extractAuth`
- JWT revocation and SSE stream ownership now fail closed (503) when Redis is unreachable.

### Rate Limiting

All rate limiters use atomic `atomicIncr()` Lua script (`packages/tools/src/redis/atomic-rate-limit.ts`).
Prevents TTL-less keys if process crashes between INCR and EXPIRE.

### Content Type Parsers

Stripe and WhatsApp webhook routes use scoped content type parsers via
`fastify.register()` with prefix encapsulation. They do NOT replace global parsers.

### 11. Stripe Card Payment — Embedded PaymentElement

**Decision:** Use Stripe's React PaymentElement (`@stripe/react-stripe-js`) for the web checkout card form instead of Stripe Checkout (hosted page) or a custom card input.

**Why:**
- PCI-DSS compliance is delegated to Stripe (card data never touches our servers)
- PaymentElement supports 3D Secure / SCA natively
- User stays on our site (no redirect to Stripe-hosted checkout)

**Implementation:**
- `CardPaymentForm.tsx` wraps `<Elements>` + `<PaymentElement>`, calls `stripe.confirmPayment()`
- `CheckoutContent.tsx` has a `card_form` stage: backend returns `clientSecret` → form renders → success redirects to `/pedido/{pi_id}`
- `stripe-return/page.tsx` handles 3DS redirect returns (reads `payment_intent` query param)
- Backend (`create-checkout.ts`) returns `stripeClientSecret` for card payments — no changes needed

**Env var:** `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (required in `apps/web`).

### 12. Order/Billing Lifecycle Separation

**Decision:** Decouple Order fulfillment and Payment into independent state machines coordinated by NATS events. Payment becomes its own bounded context ("Billing") with a dedicated `Payment` table, separate from `OrderProjection`.

**Why:**
- PIX expiry was canceling orders — losing the customer's cart. Now PIX expiry only transitions the payment to `payment_expired`; the order stays alive for retry/method switch.
- Payment status was an untyped `String?` on `OrderProjection` with no transition validation, no audit trail, and no concurrency control.
- Race condition between PIX expiry checker and Stripe webhook (both reading "pending", both proceeding) — now resolved via distributed lock on `paymentId`.
- Web customers had no post-order actions (cancel, amend, retry, notes) — WhatsApp only.
- Industry standard: Uber Eats, DoorDash, iFood, Toast POS all treat Order and Payment as independent state machines.

**Key design choices:**
- **One active payment per order** — enforced by partial unique index + application guard. Retry/regeneration creates a NEW Payment row; old one stays terminal for audit trail.
- **Terminal per-attempt**: `payment_failed` and `payment_expired` are terminal for that Payment row. This keeps clean attempt history and makes analytics trivial (count Payment rows = attempt count).
- **`switching_method` transitional state** — blocks webhook processing during atomic method switches. Prevents partial state corruption.
- **Cash flow**: `awaiting_payment` → `cash_pending` → `paid` (admin/driver explicitly confirms). Separates "intent to pay cash" from "cash received".
- **Optimistic concurrency** via `version` field + `PaymentConcurrencyError`. Distributed lock (`lock:payment:{paymentId}`) for contested operations (webhook vs expiry checker).
- **CQRS**: `PaymentCommandService` (create, transition, reconcile) + `PaymentQueryService` (getById, getActive, listByOrder, getByStripePI).
- **Forward-only transition matrix** in `@ibatexas/types` — `canTransitionPayment()` validates all transitions.
- **Cross-context pointer**: `OrderProjection.currentPaymentId` points to the active Payment row, updated atomically on creation/switch.

**NATS events:**
- `payment.status_changed` — published on every transition (webhook reconciliation, expiry, retry, cancel)
- `payment.method_changed` — published on payment method switch
- Subscriber `payment-lifecycle.ts` auto-confirms orders on `paid`, cancels orders on `refunded`

**Migration:**
- Prisma schema adds `Payment`, `PaymentStatusHistory`, `OrderNote` models + `PaymentStatus` enum
- Backfill creates Payment rows from existing `OrderProjection.paymentStatus`/`paymentMethod` using `system_backfill` actor
- Legacy fields kept on `OrderProjection` during transition period

