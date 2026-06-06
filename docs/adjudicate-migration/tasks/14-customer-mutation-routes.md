# Task 14 — Customer-Facing Mutation Routes

**Milestone:** M3 (Mutation-entrypoint governance)
**Estimated effort:** L — 5–7 dev-days
**Blocks:** M3 enforce flips for customer surfaces
**Blocked by:** 01, 04 (set_pix_details), 08 (pack-orders), 18 (audit redactor), 21 (pack-customer-onboarding — owns `account.*` intents)
**Owner:** unassigned

## Objective

Wrap customer-facing mutating routes in IntentEnvelopes routed through `adjudicate()`. After this lands, the eight overlapping LLM-tool/HTTP routes ("same function, two security models" per investigation 02) share a single governance path: every customer-initiated mutation produces an envelope with `actor.principal = "user"`.

Scope:
- `POST /api/cart/checkout` — order placement, Stripe PI create, Payment row
- `POST /api/orders/:id/cancel` — customer cancel
- `POST /api/orders/:id/amend` and `POST /api/orders/:id/amend/batch` — amend
- `POST /api/orders/:id/payment/retry` — payment retry
- `POST /api/orders/:id/payment/regenerate-pix` — regen PIX
- `PATCH /api/orders/:id/payment/method` — switch payment method
- `PATCH /api/orders/:id/address` — change delivery address
- `PATCH /api/orders/:id/type` — switch order type
- `POST /api/cart/:id/line-items` etc. (cart write routes)
- `DELETE /api/me/data` — LGPD anonymize (adds OTP re-verification per investigation 08 P0 #2)

## Architecture context

Cite: investigation 02 P0 #3-#6 + P1 #14-#19 + investigation 08 P0 #2 + P1 #5.
> "HTTP routes duplicate tool logic. `amendOrder`, `changeDeliveryAddress`, `switchOrderType`, `createCheckout`, `createReservation`, `cancelReservation`, `modifyReservation`, `joinWaitlist` are all tools in `TOOL_CLASSIFICATION.MUTATING` *and* HTTP endpoints. The LLM call is gated; the HTTP call is not. **Same function, two security models.**"
> "LGPD anonymize is unconfirmed + unadjudicated + one-click destructive. `DELETE /api/me/data` immediately wipes addresses + preferences and anonymizes the customer record. ... Effort: ~2 days. Fix: (a) put `/api/me/data` behind a fresh-OTP gate ... (b) produce an `IntentEnvelope<customer.anonymize, ...>` so adjudicate gets a chance to refuse or DEFER."

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/cart.ts` (checkout, line-items)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/order-actions.ts` (cancel, amend, retry, regen-pix, switch-method, address, type)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/me.ts` (anonymize)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/reservations.ts` (create, modify, cancel, waitlist)
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/` and `packages/pack-reservations/`

**Modify (one PR per route grouping recommended):**
- `apps/api/src/routes/cart.ts`
- `apps/api/src/routes/order-actions.ts`
- `apps/api/src/routes/me.ts`
- `apps/api/src/routes/reservations.ts`

**Create:**
- `apps/api/src/routes/__shared__/customer-intent-gateway.ts` (thin "API intent gateway" pattern from investigation 02 §"Phase API-2")
- `apps/api/src/routes/__tests__/customer-mutation-governance.test.ts`
- `apps/api/src/routes/me/anonymize-otp-gate.ts` (OTP re-verification flow)

## Constraints

- Customer routes use `actor.principal = "user"`, `taint = "UNTRUSTED"`, `sessionId = customerId`.
- Must preserve existing auth (JWT cookie), ownership checks (`verifyOwnership`), rate limits (e.g. 5 cancels/10 min). Adjudicate is additive.
- LGPD anonymize:
  - Requires fresh OTP within last 5 minutes (`POST /api/me/data/initiate-deletion` issues OTP; `DELETE /api/me/data?token=...` accepts the verified token). 5-minute TTL chosen over the default 10 to tighten the replay window on irreversible operations.
  - Produces `IntentEnvelope<"customer.anonymize", ...>` adjudicated by `@ibatexas/pack-customer-onboarding` (task 21).
  - 24h grace period: park as DEFER with signal `customer.anonymize.confirmed_after_grace`; if the customer cancels within 24h, REFUSE the resumed intent.
- Each route's HTTP signature unchanged (caller backwards-compatible).
- pt-BR for any new user-facing strings.

## Implementation requirements

1. **Customer intent gateway** (`customer-intent-gateway.ts`):
   - `runCustomerIntent<K, P>(envelope: IntentEnvelope<K, P>, ctx: CustomerCtx, pack: PackV0): Promise<DispatchResult>`
   - Calls `adjudicate(envelope, state, pack.policy)`, emits audit, branches on decision, runs the underlying tool function (from `packages/tools/`) on EXECUTE.

2. **Refactor `POST /api/cart/checkout`** as first proof-of-concept:
   - Build `IntentEnvelope<"order.checkout.create", CheckoutPayload>` with `actor.principal = "user"`.
   - Call `runCustomerIntent(envelope, ctx, ordersPack)`.
   - On EXECUTE: call existing `createCheckout()` tool function with the payload.
   - On REFUSE: 403 with refusal text (localized via Task 11's `localizeDecision`).
   - On DEFER: 202 with `{status: "deferred", message: "Aguardando confirmação..."}` (PIX-pending path).
   - On REWRITE: execute rewritten payload (e.g. quantity clamp).

3. **Repeat for the other 7 customer order routes** — cancel, amend, retry, regen-pix, switch-method, address, type.

4. **LGPD anonymize:**
   - `POST /api/me/data/initiate-deletion` — issues fresh OTP via Twilio Verify; stores `rk('anonymize:otp:{customerId}')` with 5min TTL (tighter than the standard login OTP because deletion is irreversible).
   - `DELETE /api/me/data?token={otpCode}`:
     - Verify OTP.
     - Build `IntentEnvelope<"customer.anonymize", {customerId, scope: "lgpd_art_18"}>`.
     - Adjudicate. The policy SHOULD return DEFER with signal `customer.anonymize.confirmed_after_grace` and `timeoutMs = 24h`.
     - Persist deletion-intent receipt (`rk('anonymize:pending:{customerId}')`) with 24h TTL.
     - Return 202 `{status: "deferred", message: "Pedido de exclusão recebido. Você tem 24 horas para cancelar."}`.
   - `POST /api/me/data/cancel-deletion` (during grace):
     - Build `IntentEnvelope<"customer.anonymize.cancel", ...>` → REFUSE the parked deletion intent.
   - At 24h expiry, the timeout sweeper (Task 03) fires `intent.defer.timeout`; a new subscriber consumes it and runs the actual `anonymizeCustomer` if the intent kind matches.

5. **Cart line-item routes** (`POST /api/cart/:id/line-items`, PATCH, DELETE, `POST /api/cart/:id/sync`) — wrap each in `order.cart.{add|update|remove}` envelopes via the gateway.

6. **Tests** (`customer-mutation-governance.test.ts`):
   - Per route: EXECUTE happy path; REFUSE → 403 + audit; DEFER → 202; REWRITE → executes rewritten.
   - Anonymize:
     - Initiate-deletion without OTP → 401.
     - Initiate-deletion success → OTP sent (Twilio mock asserts).
     - DELETE with valid OTP → 202 + deferred audit + receipt in Redis.
     - Cancel-deletion within 24h → REFUSE the deletion; receipt cleared.
     - Timeout after 24h with no cancel → anonymize runs.

## Acceptance criteria

- [ ] All 8 order routes wrapped via `runCustomerIntent`.
- [ ] All 4 cart line-item routes wrapped.
- [ ] Anonymize requires fresh OTP, parks as DEFER with 24h grace, supports cancel.
- [ ] `actor.principal = "user"`, `taint = "UNTRUSTED"` for all customer envelopes.
- [ ] Audit records contain customerId (hashed/redacted via Task 18).
- [ ] All governance tests pass.
- [ ] `pnpm --filter @ibatexas/api typecheck` passes.

## Testing requirements

- **Unit:** customer-mutation-governance.test.ts.
- **Integration:** end-to-end checkout flow against a Fastify test instance with mocked Stripe + Medusa.
- **Bypass-detection:** assert that ALL `prisma.payment.update`/`prisma.order_projection.update` calls from these routes happen INSIDE an `adjudicate() === EXECUTE` branch.

## Rollout notes

Land BEHIND `IBX_KERNEL_SHADOW` first for all customer intent kinds. Per runbook 02-03, require:
- 7 days clean shadow for cart mutations.
- 14 days clean shadow for checkout + cancel + amend.
- 14 days clean shadow + two-person on-call for anonymize.

Enforce-flip order: cart → cancel/amend → checkout → anonymize (most destructive last).

## Rollback notes

Soft rollback per intent kind via `IBX_KERNEL_ENFORCE` removal. Hard rollback via PR revert. Pending anonymize-deferred intents within the 24h window: on rollback, the timeout sweeper still fires; subscriber must be revert-safe (early-return if pack-orders no longer has the intent kind). ETA: 30 min for hard rollback. No data loss except: customers in flight during anonymize cancel may need to re-cancel.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 14: customer-facing mutation routes governance + LGPD anonymize OTP gate.

CONTEXT
Per investigation 02 (P0 #3-#6, P1 #14-#19) and 08 (P0 #2, P1 #5) in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/:
- 12 customer-facing mutating routes bypass the kernel
- The same functions (amendOrder, createCheckout, etc.) are gated when called by the LLM but not when called via HTTP — same function, two security models
- DELETE /api/me/data is one-click destructive with no OTP re-verification and no grace period; LGPD-relevant, irreversible

Your job: wrap each customer route in adjudicate, share a customer-intent-gateway helper, and add OTP gate + 24h grace + DEFER to anonymize.

REPO LAYOUT
- apps/api/src/routes/cart.ts (checkout + line-items)
- apps/api/src/routes/order-actions.ts (cancel, amend, retry, regen-pix, switch-method, address, type)
- apps/api/src/routes/me.ts (anonymize, data export)
- apps/api/src/routes/auth.ts (Twilio Verify OTP — pattern for fresh-OTP gate)
- apps/api/src/whatsapp/session.ts (UUID + Lua lock release reference)
- packages/pack-orders, packages/pack-reservations (Task 08/09), packages/pack-customer-onboarding (Task 21)
- packages/tools/src/cart/* (the underlying tool functions to call on EXECUTE)
- packages/domain/src/services/customer.service.ts (anonymizeCustomer impl)
- @adjudicate/core, @adjudicate/runtime exports

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- apps/api/src/routes/__shared__/customer-intent-gateway.ts (CREATE)
- apps/api/src/routes/__tests__/customer-mutation-governance.test.ts (CREATE)
- apps/api/src/routes/me/anonymize-otp-gate.ts (CREATE)
- apps/api/src/routes/cart.ts (MODIFY — wrap checkout + cart line-item routes)
- apps/api/src/routes/order-actions.ts (MODIFY — wrap 7 order routes)
- apps/api/src/routes/me.ts (MODIFY — refactor anonymize into 3 endpoints: initiate, delete, cancel)
- apps/api/src/subscribers/anonymize-grace-resolver.ts (CREATE — consumes intent.defer.timeout for customer.anonymize intents)
- apps/api/src/index.ts (MODIFY — register the grace resolver subscriber)
- (DO NOT modify pack-customer-onboarding here — those intents are owned by Task 21; this task only consumes them)

PHASES

Phase A — Intent gateway helper (customer-intent-gateway.ts):
1. Export runCustomerIntent<K, P>(envelope: IntentEnvelope<K, P>, ctx: CustomerCtx, pack: PackV0, executor: (payload) => Promise<unknown>): Promise<{status, body}>
2. Internals:
   - Call adjudicate(envelope, state, pack.policy)
   - Emit audit record via getAuditSink().emit
   - Switch:
     * EXECUTE → await executor(envelope.payload); return {status: 200, body: result}
     * REWRITE → await executor(decision.rewritten.payload); return {status: 200, body: result}
     * REFUSE → return {status: 403, body: {error: localizeDecision(decision, portugueseRefusalMessages).refusal.userFacing}}
     * DEFER → parkDeferredIntent(...); return {status: 202, body: {status: "deferred", message: "Aguardando confirmação...", signal: decision.signal}}
     * REQUEST_CONFIRMATION → return {status: 202, body: {confirmationRequired: true, prompt: decision.prompt}}
     * ESCALATE → return {status: 503, body: {message: "Operação requer atendimento humano."}}

Phase B — Order routes (cart.ts + order-actions.ts):
3. POST /api/cart/checkout:
   - Build IntentEnvelope<"order.checkout.create", CheckoutPayload> with actor.principal="user", taint="UNTRUSTED", sessionId=req.customerId
   - Call runCustomerIntent(envelope, ctx, ordersPack, createCheckout)
   - Return the body the gateway returns
4. POST /api/orders/:id/cancel — kind "order.cancel"
5. POST /api/orders/:id/amend — kind "order.amend"
6. POST /api/orders/:id/amend/batch — kind "order.amend.batch"
7. POST /api/orders/:id/payment/retry — kind "order.payment.retry"
8. POST /api/orders/:id/payment/regenerate-pix — kind "order.pix.regenerate"
9. PATCH /api/orders/:id/payment/method — kind "order.payment.switch_method"
10. PATCH /api/orders/:id/address — kind "order.address.change"
11. PATCH /api/orders/:id/type — kind "order.type.switch"
12. Cart line-items: POST /api/cart/:id/line-items (kind "order.cart.add"), PATCH (kind "order.cart.update"), DELETE (kind "order.cart.remove"), POST /sync (kind "order.cart.sync")

Phase C — LGPD anonymize OTP gate (me.ts + anonymize-otp-gate.ts):
13. The `customer.anonymize` and `customer.anonymize.cancel` intents are owned by `@ibatexas/pack-customer-onboarding` (task 21). This task DOES NOT define those intents — it consumes them. Task 21's pack must provide:
    - `customer.anonymize`: business guard that returns `decisionDefer({signal: "customer.anonymize.confirmed_after_grace", timeoutMs: 24 * 60 * 60 * 1000, basis: [...]})`.
    - `customer.anonymize.cancel`: business guard that REFUSEs a parked `customer.anonymize` intent by checking `rk('anonymize:pending:{customerId}')`.
14. POST /api/me/data/initiate-deletion:
    - Auth: requireAuth (customer JWT)
    - Issue Twilio Verify OTP via existing verifyChannel; store rk('anonymize:otp:{customerId}') = otpHash with 300s TTL (5 minutes — tighter than the standard login OTP window because the action is irreversible)
    - Return 202 {message: "OTP enviado. Verifique o WhatsApp."} in pt-BR
15. DELETE /api/me/data?token={otpCode}:
    - Verify OTP against the stored hash
    - Build IntentEnvelope<"customer.anonymize", {customerId, scope: "lgpd_art_18"}> with actor.user
    - runCustomerIntent → expected DEFER → park
    - Persist rk('anonymize:pending:{customerId}') = parkedAt timestamp, 24h TTL
    - Return 202 {status: "deferred", message: "Pedido de exclusão recebido. Você tem 24 horas para cancelar.", canCancelUntil: parkedAt + 24h}
16. POST /api/me/data/cancel-deletion (within 24h):
    - Auth: requireAuth
    - Check rk('anonymize:pending:{customerId}') exists
    - Build IntentEnvelope<"customer.anonymize.cancel", {customerId}> → adjudicate → expected REFUSE of the parked deletion
    - DEL rk('anonymize:pending:{customerId}')
    - Audit-record
    - Return 200 {message: "Pedido de exclusão cancelado."}

Phase D — Grace resolver subscriber (anonymize-grace-resolver.ts):
17. New NATS subscriber on intent.defer.timeout (published by Task 03's defer-timeout-sweeper)
18. Filter for envelope.kind === "customer.anonymize"
19. Verify rk('anonymize:pending:{customerId}') still exists (i.e. NOT cancelled)
20. If so: call customerSvc.anonymizeCustomer(customerId) under withLock
21. Audit-record EXECUTE supersedes [parked.intentHash]
22. DEL rk('anonymize:pending:{customerId}')
23. Register the subscriber in apps/api/src/index.ts alongside other subscribers

Phase E — Tests (customer-mutation-governance.test.ts):
24. For each of the 12 routes: EXECUTE / REFUSE / DEFER / REWRITE happy paths
25. Anonymize: initiate-deletion (OTP required), delete with valid OTP (202 deferred), cancel-deletion within 24h (200 success), no cancel within 24h → grace resolver fires anonymize

CONSTRAINTS
- Read CLAUDE.md rules 4, 5, 7, 9, 10 first
- pt-BR for all user-facing strings (rule #4)
- Twilio Verify WhatsApp OTP per rule #5
- rk() for Redis keys (rule #7)
- UUID + Lua release for locks (rule #10) — if you add any locks (anonymize step likely needs one)
- Preserve existing auth + ownership + rate limits — adjudicate is additive
- TypeScript strict, ESM, .js extensions on local imports
- DO NOT modify packages/tools — call existing tool functions on EXECUTE
- DO NOT skip Task 18 (audit redactor) — this task DEPENDS ON it for customer-id redaction in audit records

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] customer-intent-gateway.ts: runCustomerIntent works for all 6 decision outcomes
- [ ] 12 customer routes wrapped (8 order + 4 cart line-item)
- [ ] Anonymize: 3 endpoints (initiate, delete, cancel-deletion) + 24h grace + DEFER
- [ ] anonymize-grace-resolver subscribes to intent.defer.timeout for customer.anonymize intents
- [ ] All governance tests pass (12 routes × 4 decision outcomes + anonymize flows)
- [ ] `pnpm --filter @ibatexas/api typecheck` passes
- [ ] PR description flags Task 18 dependency (audit redactor)

When complete, return: files modified, test output, list of pack-orders intent kinds added, and any open questions about the anonymize grace cancel UX.
```
