# Task 12 — Stripe Webhook Governance

**Milestone:** M3 (Mutation-entrypoint governance)
**Estimated effort:** L — 5–7 dev-days
**Blocks:** 19 (audit-postgres adopts the new audit volume), M3 enforce flips
**Blocked by:** 01, 08 (pack-orders), 18 (audit redactor must land before any PII-bearing audit records go to NATS)
**Owner:** unassigned

## Objective

Wrap all Stripe webhook handlers in `apps/api/src/routes/stripe-webhook.ts` as `system.webhook` actor IntentEnvelopes routed through the kernel. After this lands, every Stripe-driven mutation (PIX cart completion → order placement, refunds, disputes, cancellations) flows through `adjudicate()` with `actor.principal = "system"`, `taint = "SYSTEM"`, and produces an audit record. This is the highest-blast-radius single mutation path in the system; bringing it under kernel governance closes investigation 02 P0 #1.

## Architecture context

Cite: investigation 02 §"Webhook handlers (deep dives)" + P0 #1.
> "The webhook is **the highest-risk single mutation path in the system.** It (1) **Creates orders** that the LLM/agent never proposed (PIX cart completion). Adjudicate has no visibility — there is no envelope, no policy bundle, no ledger entry. (2) **Issues refunds and disputes**, which are state transitions Pack #pix-payments was created to govern, yet the kernel never sees them. (3) Couples Stripe wire vocabulary ... to internal `PaymentStatus` via `reconcileFromWebhook` — a duplicate of policy logic that should be in the kernel."

Five event types currently handled:
- `payment_intent.succeeded` — creates orders, Payment rows, publishes `order.placed`, `payment.status_changed`
- `payment_intent.payment_failed` — `order.payment_failed`
- `charge.refunded` — `order.refunded`
- `charge.dispute.created` — `order.disputed`
- `payment_intent.canceled` — `order.canceled`

Cite: investigation 03 §"Highest-risk unadjudicated mutations" P0 #1.

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/stripe-webhook.ts` (full file)
- `/Users/thaisrodolpho/projects/ibatexas/packages/domain/src/services/payment-command.service.ts` (`reconcileFromWebhook`)
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src/policies.ts` (Task 08 — needs to handle webhook intents)
- `/Users/thaisrodolpho/projects/adjudicate/packages/pack-payments-pix/src/policies.ts` (reference for PIX intents)

**Modify:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/stripe-webhook.ts` — wrap each handler in envelope + adjudicate
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src/policies.ts` — add guards for webhook-driven intent kinds (`order.placed_via_webhook`, `payment.reconcile_from_webhook`, `order.refund_from_webhook`, `order.dispute_from_webhook`, `order.cancel_from_webhook`)

**Create:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/stripe-webhook-envelopes.ts` (envelope factories per Stripe event)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/__tests__/stripe-webhook-governance.test.ts`

## Constraints

- Must preserve idempotency — the existing `webhook:processed:{event.id}` Redis NX dedup must wrap the adjudicate-then-execute block.
- Must preserve atomicity — Stripe expects 200 OK within ~10s. The adjudicate path adds <100ms p99 (per investigation 07's SLO); the audit emission is fire-and-forget through the buffered sink.
- Actor identity: `actor.principal = "system"`, `actor.sessionId = "stripe-webhook:" + event.id`, `taint = "SYSTEM"`.
- Correlation: use `event.id` (Stripe-assigned) as the envelope's `nonce` so the intentHash is deterministic per Stripe event (replay-safe).
- If `adjudicate()` returns REFUSE, the webhook MUST still return 200 to Stripe (to prevent retry storms) BUT must:
  - Log the refusal at error level
  - Push to DLQ (`apps/api/src/subscribers/dlq.ts`) for operator review
  - Emit an alert via Sentry
- If `adjudicate()` returns DEFER, park the envelope per Task 03's flow — the deferred path will resume later.
- If REWRITE, execute the rewritten payload (e.g. a refund clamp guard could reduce the amount).
- Follow CLAUDE.md rule #10 — existing Redis lock pattern preserved.
- pt-BR not relevant (operator-facing logging).

## Implementation requirements

1. **Author `stripe-webhook-envelopes.ts`** with one factory per Stripe event:
   - `buildPaymentIntentSucceededEnvelope(event, paymentIntent): IntentEnvelope<"order.placed_via_webhook", ...>`
   - `buildPaymentIntentFailedEnvelope(...)` → kind `"payment.reconcile_from_webhook"`
   - `buildChargeRefundedEnvelope(...)` → kind `"order.refund_from_webhook"`
   - `buildChargeDisputeCreatedEnvelope(...)` → kind `"order.dispute_from_webhook"`
   - `buildPaymentIntentCanceledEnvelope(...)` → kind `"order.cancel_from_webhook"`
   
   Each builds an envelope with:
   - `actor.principal = "system"`
   - `actor.sessionId = \`stripe-webhook:${event.id}\``
   - `taint = "SYSTEM"`
   - `nonce = event.id` (deterministic hash per Stripe event)
   - Payload includes the relevant Stripe object fields (PI id, amount in centavos, status, medusaOrderId from metadata, etc.)

2. **Refactor each handler in `stripe-webhook.ts`:**
   - Before existing reconcile logic, build the envelope and call:
     ```ts
     const decision = await adjudicate(envelope, currentState, ordersPack.policy);
     await getAuditSink().emit(buildAuditRecord({...}));
     switch (decision.kind) {
       case "EXECUTE": await runExistingHandler(); break;
       case "REWRITE": await runExistingHandler(extractRewrittenPayload(decision)); break;
       case "REFUSE": await logAndDlq(); break;
       case "DEFER": await parkDeferredIntent({...}); break;
       case "REQUEST_CONFIRMATION":
       case "ESCALATE": await pageOnCall(); break;
     }
     ```
   - Always return 200 OK to Stripe (regardless of decision) UNLESS the existing 5xx error paths fire (Stripe needs signal to retry on signature/parsing errors).

3. **Update `pack-orders` policies** (Task 08's output) — add guards covering the 5 webhook intent kinds. Examples:
   - State guard for `order.placed_via_webhook`: order must not already exist (Stripe replay scenario; idempotency dedup handles most but kernel double-checks).
   - Business guard for `order.refund_from_webhook`: use `createConfirmGuard` for refunds ≥ R$ 500 (50000 centavos) — REQUEST_CONFIRMATION outcome triggers ops-pages-on-call escalation.
   - Business guard for `order.dispute_from_webhook`: always ESCALATE to human staff.

4. **Audit record content** — payload includes Stripe event id, amount in centavos (CLAUDE.md rule #2), correlation to internal orderId/paymentId. PII (customer email) MUST pass through the AuditRedactor (Task 18) — list this as a dependency.

5. **Tests** (`__tests__/stripe-webhook-governance.test.ts`):
   - For each of the 5 events, EXECUTE happy path → handler runs as before.
   - REFUSE → handler does NOT run; DLQ writes the payload; 200 returned to Stripe.
   - DEFER → envelope parked; 200 returned.
   - Idempotency: deliver the same event twice → only one envelope adjudicated (Redis NX dedup at the start of the handler still wins).
   - Deterministic hash: build the envelope twice with the same event payload → identical `intentHash` (nonce = event.id is the key).
   - REWRITE: refund amount rewritten by a guard → reconcile uses the rewritten amount.

## Acceptance criteria

- [ ] All 5 Stripe handlers wrap reconcile logic in envelope + adjudicate + audit emit.
- [ ] `pack-orders` policies cover all 5 webhook intent kinds.
- [ ] On REFUSE, handler does NOT execute the mutation; DLQ + Sentry alert fire; 200 returned to Stripe.
- [ ] On DEFER, envelope parked.
- [ ] On REWRITE, rewritten payload executes.
- [ ] Idempotency preserved — Stripe replay produces zero side effects.
- [ ] Audit records produced for every Stripe event with deterministic intentHash.
- [ ] All governance tests pass.

## Testing requirements

- **Unit:** stripe-webhook-governance.test.ts.
- **Integration:** shadow-mode dry-run — deploy with `IBX_KERNEL_SHADOW=order.placed_via_webhook,payment.reconcile_from_webhook,order.refund_from_webhook,order.dispute_from_webhook,order.cancel_from_webhook` and `IBX_KERNEL_ENFORCE=` (empty). Run for 7 days; assert zero shadow divergence on production webhook traffic.
- **Bypass-detection:** add a test that asserts every call to `reconcileFromWebhook` happens INSIDE an `adjudicate(...) === EXECUTE/REWRITE` branch in the route file.

## Rollout notes

Land BEHIND `IBX_KERNEL_SHADOW` first. Watch metrics:
- `kernel_decision_total{kind="EXECUTE", intent_kind="order.placed_via_webhook"}` — expect 1 per successful PIX payment.
- `kernel_shadow_divergence_total{class="*", intent_kind=*}` — must be 0 before enforce flip.

Per runbook 04 (`docs/ops/runbooks/04-stage-financial-mutations.md`), require 14 days of clean shadow data, two-person on-call, ledger flags staged, Postgres audit lag <30s before flipping enforce.

## Rollback notes

If shadow shows unexpected REFUSE/DEFER paths:
1. **Soft rollback:** remove the intent kinds from `IBX_KERNEL_SHADOW` (5-min env-var change). Shadow telemetry stops; reconcile logic still runs untouched.
2. **Hard rollback:** revert PR. Restores direct reconcile calls. ETA: 15 min. No data loss — Stripe will replay any missed events via its own retry policy.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 12: Stripe webhook governance via system.webhook envelopes.

CONTEXT
Per investigation 02 (P0 #1) and 03 (P0 #1) in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/:
- apps/api/src/routes/stripe-webhook.ts handles 5 Stripe event types and writes orders, Payment rows, publishes NATS events with ZERO kernel review
- This is the highest-risk single mutation path in the system
- Your job: wrap each handler in a system.webhook IntentEnvelope, route through adjudicate(), branch on decision.

REPO LAYOUT
- apps/api/src/routes/stripe-webhook.ts (full handler — read it carefully)
- packages/domain/src/services/payment-command.service.ts (reconcileFromWebhook — keep unchanged; the kernel gate goes around it)
- packages/pack-orders/src/policies.ts (Task 08; you'll extend with webhook intent guards)
- apps/api/src/subscribers/dlq.ts (existing DLQ writer — use for refused webhooks)
- @adjudicate/core exports: buildEnvelope, adjudicate, buildAuditRecord, parkDeferredIntent, decisionRefuse, etc.

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- apps/api/src/routes/stripe-webhook.ts (MODIFY — wrap 5 handlers in adjudicate)
- apps/api/src/routes/stripe-webhook-envelopes.ts (CREATE — 5 envelope factories)
- apps/api/src/routes/__tests__/stripe-webhook-governance.test.ts (CREATE)
- packages/pack-orders/src/policies.ts (MODIFY — add guards for 5 webhook intent kinds)
- packages/pack-orders/src/types.ts (MODIFY — extend OrderIntentKind union with the 5 new kinds)
- packages/pack-orders/src/__tests__/conformance.test.ts (MODIFY — add fixtures for the 5 new kinds)

PHASES

Phase A — Envelope factories (stripe-webhook-envelopes.ts):
1. Export 5 functions, one per Stripe event:
   - buildPaymentIntentSucceededEnvelope(event, paymentIntent): IntentEnvelope<"order.placed_via_webhook", PlacedPayload>
   - buildPaymentIntentFailedEnvelope(event, paymentIntent): IntentEnvelope<"payment.reconcile_from_webhook", ReconcilePayload>
   - buildChargeRefundedEnvelope(event, charge): IntentEnvelope<"order.refund_from_webhook", RefundPayload>
   - buildChargeDisputeCreatedEnvelope(event, dispute): IntentEnvelope<"order.dispute_from_webhook", DisputePayload>
   - buildPaymentIntentCanceledEnvelope(event, paymentIntent): IntentEnvelope<"order.cancel_from_webhook", CancelPayload>
2. Each calls buildEnvelope with:
   - kind: per above
   - payload: relevant Stripe fields (PI id, amount in centavos, status, medusaOrderId from metadata, customer hint from metadata if present)
   - actor: {principal: "system", sessionId: `stripe-webhook:${event.id}`}
   - taint: "SYSTEM"
   - nonce: event.id (deterministic hash per Stripe event)

Phase B — Pack guard extensions:
3. In packages/pack-orders/src/types.ts: extend OrderIntentKind union with the 5 new kinds. Define payload types.
4. In packages/pack-orders/src/policies.ts: add state/business guards for each:
   - order.placed_via_webhook: state guard (order must not exist) + taint policy (system-only)
   - payment.reconcile_from_webhook: state guard (payment must exist) + taint
   - order.refund_from_webhook: business guard createConfirmGuard for amount >= 50000 centavos (R$ 500); below that → EXECUTE
   - order.dispute_from_webhook: business guard createEscalateGuard always (ESCALATE to "human")
   - order.cancel_from_webhook: state guard (order must be in cancellable state) + taint

Phase C — Handler wrapping (stripe-webhook.ts):
5. For each of the 5 event-handling code blocks:
   - Preserve the existing Redis NX dedup at the top
   - Build the envelope via the factory
   - Load current state (order/payment) for the policy
   - Call decision = await adjudicate(envelope, state, ordersPack.policy)
   - Emit audit record via getAuditSink().emit(buildAuditRecord({...}))
   - Switch on decision.kind:
     * EXECUTE: run the existing reconcile logic with envelope.payload
     * REWRITE: run with the rewritten payload (extract from decision.rewritten.payload)
     * REFUSE: log at error level + pushToDlq(eventName, payload) + addBreadcrumb to Sentry; do NOT run reconcile
     * DEFER: call parkDeferredIntent({...}) using the same path as defer-resolver from Task 03; do NOT run reconcile (resume will run it later)
     * REQUEST_CONFIRMATION: log + page on-call via Sentry severity high; do NOT run reconcile
     * ESCALATE: log + DLQ + page; do NOT run reconcile
   - Always return 200 OK to Stripe (preserve existing 5xx paths only for signature/parsing errors)
6. The intentHash is deterministic per Stripe event.id (nonce = event.id), so replay-safe.

Phase D — Tests:
7. stripe-webhook-governance.test.ts: for each of the 5 events:
   - "EXECUTE path: handler runs reconcile"
   - "REFUSE path: handler does NOT run; DLQ writes; 200 returned"
   - "DEFER path: envelope parked; 200 returned"
   - "REWRITE path: rewritten amount used"
   - "Idempotency: replay produces no side effects" (Redis NX dedup at top)
   - "Deterministic intentHash: same event payload → same hash"
8. Update conformance.test.ts in pack-orders to include fixtures for the 5 webhook intent kinds (3-4 fixtures each covering EXECUTE/REFUSE/DEFER as relevant).

CONSTRAINTS
- Read CLAUDE.md rules 2, 3, 10 first
- TypeScript strict, ESM, .js extensions on local imports
- Amount in centavos (CLAUDE.md rule #2)
- Use rk() from @ibatexas/tools for any new Redis keys (CLAUDE.md rule #7)
- DO NOT change Stripe response semantics (always 200 OK unless signature/parsing error)
- DO NOT modify payment-command.service.ts — kernel gate goes around reconcileFromWebhook
- DO NOT skip the redactor — note in PR description: this task DEPENDS ON Task 18 (audit-redactor) being merged first so PII in envelope payloads is masked before NATS audit publish

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] 5 envelope factories in stripe-webhook-envelopes.ts
- [ ] 5 handlers in stripe-webhook.ts wrap reconcile in adjudicate+branch
- [ ] pack-orders extended with 5 new intent kinds + guards
- [ ] On REFUSE: DLQ + 200 returned + no mutation
- [ ] On DEFER: envelope parked + 200 returned
- [ ] Idempotency preserved
- [ ] All governance + conformance tests pass
- [ ] `pnpm --filter @ibatexas/api typecheck` passes
- [ ] PR description flags Task 18 dependency

When complete, return: files modified, test output, and confirmation that the deterministic intentHash test passes (replay safety).
```
