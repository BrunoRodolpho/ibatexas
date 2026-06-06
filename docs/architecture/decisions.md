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

### 7. Hybrid State-Flow Architecture (XState) — SUPERSEDED

> **Superseded by the claustrum-on-dev cutover.** The XState machine and the
> `@ibatexas/llm-provider` package described here were **deleted**; the
> conversational turn now runs through the `@claustrum` Conductor (see ADR #9
> "Files (current)" and CLAUDE.md rule #9). Retained for historical context.

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
- `apps/api` runs the conversational turn through the `@claustrum` Conductor (composition root `apps/api/src/claustrum-bootstrap.ts`) and uses `@adjudicate/runtime` for the generic defer-resume utilities; the framework packages have no IbateXas-specific dependencies. (The legacy `@ibatexas/llm-provider` brain that previously hosted `runOrchestrator` was deleted in the claustrum-on-dev cutover.)
- `@adjudicate/*` packages are domain-independent substrate; second-domain scaffold (clinic) builds in under a day without forking (see [`packages/runtime/examples/clinic/`](../../packages/runtime/examples/clinic/))

**Packages:**
- [`@adjudicate/core`](../../packages/core/README.md) — types + lattice + `BASIS_CODES` (top-level), `adjudicate()` + `PolicyBundle` + combinators (`./kernel`), `CapabilityPlanner` + `ToolClassification` + `PromptRenderer` (`./llm`)
- [`@adjudicate/audit`](../../packages/audit/README.md) — ledger + audit sinks + replay
- [`@adjudicate/audit-postgres`](../../packages/audit-postgres/README.md) — reference Postgres sink
- [`@adjudicate/runtime`](../../packages/runtime/README.md) — `resumeDeferredIntent` + `deadlinePromise` for orchestrators

**Files (current — claustrum-on-dev; the legacy `packages/llm-provider/*` implementation was deleted in the cutover):**
- Conductor composition root: `apps/api/src/claustrum-bootstrap.ts` (`getConductor()`, per-turn `Capsule`, fail-closed `toolRosterDrift()` boot gate)
- Production planner: `apps/api/src/claustrum/ibatexas-planner.ts` (`createIbatexasPlanner` — LLM sees only `express_intent`)
- Capability policy: `apps/api/src/claustrum/capability-policy.ts`
- Tool registry (17 LLM-callable tools, keyed `capability := intentKind`): `apps/api/src/tools/register-ibatexas-tool-packs.ts`
- Classification + per-state visibility: each Pack's exported `*CapabilityPlanner` (`@ibatexas/pack-*`), built on the `CapabilityPlanner` / `ToolClassification` contracts in `@adjudicate/core/llm`
- Intent kind union (boot-time Pack-coverage validator): `@ibatexas/intent-kinds` (`KNOWN_INTENT_KINDS`)

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

### 13. PIX Pack Extraction — `@adjudicate/pack-payments-pix`

**Decision:** Extract PIX (Brazilian instant payment) charge-lifecycle adjudication into the first published Adjudicate Pack (`@adjudicate/pack-payments-pix@0.1.0-experimental`). The Pack defines its own intent kinds (`pix.charge.create`, `pix.charge.confirm`, `pix.charge.refund`) and a PolicyBundle covering all six kernel Decision outcomes. IbateXas migrates by composing the Pack's reusable DEFER guard factory into its existing `order.confirm` flow.

**Why now (Phase 1 of the platform roadmap):**
- The kernel becomes a platform the moment two unrelated domains compose Packs. Shipping one Pack end-to-end is the forcing function for the `PackV0` contract.
- PIX exercises DEFER + signal-resume — the kernel's hardest, most differentiated capability. Sync-only payments wouldn't prove the round-trip.
- Per Principle 3 ("dogfood is destructive, not parallel"), the inline PIX policy block previously in `packages/llm-provider/src/order-policy-bundle.ts` (lines 173–201 pre-migration) is deleted, not parallel-shipped.

**What landed:**
- `PackV0` contract in `@adjudicate/core` (`packages/core/src/pack.ts`) — `metadata + policyBundle + capabilityPlanner + toolClassification`. Type-level conformance via `expectPackV0()`.
- `@adjudicate/pack-payments-pix` package with PolicyBundle covering EXECUTE / REFUSE / ESCALATE / REQUEST_CONFIRMATION / DEFER / REWRITE plus DEFER round-trip integration test.
- IbateXas migration: `order-policy-bundle.ts` composes `createPixPendingDeferGuard` from the Pack instead of declaring the DEFER guard inline. `apps/api/src/subscribers/defer-resolver.ts` imports `PIX_CONFIRMATION_SIGNAL` directly from the Pack. Inline `PIX_DEFER_TIMEOUT_MS`, `PIX_CONFIRMATION_SIGNAL`, `PIX_CONFIRMED_STATUSES` constants and the `deferOnPendingPix` guard are deleted from IbateXas.
- 4-stage shadow→enforce playbook in [docs/ops/runbooks/05-stage-pix-charge-pack.md](../ops/runbooks/05-stage-pix-charge-pack.md).

**What was painful (the migration friction worth recording):**

1. **Intent-kind mismatch.** The roadmap calls for `pix.charge.create/confirm/refund` as Pack-canonical intents. IbateXas's LLM doesn't propose those — it proposes `order.confirm` with `paymentMethod: "pix"`, and the kernel adjudicates the higher-level intent. Two reasonable resolutions: (a) reshape IbateXas's flow, or (b) have the Pack expose a reusable guard factory. We chose (b): the Pack ships both its canonical PolicyBundle (for adopters that route through `pix.charge.*`) and `createPixPendingDeferGuard` (for adopters with their own intent kind, like IbateXas). Phase 5's stripe-greenfield Pack will validate the canonical path; this Pack proves the factory path.

2. **Wire-status vocabulary differs from Pack-status vocabulary.** IbateXas's `payment.status_changed` NATS event uses Stripe labels (`paid`, `captured`, `confirmed`); the Pack's `PixChargeStatus` is normalized (`pending`, `confirmed`, `captured`, …). Mapping at the IbateXas adapter boundary is correct, but this means `defer-resolver.ts` keeps its own local `SETTLED_WIRE_STATUSES` set rather than importing the Pack's `PIX_CONFIRMED_STATUSES`. Documented in the resolver. Phase 5 will surface whether the Pack should grow a wire-status mapping helper.

3. **Signal name kept as `payment.confirmed` (not `pix.charge.confirmed`).** Production IbateXas already publishes `payment.confirmed` and the Pack adopts that name to avoid a same-PR rename of NATS subjects in the audit-replay window. A future major Pack version may rename to align the signal namespace with the intent kind namespace; that would be a documented breaking change.

4. **Strict kernel guard ordering surfaced a unit-test design mistake.** A first cut of the taint-gate test asserted REFUSE on an UNTRUSTED-proposed `pix.charge.confirm` against a *pending* charge. The kernel's order is state → auth → taint, so the DEFER state guard fires first; the taint gate never runs. Fixed by exercising the taint gate with a state where all state guards pass (`status: "confirmed"`). Worth recording: Pack authors must read the kernel's strict guard order before designing security tests, or risk pinning the wrong invariant.

5. **No npm publication yet.** Per Phase -1 of the platform roadmap, the Pack ships as a `workspace:*` dep inside the IbateXas monorepo for now. The `@adjudicate` org claim, public repo, Sigstore CI, and changesets pipeline are still pending; once those land, the Pack tags `0.1.0-experimental` as its first npm publish without code changes. **(Superseded 2026-05-24 — see Phase 3 below; all `@adjudicate/*` packages now ship from the npm registry under the `adjudicate` org owned by `brunoro`.)**

**Consequences:**
- IbateXas's `@ibatexas/llm-provider` no longer re-exports `PIX_CONFIRMATION_SIGNAL` / `PIX_DEFER_TIMEOUT_MS` / `PIX_CONFIRMED_STATUSES`. New consumers import directly from `@adjudicate/pack-payments-pix`. The single existing consumer (`apps/api/src/subscribers/defer-resolver.ts`) was migrated in this PR.
- The `pix.send` taint requirement (an aspirational entry — no intent kind ever matched it) was removed from `orderTaintPolicy`. The Pack's own `pixPaymentsTaintPolicy` is now authoritative for `pix.charge.*` intent kinds.
- `CLAUDE.md` Hard Rule #9 updated to reference the Pack as the canonical PIX adjudication surface.

**Phase 2 follow-up — platform consolidation (2026-04-27):**

Completed the cross-repo consolidation. The `@adjudicate/*` workspace copies (core, runtime, audit, audit-postgres, pack-payments-pix) and the `@example/*` examples (vacation-approval, commerce-reference) have been **deleted from the IbateXas monorepo**. Source of truth now lives exclusively in the standalone platform repo: [BrunoRodolpho/adjudicate](https://github.com/BrunoRodolpho/adjudicate).

Linking strategy chosen: **`pnpm-workspace.yaml` cross-repo include** (`../adjudicate/packages/*` and `../adjudicate/examples/*`) rather than `file:` deps. The `file:` interim was attempted first but failed because the platform's `@adjudicate/pack-payments-pix` declares `workspace:*` deps on `@adjudicate/core` etc., which can't resolve from outside the platform's workspace. Including the platform's packages glob in IbateXas's workspace lets pnpm satisfy those transitive `workspace:*` resolutions without npm publication. Once the platform publishes to npm (separate session, not blocking this consolidation), the cross-repo include drops in favor of registry deps.

Platform-side companion changes shipped in [BrunoRodolpho/adjudicate#feat/pix-pack-defer-guard-factory](https://github.com/BrunoRodolpho/adjudicate/pull/new/feat/pix-pack-defer-guard-factory) (commit `467c9c6`):

- `createPixPendingDeferGuard` factory ported from IbateXas (the load-bearing artifact for cross-adopter reuse).
- Signal constant renamed to `PIX_CONFIRMATION_SIGNAL = "payment.confirmed"` (matches the IbateXas wire vocabulary documented in clause 3 of this ADR's "What was painful" section above).
- `escalateFailedConfirm` state guard ported (real operational gap in v0.1).
- Four new refusal builders + one new `PixChargeStatus` enum value (`"failed"`).
- Two new test files (adopter-guard, defer-round-trip) bringing the platform Pack's test count from 20 to 28.
- ADR-002-defer-guard-factory.md captures the design rationale on the platform side.

IbateXas-side changes in this PR:

- Workspace copies of all `@adjudicate/*` packages and `@example/*` examples deleted (~3500-4500 LOC removed).
- `pnpm-workspace.yaml` extended with cross-repo includes (5 new lines + comment).
- `packages/llm-provider/package.json` and `apps/api/package.json` keep `workspace:*` references — they now resolve through the cross-repo workspace. **(Superseded in Phase 3 — see below; both files now pin npm registry versions.)**
- `vitest.config.ts` aliases for `@adjudicate/*` removed from both `packages/llm-provider/` and `apps/api/` (vitest now resolves directly to the cross-repo workspace via node_modules).
- New defense-in-depth test: `packages/llm-provider/src/__tests__/pack-signal-contract.test.ts` pins `PIX_CONFIRMATION_SIGNAL === "payment.confirmed"`. Any future Pack version that renames the signal trips this test on dependency upgrade. llm-provider test count: 84 → 85.

Test counts unchanged across consumers: `@ibatexas/api` 642 passing, `@ibatexas/llm-provider` 85 passing (was 84 + 1 new pinning test). Platform-side tests: 204 passing across 8 packages.

Cross-link to platform-side ADR: [`packages/pack-payments-pix/docs/ADR-002-defer-guard-factory.md`](https://github.com/BrunoRodolpho/adjudicate/blob/main/packages/pack-payments-pix/docs/ADR-002-defer-guard-factory.md).

**Phase 3 — npm migration (2026-05-24):**

The platform repo published all 15 `@adjudicate/*` packages to npm under the unscoped `adjudicate` org owned by `brunoro`:

| Package | Version |
|---|---|
| `@adjudicate/core` | `1.0.0` |
| `@adjudicate/audit`, `@adjudicate/audit-postgres` | `1.0.1` |
| `@adjudicate/runtime`, `primitives`, `analyze`, `anthropic`, `openai`, `conformance`, `locales-pt-br`, `observability`, `adapter-core`, `cli`, `pack-payments-pix`, `pack-identity-kyc`, `pack-deployments-approval` | `0.1.1` |

A meta-package `adjudicate@0.1.0` was also published (entire monorepo in one tarball) for `npm i -g adjudicate` consumers who want the CLI globally — IbateXas does not consume the meta-package.

**IbateXas-side migration changes:**

- `pnpm-workspace.yaml`: the `../adjudicate/packages/*` and `../adjudicate/examples/*` cross-repo includes are removed. Workspace scope drops from 40 projects to 18 (ibatexas-only).
- 10 consumer `package.json` files (`apps/api`, `packages/cli`, `packages/domain`, `packages/llm-provider`, `packages/tools`, `packages/pack-{customer-onboarding,orders,payments,reservations,whatsapp}`) replace every `"@adjudicate/*": "workspace:*"` with the appropriate caret-pinned version above (e.g. `"@adjudicate/core": "^1.0.0"`).
- `pnpm install` resolves all `@adjudicate/*` deps from the registry under `node_modules/.pnpm/@adjudicate+*@*/`. Subpath imports like `@adjudicate/core/kernel` and `@adjudicate/core/llm` continue to work without changes — only the resolution path differs.
- Full workspace build (`ibx dev build`) verified green: 15/15 turbo tasks successful in 28.6s.

**Upgrade path going forward:** bump the version in the consuming `package.json` and `pnpm install`. No more cross-repo coordination needed for routine version updates.

**Adjacent stale references not addressed in this migration** (carry forward as a separate cleanup):
- 5 GitHub Actions workflows (`.github/workflows/{ci,deploy,deploy-staging,override-drift,upgrade-radar}.yml`) still check out the adjudicate sibling repo and `mv __adjudicate__ ../adjudicate` to set up the old cross-repo workspace. These steps are now redundant — CI installs `@adjudicate/*` from npm directly. The `ci.yml:17` comment also references "until @adjudicate/* is published to npm".
- `packages/cli/src/commands/kernel.ts` (lines 262, 267, 271) prints runbook output that references `../adjudicate/packages/audit-postgres/migrations/*.sql` paths. With audit-postgres on npm, those migrations live under `node_modules/.pnpm/@adjudicate+audit-postgres@1.0.1/node_modules/@adjudicate/audit-postgres/migrations/`.

### 14. Kernel always-on cutover (2026-05-24)

**Decision:** Delete the staged-rollout machinery for the adjudicate kernel. The kernel is now always authoritative — every mutation is adjudicated, every decision is audited, no env-var gating, no shadow mode, no kill switch.

**Why:** IbateXas is not in real production. The staged-rollout playbook (shadow → enforce → kill-switch → fail-open ledger → opt-in audit-postgres) was deadweight, and in current dev state the kernel was inert — the `isPureLegacy` branch in `kernel-executor.ts` was taken for every mutation, synthesizing EXECUTE without consulting policy and suppressing audit emission. The framework consumed from npm was loaded but doing zero work on live traffic.

**What was removed:**
- `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE` env vars and their boot-time validators (`assertEnforceConfigNotEmptyAfterTrim`, `validateEnforceConfig`).
- The 3-way branch (`isEnforced` → `adjudicateWithShadow` → pure-legacy) in `packages/llm-provider/src/kernel-executor.ts`, `packages/llm-provider/src/llm-responder.ts`, and `apps/api/src/routes/__shared__/customer-intent-gateway.ts`. Replaced with unconditional `adjudicate()` + unconditional audit emit.
- The `legacyDecisionAsKernelDecision` / `adjudicateWithShadow` / `isPureLegacy` machinery from all 3 call sites.
- `IBX_LEDGER_ENABLED` / `IBX_LEDGER_ENFORCE` / `IBX_LEDGER_FAIL_OPEN` env vars. The ledger is always-on and fail-closed — Redis unreachability surfaces as a `LedgerUnavailableError` that propagates to a `REFUSE { code: "ledger_unavailable" }`. No more fail-open knob (the comment in `intent-ledger.ts` explicitly warned "flip to true only in non-financial paths," which doesn't fit IbateXas's financial paths).
- `IBX_AUDIT_POSTGRES_ENABLED` env var. The Postgres audit sink is always part of the fan-out (`console + NATS + Postgres`) inside `persistentBufferedSink`. Audit emit remains best-effort at the IbateXas boundary; a Postgres outage spills records to Redis for the `audit-consumer` subscriber to drain on recovery.
- The kill-switch surface entirely: `packages/tools/src/redis/kill-switch-store.ts`, `apps/api/src/routes/admin/kernel.ts` (HTTP admin route), the `ibx kernel kill-switch` CLI subcommand wiring, the `kernel_kill_switch_state` Prometheus gauge polling, and the corresponding test files. The `@adjudicate/core/kernel` internal kill-switch check still exists inside `adjudicate()` but the Redis key it consults is never written, so it's a constant no-op.
- The `ibx kernel divergence` CLI subcommand wiring (shadow-mode divergences no longer exist).
- 5 staged-rollout runbooks at `docs/ops/runbooks/01-stage-…` through `05-stage-pix-charge-pack.md`. Replaced with a single `kernel-operations.md` covering audit-postgres ops, DEFER troubleshooting, Pack version updates, and incident response.

**What was added:**
- `ibx kernel migrate` — applies the `@adjudicate/audit-postgres` SQL migrations against `$DATABASE_URL`. Idempotent (swallows "already exists" / "duplicate" errors). Lives in `packages/cli/src/commands/kernel.ts`.
- `ibx bootstrap` invokes `applyAuditPostgresMigrations` as step 4 of 7, so first-time setup brings the `intent_audit` table up automatically.
- `assertPackCoverage` in `apps/api/src/plugins/kernel-bootstrap.ts` — boot validator that walks `KNOWN_INTENT_KINDS` and throws `PackCoverageError` if any kind is not declared by an installed Pack's `intents` list.
- `assertAuditPostgresReady` — boot preflight probing `SELECT 1 FROM intent_audit LIMIT 1`. Refuses to boot with a clear actionable error pointing to `ibx bootstrap` if the table is missing.

**Migration path for adopters (the recipe other repos can apply):**
1. In every consumer of `@adjudicate/core/kernel`, replace the `isEnforced` / `isShadowed` / pure-legacy 3-way branch with a single unconditional `adjudicate(envelope, state, policy)` call. Drop the `isPureLegacy` flag and the audit-emit guard.
2. Drop `isLedgerEnabled` / `isLedgerEnforced` / fail-open knobs from the ledger adapter. Always wrap in a metrics-recording fail-closed shim.
3. Drop the postgres-enabled gate from the audit-wiring fan-out; always include the Postgres sink.
4. Delete the kill-switch CLI/HTTP/store surface.
5. In the api boot anchor, add a Pack-coverage validator and an audit-postgres preflight.
6. Add an `ibx kernel migrate` (or equivalent) command that resolves the `@adjudicate/audit-postgres` package via `import.meta.resolve` and applies `migrations/*.sql` against `$DATABASE_URL`. Wire it into the existing setup command.

