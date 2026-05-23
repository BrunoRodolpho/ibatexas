# Architecture & Coupling Deep Audit

**Date:** 2026-05-23
**Auditor:** Staff/Principal architectural review (post-remediation snapshot)
**Branch:** `feat/adjudicate-w6-tests-docs`
**Scope:** End-to-end coupling, dependency direction, framework leakage, hidden invariants.

---

## Executive summary

1. **The "domain" layer is not actually a domain layer — it is a kernel adapter with database tables.** `@ibatexas/domain` imports `@adjudicate/core/kernel`, `@adjudicate/primitives`, and three first-party Packs (`@ibatexas/pack-orders`, `pack-customer-onboarding`, `pack-reservations`). Domain-internal "policies" (`order-projection-policy.ts`, `payment-projection-policy.ts`, `conversation-policy.ts`) duplicate Pack semantics. Two sources of truth for `payment.refund.issue` exist simultaneously today; one will rot.
2. **The chokepoint is leaking.** `withAdjudicate` (`packages/domain/src/services/__shared__/with-adjudicate.ts:120`) and `runCustomerIntent` (`apps/api/src/routes/__shared__/customer-intent-gateway.ts:152`) implement the *same* kernel-decision branching, the *same* audit emit, the *same* fail-open semantics — but their `else { decision = {kind: "EXECUTE", basis: []} }` legacy-bypass branch (route gateway only, line 206) means routes can paper over un-shadowed kinds while service methods can't. The two implementations will drift.
3. **D8 "parallel surface" is becoming permanent.** Eight `@deprecated` bare-arg methods remain wired to live callers (5 call sites in `routes/order-actions.ts`, `tools/cart/cancel-order.ts`, `tools/cart/regenerate-pix.ts`). Without a deprecation deadline and ratchet, this is the canonical "we'll clean it up later" pattern that calcifies into permanent dual surfaces — exactly what the W3 audit's bypass hunter caught at sites #1-3.
4. **62 env vars, zero typed-config consumers.** `apps/api/src/config.ts` defines a Zod-validated env schema but is **imported nowhere** in production code (`grep "from.*config" → 0` non-test files). Every consumer reads `process.env.X` directly across 84 sites in `apps/api/src/` and ~50 more in packages. A typo or missing var fails at runtime in the affected code path, not at boot.
5. **The audit NATS subject is fanout-without-listeners and unauthenticated.** Only one in-process subscriber (`audit-consumer.ts`) reads `audit.intent.decision.v1`, and it's behind `IBX_AUDIT_POSTGRES_ENABLED`. No-one *else* consumes it. Yet the framework code keeps publishing it to NATS, which has zero per-message auth. A read-only NATS observer gets every adjudicated decision (including PII actor metadata), and an attacker can publish forged audit records that the system has no way to distinguish from legitimate ones (because nothing verifies them).
6. **Subscriber idempotency is per-author, not per-contract.** `cart-intelligence.ts` uses `isNewEvent` with hand-rolled keys (`order:${orderId}`, `dispute:${disputeId}`, etc.); `payment-lifecycle.ts` uses `payment-lifecycle:${paymentId}:${newStatus}`; `audit-consumer.ts` uses `audit.intent.decision.v1:${intentHash}:${at}`; `defer-resolver.ts` uses `defer:resumed:${deferResumeHash}` AND a separate `defer:resuming:` marker with two-phase commit. Each one re-derives the dedup contract differently. A new subscriber writer will pick one of these patterns at random.
7. **The dispatcher seam is a runtime singleton with no boot ordering guarantee.** `setResumeIntentDispatcher` (`defer-resolver.ts:108`) is module-level mutable state set during boot (`index.ts:120`). The subscriber `startDeferResolverSubscriber` starts at line 101 of `index.ts`, the dispatcher is wired at line 120. The 19-line window between those two calls is a race: any `payment.status_changed` arriving in that interval will execute `_dispatcher` as `null` (line 535 — `if (_dispatcher)`), audit-emit but never dispatch, then mark `defer:resumed:` as committed. The intent vanishes silently.

---

## Section A — Mutation authority boundary

### A.1 `withAdjudicate` chokepoint (`packages/domain/src/services/__shared__/with-adjudicate.ts:120-187`)

The helper is **structurally clean** — it does exactly four things: call `adjudicate()` (pure, no I/O), best-effort audit emit, branch on decision kind, invoke executor on EXECUTE/REWRITE. The `Promise<AdjudicatedResult<R>>` shape is consistent and tractable.

**But the abstraction leaks adjudicate framework concerns INTO the domain layer in three concrete ways:**

1. **Type signatures import `@adjudicate/core` directly** (line 33-42). Every command-service interface now carries `IntentEnvelope<K, P>` and `Decision` types. `@ibatexas/domain` cannot be replaced without also replacing the kernel SDK.
2. **The Pack policy is a parameter of the helper, not a property of the service.** Lines 122-125: caller passes `policy: PolicyBundle<K, P, S>`. This means *every* service method must know which pack adjudicates it. `order-command.service.ts` passes both `ordersPolicyBundle` AND `orderProjectionPolicyBundle` depending on the method (lines 478, 489, 544). The service is now coupled to **two** Packs.
3. **The "REWRITE preserves payload shape" cast at line 176-178** (`decision.rewritten as IntentEnvelope<K, P>`) is a runtime invariant the helper cannot enforce. By kernel contract this is true, but the helper sits outside the kernel boundary and has no way to verify the contract. A future Pack that mutates payload shape on REWRITE would silently corrupt executor inputs.

**Verdict:** `withAdjudicate` is the right *shape*, but it is misnamed. It is not a "service helper" — it is a **kernel adapter that happens to live in the domain package**. The clean answer is to either (a) extract it to a new `@ibatexas/kernel-adapter` package the domain depends on, or (b) accept the leak and rename to `@ibatexas/domain/kernel-bridge` so callers know the boundary.

### A.2 `runCustomerIntent` route gateway (`apps/api/src/routes/__shared__/customer-intent-gateway.ts:152-299`)

The route gateway has a **completely different** branch structure from `withAdjudicate`:

| Aspect | `withAdjudicate` (domain) | `runCustomerIntent` (route) |
|---|---|---|
| Shadow/enforce switch | Always adjudicates | `isEnforced` / `isShadowed` / pure-legacy 3-way |
| Audit emit | Always (best-effort) | Skipped on pure-legacy (line 211) |
| `ALWAYS_ENFORCE` set | None | Hardcoded `["customer.anonymize", "customer.anonymize.cancel"]` (line 173-176) |
| Default-EXECUTE on shadow | No — caller branches on decision | Yes — `decision = { kind: "EXECUTE", basis: [] }` (line 202) |
| HTTP status mapping | None — caller maps | EXECUTE → 200, REFUSE → 403, DEFER → 202, ESCALATE → 503 |
| Localization | None | `localizeDecision` + `RefusalMessagesDict` |

**This is a real architectural inconsistency.** The same envelope, going to the same Pack, gets adjudicated under different rules depending on whether it enters via HTTP route vs subscriber/job/service-direct. Specifically:

- A customer `order.checkout.create` via `POST /api/cart/checkout` → falls into `isEnforced/isShadowed/legacy` branch → unless explicitly in `IBX_KERNEL_ENFORCE`, the kernel decision is *thrown away* and the legacy EXECUTE wins.
- The same intent via the LLM tool path → goes through `kernel-executor.ts` (different code) → same 3-way switch, but it's a *different* implementation of the switch.
- The same intent published from a subscriber → goes through `withAdjudicate` → **kernel decision is binding** (no legacy override).

The "always-enforce" allowlist for `customer.anonymize` is the loud version of this problem: there are two intent kinds where the gateway author knew the legacy fallback was unsafe and special-cased them. **Every other kind silently uses the legacy fallback in non-enforce mode**, which means the documented "default-deny" invariant from `governance/04-decision-policy.md` is, in practice, "default-EXECUTE on routes until ops flips an env var."

### A.3 The `*FromEnvelope` / bare-arg parallel surfaces (Decision D8)

Production callers still on the bare-arg deprecated surface (verified via grep, not via deprecation-warning telemetry):

| Call site | Method | Status |
|---|---|---|
| `apps/api/src/routes/order-actions.ts:137` | `orderCmdSvc.create(data)` | Bypasses kernel |
| `apps/api/src/routes/order-actions.ts:256` | `orderCmdSvc.transitionStatus(id, ...)` | Bypasses kernel |
| `apps/api/src/routes/order-actions.ts:267,1049,1057` | `paymentCmdSvc.transitionStatus(activePayment.id, ...)` | Bypasses kernel |
| `apps/api/src/routes/order-actions.ts:1065` | `paymentCmdSvc.create(...)` | Bypasses kernel |
| `packages/tools/src/cart/cancel-order.ts:41` | `paymentCmdSvc.transitionStatus(...)` | Bypasses kernel |
| `packages/tools/src/cart/regenerate-pix.ts:89` | `cmdSvc.transitionStatus(...)` | Bypasses kernel |

These are the same surfaces the W3 audit's Bypass Hunter flagged at sites P0-2 (regenerate-pix) and P0-3 (cancel-order paths). **The remediation tracker shows them as CLOSED.** The remediation closed *some* paths (the refund route uses `issueRefundFromEnvelope`, the lifecycle subscriber uses `transitionStatusFromEnvelope`) but the deprecated bare-arg surface is still wired to several adjudicate-bypassing call sites.

The architectural problem isn't that these callers exist — they will be migrated. The problem is that **the type system permits both surfaces.** A TypeScript caller cannot tell, by looking at `OrderCommandService`, that `transitionStatus` is dangerous and `transitionStatusFromEnvelope` is required. There is no compile-time gate. The deprecation marker is documentation, not enforcement.

**Architectural fix:** Either (a) delete the bare-arg methods from the interface and force a single migration sweep (the entire premise of D8 was "we can do this incrementally" — true, but the rollback safety net was never used to actually delete), or (b) introduce a typed wrapper like `Adjudicated<typeof orderCmdSvc>` that hides the bare-arg surface from non-internal call sites. As written, the bare-arg methods will linger indefinitely.

---

## Section B — Layering and dependency direction

### B.1 `apps/api` directly imports `@adjudicate/core`

Confirmed at:
- `apps/api/src/plugins/kernel-bootstrap.ts:27-28` — `installPack`, `PackConformanceError`, `setMetricsSink`, `validateEnforceConfig`
- `apps/api/src/routes/__shared__/customer-intent-gateway.ts:51-52` — `localizeDecision`, `adjudicate`, `isEnforced`, `isShadowed`
- `apps/api/src/subscribers/defer-resolver.ts:53-54` — `buildAuditRecord`, `adjudicate`
- `apps/api/src/subscribers/audit-consumer.ts:33` — `AuditRecord` type
- `apps/api/src/routes/admin/orders.ts:8` — `buildEnvelope` (and 6 other route files do the same)

**Arguments for the current arrangement:**
- Kernel bootstrap *should* live in the app layer because it is an app-lifecycle concern (boot ordering, env-config validation, registry singleton).
- `buildEnvelope` is a structural constructor — every layer that emits envelopes needs it; routing it through a wrapper would be cosmetic.
- Routes call `adjudicate` only in the customer-intent gateway, and that gateway is itself an app-layer construct.

**Arguments against:**
- The `apps/api` package now has 16 direct `@adjudicate/*` import sites in production code. The kernel is no longer a swap-out adapter; it is part of the app's API surface.
- The `customer-intent-gateway` and the `kernel-executor` (in `llm-provider`) re-implement the same 3-way shadow/enforce switch. If the kernel ever ships its own `runWithAdjudicate(envelope, state, policy, opts)` helper, both adopters will need to ignore it because they have already coded around it.
- A subscriber importing `adjudicate` directly (`defer-resolver.ts:493`) means the subscriber owns kernel re-adjudication on resume — but the kernel itself owns adjudication on the hot path. Two code paths invoke the kernel; if either drifts (e.g., a future kernel API requires a new context parameter), both must be updated.

**Target architecture:** `apps/api` should depend on the kernel *only* via `@ibatexas/llm-provider` re-exports for *behavioral* APIs (`adjudicate`, `isEnforced`, `localizeDecision`) and *only* via `@adjudicate/core` for *structural* types (`IntentEnvelope`, `AuditRecord`, `Decision`). The mixed posture today is the worst of both — apps reach across both boundaries arbitrarily, and the type-vs-runtime split is undocumented.

### B.2 `@ibatexas/llm-provider` dependency graph

`packages/llm-provider/package.json`:
- Depends on `@ibatexas/domain` (workspace)
- Depends on `@ibatexas/nats-client` (workspace)
- Depends on `@ibatexas/pack-customer-onboarding`, `pack-orders`, `pack-payments`, `pack-reservations`, `pack-whatsapp` (all workspace)
- Depends on `@ibatexas/tools` (workspace)

`packages/domain/package.json`:
- Depends on `@ibatexas/pack-customer-onboarding`, `pack-orders`, `pack-reservations`, `pack-whatsapp` (all workspace)
- Depends on `@ibatexas/nats-client` (workspace)

**This is the dependency inversion problem.** `@ibatexas/domain` imports four Packs. But Packs are supposed to be *policy descriptions about domain concepts* — they should depend on domain types, not the other way around. The current arrangement means:

- `pack-orders` defines `OrderState`, `OrderPayload`, `OrderIntentKind` (the *type* surface).
- `@ibatexas/domain` imports `ordersPolicyBundle` from `pack-orders` to feed `withAdjudicate`.
- `@ibatexas/llm-provider` imports `OrderState` from `pack-orders` AND `@ibatexas/domain` services.

A consequence: I cannot rewrite `@ibatexas/domain`'s services to use a *different* policy package (e.g., `@thirdparty/our-custom-orders-pack`) without simultaneously changing `pack-orders` because the domain layer has *baked the Pack identity into the service constructor*.

The Packs are not reusable across consumers as designed. They are ibatexas's domain policies, factored into separate workspace packages for boot-time conformance assertion only.

**Verdict:** The "5 first-party Packs" are a structural decomposition, not a reusable abstraction. They share `@adjudicate/primitives` factories and `@adjudicate/core` types but they are domain-specific by content. The Pack-vs-domain layering is a polite fiction.

### B.3 Cycle check

No actual `import` cycle exists (TypeScript would refuse to build). But the *conceptual* cycle does:

```
@ibatexas/llm-provider
    ↓ imports OrderState
@ibatexas/pack-orders
    ↑ depends conceptually on OrderProjection schema, OrderFulfillmentStatus enum
@ibatexas/domain
    ↓ imports ordersPolicyBundle
@ibatexas/pack-orders
```

The `pack-orders` does not literally import `@ibatexas/domain` — it re-defines its own `OrderState` shape — but the shape *must* stay structurally compatible with what `@ibatexas/domain` produces (line 64-69 of `order-policy-bundle.ts` literally has a `_AssertCompat<T extends _PackOrderState>` type to enforce this). If `prisma schema` changes the `OrderProjection.fulfillmentStatus` enum, `pack-orders` must update too, even though it has no direct dependency on Prisma.

This is **schema coupling without dependency arrows.**

---

## Section C — Domain modeling

### C.1 Command services leak query responsibility

`OrderCommandService.transitionStatusFromEnvelope` (`order-command.service.ts:484-502`) calls `snapshotProjection(envelope.payload.orderId)` (line 485) — which does a Prisma `findUnique`. The "command" service reads the database to build kernel state.

Similarly `PaymentCommandService.issueRefundFromEnvelope` (line 677-686) calls `snapshotPayment`. Every envelope-typed method on both services does a snapshot read before adjudicating.

This is structurally fine but not CQRS — the "command service" is doing a query, by necessity. The cleaner model would be: the *caller* projects the state and passes it in. That is exactly what `addNoteFromEnvelope` does (line 223 — `orderState: OrderState` parameter passed by caller). Every other envelope-typed method snapshots internally. Inconsistent.

The trap: a future test will set up a mock of `prisma` but not realize that `transitionStatusFromEnvelope` does *two* reads (snapshot + executor), neither documented in the interface. The interface signature looks like a pure command but it's a command+query.

### C.2 Policy bundle duplication: domain-internal vs Pack

`packages/domain/src/services/__shared__/payment-projection-policy.ts:503-513` defines `paymentProjectionPolicyBundle` with:
- `requirePaymentExists`
- `refuseTerminalTransition`
- `refundMagnitudeGuard`
- `regenerationCountCapGuard`
- `executeAll`

`packages/pack-payments/src/policies.ts:483-507` defines `paymentsPolicyBundle` with **literally the same guards** (the file's own comment at line 17-23 says "this Pack carries the same guards (`refundMagnitudeGuard`, `regenerationCountCapGuard`, `requirePaymentExists`, `refuseTerminalTransition`) PLUS the additional 12 kinds").

Both bundles are wired in production:
- `paymentProjectionPolicyBundle` is used by `payment-command.service.ts` (lines 612, 639, 659, 682, 693).
- `paymentsPolicyBundle` is exposed by `paymentsPack` and registered via `installPack(paymentsPack)` at `kernel-bootstrap.ts:134`.

**Which one is authoritative?** Both have `refundMagnitudeGuard`. They share the same env vars (`getRefundConfirmThresholdCentavos`, `getRefundEscalateThresholdCentavos`). The pack-payments version covers 17 kinds, the domain version covers 6 kinds.

If someone tunes `REFUND_CONFIRM_THRESHOLD_CENTAVOS=75000` to test, they will get correct behavior at both adjudicate sites. But if a future PR changes the threshold inside one file and not the other, refund decisions will diverge depending on whether the call goes through `paymentCmdSvc.issueRefundFromEnvelope` (domain bundle) or through some other path that hits the pack bundle. **This is a policy-drift trap.** The reuse story for first-party Packs explicitly says "policy lives in the Pack" — the domain-internal duplicate undermines that claim.

The remediation tracker calls the pack-payments version "the W5 expansion" but doesn't say what's supposed to happen to the legacy bundle. It still ships.

### C.3 State shapes inconsistency

| Pack | State shape | Notable fields |
|---|---|---|
| `pack-orders.OrderState` | `{ ctx: { customerId, items, channel, isAuthenticated, fulfillment, paymentMethod, ... } }` | ~40 fields, mirrors XState machine context |
| `domain.OrderProjectionState` | `{ ctx: { exists, currentStatus, version, customerId, currentDeliveryType } }` | 5 fields, mirrors Prisma row |
| `pack-payments.PaymentState` | `{ ctx: { exists, currentStatus, currentMethod, version, orderId, isTerminal, refundedAmountCentavos, amountInCentavos, dailyRetryCount, regenerationCount } }` | 10 fields, mirrors Prisma row + retry/regen counters |
| `domain.PaymentProjectionState` | `{ ctx: { exists, currentStatus, currentMethod, version, orderId, isTerminal, refundedAmountCentavos, amountInCentavos, regenerationCount } }` | 9 fields, near-identical to pack-payments — but no `dailyRetryCount` |
| `pack-reservations.ReservationState` | `{ ctx: { ... } }` | Reservation-specific |

The two payment shapes are **structurally identical except for `dailyRetryCount`**. The order shapes are **deliberately different sizes** — the Pack's `OrderState` is wide because it serves the LLM-tool-path (it's actually the XState machine context), and the domain's `OrderProjectionState` is narrow because the projection guards only need 5 fields.

This is principled — the wider state is the LLM gate state, the narrower state is the projection gate state. But the naming is confusing: both call the property `ctx`, both use `OrderState` as a type name in their own namespace, and the structural type checker happily lets a caller pass one where the other is expected because both are `{ ctx: object }`.

The trap: a subscriber that builds `OrderProjectionState` and accidentally passes it to a function expecting `OrderState` will compile (width subtyping makes the narrower-into-wider direction legal) and then **silently get default-REFUSE** at the kernel because all the fields the Pack guards check are missing.

---

## Section D — Event topology / NATS

### D.1 NATS auth (W4)

The W4 change (`packages/nats-client/src/index.ts:51-141`) is **correct in shape but inert in production**. The connect function:
1. Resolves `NATS_CREDS_PATH` OR `NATS_NKEY_SEED` (line 62-71).
2. Resolves `NATS_TLS_CA` OR `NATS_TLS_REQUIRED` (line 81-91).
3. Emits a `console.error` warning if `NODE_ENV=production` AND no auth AND no TLS (line 117-130).

**Critical observation:** the warning is `console.error`, not a process exit. The system *runs without authentication* in production if the operator forgets to provision creds. The remediation tracker (REMEDIATION-COMPLETE.md §"Operator action items still pending") flags this as deferred operator work, but the code does not fail-closed.

**Architectural option not taken:** the connect function could `throw` if `NODE_ENV=production && authenticator === undefined && tls === undefined`. The current "warn and proceed" stance means a CI test in staging passes without creds, then prod runs without creds.

### D.2 Subscriber idempotency contract

There is **no shared subscriber idempotency primitive.** Each subscriber re-derives:

| Subscriber | Dedup key shape | TTL |
|---|---|---|
| `cart-intelligence.ts:271` | `isNewEvent("order:${orderId}")` | (default — `dedup.ts`) |
| `cart-intelligence.ts:961` | `isNewEvent("refund:${orderId}:${chargeId}")` | default |
| `cart-intelligence.ts:1012` | `isNewEvent("dispute:${disputeId}")` | default |
| `cart-intelligence.ts:1073` | `isNewEvent("canceled:${orderId}")` | default |
| `cart-intelligence.ts:802-806` | `isNewEvent("notification:${customerId || sessionId}:${type}")` | default |
| `payment-lifecycle.ts:67` | `isNewEvent("payment-lifecycle:${paymentId}:${newStatus}")` | default |
| `audit-consumer.ts:131` | `isNewEvent("audit.intent.decision.v1:${intentHash}:${at}")` | default |
| `defer-resolver.ts:418` | `defer:resumed:${deferResumeHash(intentHash, signal)}` + `defer:resuming:...` two-phase | 60s (resuming), `DEFER_PENDING_TTL_GRACE_SECONDS` (resumed) |

The defer-resolver pattern (two-phase commit with `resuming` and `resumed` markers) is the **most robust** because it survives crashes mid-dispatch. The cart-intelligence pattern is the **least robust** because it commits the dedup ledger before any side effect runs — if the side effect throws, retries will be blocked (the runtime team caught this exact issue in P0-8).

**No contract enforces consistency.** New subscriber authors will pick the first pattern they see, not the safest one. The audit's P0-8 finding noted "Resume dedup fires BEFORE dispatch → restart loses intent" — that bug existed because every author used the simplest dedup pattern and no one had documented the safer one.

### D.3 The `audit.intent.decision.v1` subject

Publishers:
- `intent-audit-wiring.ts` publishes via `createNatsSink` (line 208-217) on every adjudicated decision.

Subscribers:
- `subscribers/audit-consumer.ts:97` — the only in-process consumer, and only when `IBX_AUDIT_POSTGRES_ENABLED=true`.

This is **fanout-without-listeners** in the default config. The records go onto NATS Core (per the comment in `nats-client/src/index.ts:3-6`: "uses Core NATS, not JetStream") which means **fire-and-forget**: if no subscriber is connected, the messages are dropped on the floor and the durability story is "the in-process Postgres sink wrote it" — but that's behind the same feature flag.

Outside the audit-consumer, **nothing else reads audit.intent.decision.v1.** This is intentional (decoupled-archiver pattern), but it means the NATS subject is doing 3 jobs:
1. Audit-postgres durability (if enabled).
2. PII exfiltration surface (the audit's P0-12 finding).
3. Observability hook for future tools.

Job (1) is barely needed because the in-process Postgres sink already writes synchronously. Job (2) is a *liability*. Job (3) is aspirational with no current consumer.

**Architectural question:** Should the NATS publish happen at all in the default config? The in-process Postgres sink writes synchronously inside `intent-audit-wiring.ts` if enabled; the NATS publish is redundant unless audit-consumer is a separate replica (which it isn't — they live in the same process). Today the NATS publish doubles the audit-emit work for no resilience gain *if* the in-process sink is enabled, and for unbounded PII spillage *if* NATS auth isn't deployed.

The right architecture is: emit to NATS *only* when audit-consumer is a different process (i.e., when scaling the API horizontally). Today this should be off by default.

### D.4 Cross-subject coupling

`payment.status_changed` is published from:
- `routes/stripe-webhook.ts` (after Stripe verification)
- `subscribers/payment-lifecycle.ts` (auto-confirm/auto-cancel)
- `jobs/pix-expiry-checker.ts`
- `tools/cart/regenerate-pix.ts`

And subscribed by:
- `subscribers/payment-lifecycle.ts` (same file — self-consumes!)
- `subscribers/defer-resolver.ts`

`payment-lifecycle` is therefore in a publish-subscribe loop with itself. The idempotency guard (`isNewEvent("payment-lifecycle:${paymentId}:${newStatus}")` at line 67) prevents infinite re-processing, but the architecture invites the bug: a subscriber that publishes back to the same subject it subscribes to is an N:N hazard waiting for an off-by-one to bite. The dedup is the safety net; the topology is the trap.

---

## Section E — Runtime boundaries

### E.1 Boot ordering in `apps/api/src/index.ts`

The sequence (line numbers from `index.ts`):

```
46: const start = async (): Promise<void> => {
47:   const server = await buildServer();          // (1) installKernelMetricsSink runs HERE (server.ts:49)
56:   await bootstrapKernel(server);                // (2) installFirstPartyPacks + validateEnforceConfig
59-69: shutdown handler defined + SIGTERM/SIGINT registered
72: await server.listen(...)                       // (3) traffic now accepted on port 3001
75: scheduleSvc.seedFromEnv()                      // (4) async DB seed
82: initWhatsAppSender()                           // (5)
84: if (NODE_ENV !== "test") {
86-92:   setOutboxWriter(redis)
94-101:  await startCartIntelligenceSubscribers / Handoff / ConversationArchiver / PaymentLifecycle / DeferResolver
107:     await startAnonymizeGraceResolverSubscriber
113:     await startAuditConsumer
120:     setResumeIntentDispatcher(createResumeDispatcherAdapter(...))   // (6) dispatcher wired
123:     registerWorkers(server.log)               // (7) BullMQ workers start
124: }
```

**The boot order is wrong in two respects:**

1. **`server.listen` (line 72) fires BEFORE subscribers and workers start (line 94+).** Between (3) and (6), the HTTP server is accepting traffic but:
   - Outgoing NATS publishes go to a broker with no in-process subscribers to consume them.
   - `defer-resolver` is not listening to `payment.status_changed`.
   - `audit-consumer` is not listening to `audit.intent.decision.v1`.
   - `setResumeIntentDispatcher` has not been called; the module-level `_dispatcher` in `defer-resolver.ts` is `null`.

   If a Stripe webhook arrives in this window (~50-200ms in dev, longer in cold-start production), the webhook hits `payment-command.service.ts`, fires `payment.status_changed`, which gets dropped on the floor for `defer-resolver` and `payment-lifecycle` because neither is subscribed.

2. **`setResumeIntentDispatcher` is called AFTER `startDeferResolverSubscriber`.** The order is:
   - Line 101: `await startDeferResolverSubscriber(server.log)` → subscriber starts listening to `payment.status_changed`.
   - Line 120: `setResumeIntentDispatcher(...)` → wires the dispatcher.

   Between these, a payment-confirmed webhook arrives → defer-resolver's `resolveDeferredSession` runs → at line 535 `if (_dispatcher)` is false → audit fires but no dispatch → at line 615 the commit path marks `defer:resumed:` → the intent is now "durably committed" with no execution. **Silent data loss in the boot window.**

The Master Plan §"WS1 Plumbing flip" explicitly mentions "subscriber-driven kinds must not be enforced until per-message auth is deployed" — but the boot-window race is a separate problem the master plan doesn't name.

### E.2 Shutdown (`index.ts:59-66`)

```
const shutdown = async (): Promise<void> => {
  await shutdownWorkers();         // BullMQ
  await closeNatsConnection();     // NATS drain()
  await server.close();            // Fastify
  await closeRedisClient();        // Redis
  await prisma.$disconnect();      // Postgres
  process.exit(0);
};
```

The sequence drains BullMQ first, then NATS, then HTTP. But:
- **In-flight DEFER parks are not drained.** If a request is mid-flight in `me.ts:313` calling `parkDeferredIntent`, the shutdown does not wait for it — `server.close()` drains active connections (Fastify default 30s grace) but does not block on Redis writes that haven't been awaited.
- **Audit emits are fire-and-forget.** `intent-audit-wiring.ts:294` does `void buffered.emit(...)` and returns. If a request triggers an adjudicate at T-1ms, the audit emit may not complete before NATS drain. Records spill to Redis (the persistent buffer) — those survive the restart, but only if the spill write itself completed.
- **No `unhandledRejection` handling for the shutdown sequence.** If `shutdownWorkers` throws (e.g., a stuck job), the rest of the shutdown is skipped, NATS is never drained, in-flight publishes are lost.

The shutdown is structurally a single happy-path linear sequence. A SIGTERM during a real outage scenario (DB unreachable, Redis OOM) will trigger one of these failures and the next four lines won't run.

---

## Section F — Cross-cutting concerns

### F.1 Logging

`packages/llm-provider/src/` contains **113 `console.*` calls** (per grep). `packages/domain/src/` contains direct `prisma` calls but its logger surface is "an optional `{warn?, info?}` object" passed via service options.

`apps/api/src/lib/logger.ts` exposes a pino instance. The W6-10 work (per REMEDIATION-COMPLETE.md) migrated 11 sites but "the W6-10 logger shim" still hasn't reached:
- `llm-responder.ts` (16+ `console.*` calls)
- `intent-audit-wiring.ts` (still has a `console.warn` fallback at line 98)
- `audit-redactor.ts` (mentioned in open-blockers as "1 site")
- Every Pack's `policies.ts` (no logger — they don't take one as input)

**The architectural fact:** packages can't import the app logger (would invert the dependency). The W6-10 fix is a `resolveLogger(loggerOrNull)` helper that defaults to console — meaning every package retains its console fallback, and the structured-log story is "the app passes a logger via DI to *some* functions." Not all functions take it. There is no contract that says they must.

The right shape is probably an `@ibatexas/log` package with a pino-compatible interface that every other workspace depends on, with no fallback to console. The `console.*` calls would then be a lint-time error. That work isn't on the roadmap.

### F.2 Error handling

`withAdjudicate` swallows audit-sink errors (line 153-156 — `void options.auditSink.emit(record).catch(...)`). This is documented as "best-effort." But:

- `customer-intent-gateway.ts:218-223` does the same fire-and-forget.
- `defer-resolver.ts:521-524` does the same.
- Each path logs the failure differently (warn vs error, different fields, different prefixes).

There is no centralized "audit emit failure" telemetry. If audit consistently fails for a specific intent kind, three different log lines surface (one per caller); none of them increments a counter or fires an alert.

The Pack `policy()` functions can throw at runtime (per the open-follow-up in REMEDIATION-COMPLETE.md: "`pack-runtime-resilience.test.ts` — no test exercises a Pack `policy()` function throwing at runtime"). The kernel propagates the throw; `withAdjudicate` does not catch it. A throwing guard takes down the request handler. This is fail-closed at the kernel boundary (safer than fail-open), but the responder hot path (`llm-responder.ts:493`) has a `try { decision = adjudicate(...) } catch { ... fall through to legacy }` (per the `customer-intent-gateway.ts:198-201` shadow path comment) — which is fail-open.

**Two different policies on the same failure mode.** A throwing guard in the LLM responder path is silently swallowed and legacy EXECUTE wins. A throwing guard in the service-direct path takes down the request. Auditors and ops cannot reason about kernel behavior uniformly.

### F.3 Configuration

`apps/api/src/config.ts` exports `config` from a Zod-validated env schema. **`grep "from.*config" apps/api/src/` returns 0 non-test files.** It is dead code in production.

84 `process.env.X` direct reads in `apps/api/src/` (non-test). 69 distinct env vars across the audited packages. Some are read in 5+ different files:
- `process.env.NODE_ENV` — read 22 places
- `process.env.STAFF_ALERT_PHONE` — read in 4 subscribers
- `process.env.REDIS_URL` — read in 2 places (one in `tools`, one in `nats-client`)

The pattern at `intent-audit-wiring.ts:94-104`:
```ts
function bufferCapacity(): number {
  const raw = process.env.IBX_AUDIT_BUFFER_CAPACITY
  if (!raw) return 1_000
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(...)
    return 1_000
  }
  return parsed
}
```

This pattern is re-implemented at:
- `payment-projection-policy.ts:185-211` (3 of these functions: confirm threshold, escalate threshold, regen cap)
- `pack-payments/src/types.ts` (same 3 functions, also reading the same env vars)
- `cart-intelligence.ts`, every subscriber, every job — same pattern, different defaults, different validation

Boot-time validation runs in `config.ts` but the consumers don't trust the validation. They re-validate. The fail mode for a typo in `IBX_AUDIT_BUFFER_CAPACITY=1_000_000_000` is a warn-and-default, not a boot failure.

---

## Section G — Abstractions critique

### G.1 `withAdjudicate` decision-kind handling

The switch at `with-adjudicate.ts:166-186` handles all 6 decision kinds:
- EXECUTE → run executor on `envelope.payload`
- REWRITE → run executor on `decision.rewritten.payload`
- REFUSE, DEFER, REQUEST_CONFIRMATION, ESCALATE → return decision, do not call executor

This is correct per the kernel contract. **But the caller-side handling is asymmetric.** REFUSE/DEFER/CONFIRMATION/ESCALATE all return `{ decision }` with `result: undefined`. The caller must inspect `decision.kind` to distinguish them. The type system makes `result` `R | undefined`, which TS will let the caller `result!` past in a moment of weakness. That's a runtime trap.

The cleaner shape is a discriminated union:
```ts
type AdjudicatedResult<R> =
  | { kind: "executed", decision: Decision, result: R }
  | { kind: "skipped", decision: Decision };
```

That would force the caller to narrow before touching `result`. As written, the abstraction lets the caller forget.

### G.2 `setResumeIntentDispatcher` — singleton seam vs explicit injection

`defer-resolver.ts:100`: `let _dispatcher: ResumeIntentDispatcher | null = null` — module-level mutable state.

`index.ts:120`: `setResumeIntentDispatcher(createResumeDispatcherAdapter({ log: server.log }))` — called once during boot.

This is a *deliberate* seam to break the dependency cycle between the subscriber and the intent dispatcher (the comment at `defer-resolver.ts:80-87` says so). But it has two problems:

1. **It is invisible to tests.** A test that imports `resolveDeferredSession` without first calling `setResumeIntentDispatcher` will get `_dispatcher === null` and the resume will succeed-via-audit-only. The tests would still pass. Production behavior would diverge.
2. **Boot-ordering hazard (per E.1 above).** Between subscriber-start and dispatcher-wire, the dispatcher is null and inbound payment-confirmed events silently land in the "audit-only" branch.

The alternative is explicit DI: `startDeferResolverSubscriber({ log, dispatcher })`. That breaks the cycle (no module-level state) and makes the boot order explicit (you can't start the subscriber without the dispatcher). The cost is one more `await import` or one more parameter. That's the right shape.

### G.3 Audit sink composition order

From `intent-audit-wiring.ts:251-308`:

```
getAuditSink() → {
  emit(record) {
    const redacted = redactor.redact(record);         // step 1
    await buffered.emit(redacted);                     // step 2 — persistentBufferedSink
    // (buffered internally does:)
    //   - storage.add() if buffer full → SPILL TO REDIS
    //   - otherwise → multiSink(console, nats, [postgres])
  }
}
```

**Re-derived from first principles:**

We want PII never to land in NATS or Redis spill. PII reduction must happen *before* anything is written to durable storage. So redact must wrap the buffer (not the other way around).

We want at-least-once delivery. The buffer must wrap the multisink (not the other way around).

We want best-effort delivery of each inner sink. The multisink uses `Promise.allSettled` semantics so one sink's failure doesn't break others.

We want PII never to be re-emitted from spill. So the redactor MUST run *before* spill. So redactor wraps buffer.

**The current order — `redact → buffer → multi → spill` — is correct.** Verified.

But there is a subtle hazard: `buffered.emit(record)` may *spill* a record to Redis if the in-memory buffer overflows (`onOverflow` hook fires at line 270). The record being spilled is the redacted record. Good. But: the `onSpill` hook fires when a record is being written to spill **because of a failure, not capacity** (line 277-284). A failure in the multisink (e.g., Postgres connection drop) causes the buffer to retry the *redacted* record — not the original. That is correct.

But the audit redactor (per the W3 audit P0-15) was originally breaking the `auditHash` because it mutated the envelope without recomputing the hash. W3 closed that. The current ordering depends on the redactor **idempotently** producing the same redacted record on retry. If the redactor's hash secret rotates between an initial emit and a retry, the second-emit hash will differ from the spill record's hash. Replay would catch this; the contract is "audit hash is computed AT BUILD TIME and PRESERVED, redaction recomputes hash, retries replay the redacted record." This is documented but not enforced by type.

---

## Architectural findings ranked

| # | Finding | Severity | Affected files | Migration difficulty | Blast radius |
|---|---|---|---|---|---|
| F-1 | Boot-window race: `setResumeIntentDispatcher` called after subscriber start → resumes drop in 19-line window | **P0** | `apps/api/src/index.ts:101-120`, `subscribers/defer-resolver.ts:100-117` | Low (re-order + DI) | Customer-facing PIX confirmations |
| F-2 | Policy duplication: `paymentProjectionPolicyBundle` (domain) and `paymentsPolicyBundle` (pack) both live, both used | **P1** | `packages/domain/src/services/__shared__/payment-projection-policy.ts`, `packages/pack-payments/src/policies.ts` | Medium (drift detection + canonical pack) | Refund magnitude decisions diverge |
| F-3 | `runCustomerIntent` shadow/legacy default-EXECUTE bypasses kernel for non-enforce kinds | **P1** | `apps/api/src/routes/__shared__/customer-intent-gateway.ts:188-208` | Medium (deprecate legacy branch) | All customer route mutations |
| F-4 | `@deprecated` bare-arg methods still wired to ~6 mutation paths | **P1** | `routes/order-actions.ts:137,256,267,1049,1057,1065`, `tools/cart/cancel-order.ts:41`, `tools/cart/regenerate-pix.ts:89` | Low (migrate callers + delete methods) | Order/payment status transitions |
| F-5 | NATS auth code paths exist but production is fail-open: `console.error` warning, not exit | **P0 (security)** | `packages/nats-client/src/index.ts:117-130` | Low (throw in prod when no auth) | Audit PII, forged resume signals |
| F-6 | `apps/api/src/config.ts` is dead code; 84 direct `process.env` reads in app + 50+ in packages | **P2** | `apps/api/src/config.ts`, every consumer | High (rewrite every config read site) | Misconfiguration surfaces at runtime |
| F-7 | Subscriber idempotency pattern is per-author; no shared primitive | **P2** | 9 subscriber files | Medium (extract `withSubscriberDedup` helper) | New subscribers re-introduce P0-8-class bugs |
| F-8 | `@ibatexas/domain` depends on 4 Packs (inverted layering) | **P2** | `packages/domain/package.json:32-35`, `packages/domain/src/services/*.ts` | High (rethink Pack/domain boundary) | Pack reuse outside ibatexas blocked |
| F-9 | `audit.intent.decision.v1` NATS subject runs without listeners in default config; doubles audit-emit work | **P2** | `packages/llm-provider/src/intent-audit-wiring.ts:208-217` | Low (feature-flag NATS publish) | Wasted CPU + PII spill vector |
| F-10 | `OrderProjectionState` vs `OrderState` width subtyping silently default-REFUSES misrouted envelopes | **P2** | `pack-orders/src/types.ts`, `domain/__shared__/order-projection-policy.ts` | Medium (nominal types or shape branding) | Silent guard misfires |
| F-11 | `AdjudicatedResult<R>` has `result?: R` instead of discriminated union — `result!` is a foot-gun | **P3** | `packages/domain/src/services/__shared__/with-adjudicate.ts:62` | Low (type-refactor) | Caller bugs not caught at compile time |
| F-12 | Console-based logging in `@ibatexas/llm-provider` (113 sites); no shared logger contract | **P3** | `packages/llm-provider/src/*.ts` | Medium (W6-10 finish) | reqId correlation lost on warnings |
| F-13 | Pack `policy()` throws are handled differently across call sites (fail-open in LLM path, fail-closed in service path) | **P2** | `kernel-executor.ts`, `customer-intent-gateway.ts:198-201`, `with-adjudicate.ts:166` | Medium (unify error policy) | Inconsistent kernel-failure semantics |
| F-14 | `withAdjudicate` requires caller to thread Pack identity — service is coupled to **two** Packs (`ordersPolicyBundle` AND `orderProjectionPolicyBundle`) | **P3** | `packages/domain/src/services/order-command.service.ts:478,489,544` | Medium (per-method policy binding) | Adding a third Pack to a service grows N×N |
| F-15 | Shutdown sequence is linear happy-path; no failure handling between steps | **P3** | `apps/api/src/index.ts:59-66` | Low (Promise.allSettled-style) | SIGTERM during DB outage leaks NATS messages |

---

## Anti-patterns observed (with citations)

### AP-1 — "Polite fiction" layering

`packages/domain` depends on `packages/pack-orders`, `pack-customer-onboarding`, `pack-reservations`, `pack-whatsapp` (per `packages/domain/package.json:32-35`). Conceptually domain should be the bottom layer; instead it depends on policy descriptions of itself. The Pack/domain split is a structural decomposition for boot-time conformance assertion, not a reusability story.

### AP-2 — "Documented invariant, type-permitted violation"

`AdjudicatedResult<R>` (`with-adjudicate.ts:60-63`) documents at line 232 that "EXECUTE/REWRITE always populate result" but the type says `result?: R`. The `expectExecute<R>` helper at line 228-244 throws if `result === undefined` — a runtime check for a type-level invariant. A discriminated union would lift this to compile time.

### AP-3 — "Shadow as feature, not safety net"

`customer-intent-gateway.ts:188-208` and `kernel-executor.ts` both implement "if shadow → adjudicate but ignore decision, default EXECUTE." This was designed as a safe-rollout mechanism. In practice, shadow mode is the **default** for every kind not on the enforce list. The system runs as "default EXECUTE, opt-in adjudicate" in shadow, which is the opposite of the documented "default-deny" invariant from `governance/04-decision-policy.md`.

### AP-4 — "Re-derived dedup"

9 subscribers, 9 different idempotency-key conventions (per Section D.2 table). A new subscriber author has no canonical pattern to copy. The W3 audit's P0-8 (defer-resolver dedup-before-dispatch) was a direct consequence: the author picked the simplest pattern, which was unsafe.

### AP-5 — "Singleton seam masquerading as DI"

`setResumeIntentDispatcher` (`defer-resolver.ts:108`) and `_setAuditSinkDependencies` (`intent-audit-wiring.ts:126`) and `_resetKernelRegistry` (`kernel-bootstrap.ts:67`) are module-level mutable state with setter functions. They are documented as "test isolation" affordances but production also calls `setResumeIntentDispatcher` at boot. The boot-ordering hazard (F-1) is a direct consequence.

### AP-6 — "Console as logger"

`packages/llm-provider/src/llm-responder.ts` has 16 `console.warn`/`console.error` calls. None of them carry `reqId`. The pino logger lives in `apps/api/src/lib/logger.ts` and is not reachable from package code. The W6-10 fix's pattern (`resolveLogger(loggerOrNull)`) **lets** packages take a logger but does not **require** them to — the default falls back to console.

### AP-7 — "Env var as configuration"

69 distinct env vars, 137 direct `process.env.X` reads across the audited packages. `config.ts` exists but is unused. Every typed-config consumer is opt-in; the default is "read env directly." Boot-time validation is structurally optional.

---

## Recommendations: target architecture for next 12 months

### Quarter 1 — Plug the leaks

**R1. Re-order boot so subscribers start before traffic, and DI the dispatcher.**
- Move subscriber start before `server.listen`.
- Make `startDeferResolverSubscriber({ dispatcher })` accept the dispatcher as a parameter; delete `setResumeIntentDispatcher`.
- Closes F-1, eliminates AP-5.

**R2. Promote one of the two payment bundles to canonical, delete the other.**
- The `paymentsPolicyBundle` from `@ibatexas/pack-payments` is the documented authoritative source.
- Replace `paymentProjectionPolicyBundle` usage in `payment-command.service.ts` with the Pack bundle.
- Add a CI check that asserts no `payment-projection-policy.ts`-style file ships in `domain/__shared__/`.
- Closes F-2.

**R3. Fail-closed on NATS auth in production.**
- Change `nats-client/src/index.ts:117-130` from `console.error` warning to `throw new Error(...)`.
- Hard-block startup when `NODE_ENV=production && !authenticator && !tls`.
- Closes F-5.

**R4. Delete the `runCustomerIntent` legacy-EXECUTE fallback for non-`ALWAYS_ENFORCE` kinds.**
- Routes always adjudicate. Shadow mode still records the audit; legacy fallback is removed.
- Migrate kind-by-kind via the existing shadow infrastructure (the divergence dashboard catches false-REFUSE before flipping enforce).
- Closes F-3.

### Quarter 2 — Eliminate the parallel surface

**R5. Delete the `@deprecated` bare-arg methods from `OrderCommandService` and `PaymentCommandService`.**
- Migrate the 6 known callers in one PR (the call sites are well-known per Section A.3).
- Remove the legacy interface members entirely so the type system prevents regression.
- Closes F-4.

**R6. Extract `@ibatexas/log` as a workspace package.**
- pino-compatible interface; no console fallback.
- Lint rule: `no-console` in `packages/**/src/`.
- Every existing `console.*` migrates.
- Closes F-12 and AP-6.

**R7. Extract `@ibatexas/config` as a workspace package.**
- Single Zod schema (the one already in `apps/api/src/config.ts`).
- Every package imports `config.IBX_KERNEL_ENFORCE` instead of `process.env.IBX_KERNEL_ENFORCE`.
- Lint rule: `no-process-env` in `packages/**/src/`.
- Closes F-6 and AP-7.

### Quarter 3 — Restructure the Pack/domain layering

**R8. Reverse the Pack/domain dependency direction.**
- `packages/pack-orders` ceases to define `OrderState` and `OrderPayload` types — those move to `@ibatexas/types`.
- Pack only ships the `PolicyBundle` + `CapabilityPlanner` + refusals.
- `@ibatexas/domain` no longer imports from `pack-orders`; it imports types from `@ibatexas/types` and policies from `pack-orders` *only* at construction time (services accept a `PolicyBundle` parameter, not a hard import).
- Closes F-8 and AP-1.

**R9. Introduce `@ibatexas/subscriber-toolkit` with a `withSubscriberDedup({ key, ttl, handler })` primitive.**
- All 9 subscribers migrate to this primitive.
- The dedup pattern is unified; new subscribers cannot skip it.
- Closes F-7 and AP-4.

### Quarter 4 — Type-level lockdown

**R10. Make `AdjudicatedResult<R>` a discriminated union.**
- `{ kind: "executed", decision, result } | { kind: "skipped", decision }`.
- All callers must narrow before touching `result`; `expectExecute` becomes redundant.
- Closes F-11 and AP-2.

**R11. Make `OrderState` and `OrderProjectionState` nominal types.**
- Add a phantom-type brand (e.g. `__brand: "OrderState"`).
- Compiler refuses to pass an `OrderProjectionState` where `OrderState` is expected.
- Closes F-10.

**R12. Decide the audit-NATS subject feature flag.**
- Default `IBX_AUDIT_NATS_ENABLED=false` in single-process deployments.
- Only enable when audit-consumer runs as a separate process.
- Closes F-9.

---

## Verdict per major module

| Module | Health | One-line verdict |
|---|---|---|
| `@adjudicate/core` (upstream) | HEALTHY | Framework primitives are correct; adopter layer leaks the invariants. |
| `@ibatexas/pack-orders` | HEALTHY | Largest pack, cleanest policy. The 22 intent kinds and the conformance corpus pin behavior. |
| `@ibatexas/pack-payments` | NEEDS REFACTOR | Duplicates the domain-internal payment bundle. Pick one. |
| `@ibatexas/pack-reservations` | HEALTHY | Per remediation report — fully production-ready. |
| `@ibatexas/pack-whatsapp` | HEALTHY | Post-W4 P1-G fix; auth-phase refuses are explicit. |
| `@ibatexas/pack-customer-onboarding` | HEALTHY | LGPD anonymize lifecycle test pins the critical paths. |
| `@ibatexas/domain` | NEEDS REFACTOR | Layering inversion; duplicate policies; deprecated bare-arg surface still wired. |
| `@ibatexas/llm-provider` | NEEDS REFACTOR | 113 `console.*` calls; the audit-sink composition is correct but fragile. |
| `@ibatexas/nats-client` | NEEDS REFACTOR | Auth code exists, doesn't fail-closed in prod; outbox is patchy. |
| `@ibatexas/tools` | HEALTHY | Mostly read-side; remaining 4 mutating tools (cart/*) go through the kernel via services. |
| `apps/api` (routes) | NEEDS REFACTOR | `customer-intent-gateway` legacy branch + 6 bare-arg call sites. |
| `apps/api` (subscribers) | NEEDS REFACTOR | Idempotency is per-author; boot ordering has a 19-line race window. |
| `apps/api` (jobs/workers) | HEALTHY | No-show-checker and PIX-expiry now flow through envelopes. |
| `apps/api` (config) | UNHEALTHY | Centralized config exists, no one uses it. |
| `apps/api` (shutdown) | NEEDS REFACTOR | Linear happy-path; one failure leaks downstream. |

---

## Closing observation

The remediation report (`REMEDIATION-COMPLETE.md`) is accurate: it closed every P0/P1 it claimed to. The 30-finding audit was thorough.

**What it didn't catch is the second-derivative architectural debt.** The W3 audit found bugs *inside* abstractions; this audit finds the abstractions themselves are starting to drift. The chokepoint is in two implementations. The Pack/domain layering has inverted. The 6-decision-kind contract has 3 different error-policy interpretations across the codebase. The "default-deny" invariant is documented but the route gateway defaults to EXECUTE on every non-enforce kind.

None of these will cause an incident next week. All of them will be *expensive* to fix in 6-12 months when the surface area triples. The recommendations above are sequenced so each closes one bag of debt before the next layer is added.

The kernel framework is the right shape. The adopter layer is starting to bend it.
