# Task 16 — NATS Subscriber Governance

**Milestone:** M3 (Mutation-entrypoint governance)
**Estimated effort:** XL — 10–12 dev-days
**Blocks:** M3 enforce flips on async surface
**Blocked by:** 01, 08, 09, 10, 15, 18 (services must accept envelopes first; redactor must mask PII)
**Owner:** unassigned

## Objective

Wrap all 25 NATS subscriber handlers and 11 BullMQ jobs in system-actor IntentEnvelopes through the kernel. After this lands, every reactive mutation (auto-confirm on payment, auto-cancel on refund, stale-order cancel, notification fan-out) flows through `adjudicate()` with `actor.principal = "system"`. Highest priority: `payment-lifecycle`, `stale-order-checker`, `cart-intelligence order.placed`.

## Architecture context

Cite: investigation 04 P0 #1-#5 + §"Architectural recommendations" #2.
> "**Add adjudication to subscribers and jobs.** Every place a subscriber/job invokes a domain command service (`orderCmdSvc.transitionStatus`, `paymentCmdSvc.transitionStatus`, `paymentCmdSvc.create`) should build an `IntentEnvelope` with `actor.principal = 'system'` and pass it through `adjudicate()` with a system-actor PolicyBundle. The kernel-EXECUTE path then calls the command service."

Highest-priority subscribers (P0):
- `payment-lifecycle.ts` — auto-confirms orders on `paid`, auto-cancels on `refunded`
- `cart-intelligence.ts: order.placed` — creates Payment row + 6 other mutations in one handler
- `cart-intelligence.ts: order.status_changed` — reconciles OrderProjection
- `cart-intelligence.ts: notification.send` — universal WhatsApp egress with no taint check

Highest-priority jobs (P0):
- `stale-order-checker.ts` — cancels orders by wall clock
- `pix-expiry-checker.ts` — expires PIX payments by clock

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/subscribers/payment-lifecycle.ts`
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/subscribers/cart-intelligence.ts` (large file — 1000+ lines; handles 22 subjects)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/subscribers/handoff-subscriber.ts`
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/subscribers/conversation-archiver.ts`
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/jobs/stale-order-checker.ts`
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/jobs/pix-expiry-checker.ts`
- All other jobs in `apps/api/src/jobs/*`

**Modify (per phase):**
- Each subscriber file
- Each job file

**Create:**
- `apps/api/src/subscribers/__shared__/system-actor-envelope.ts` (helper)
- `apps/api/src/__tests__/subscriber-governance.test.ts` (one per subscriber)
- `apps/api/src/__tests__/job-governance.test.ts` (one per job)

## Constraints

- Subscribers preserve NATS idempotency via `dedup.ts:isNewEvent` — adjudicate is layered ON TOP.
- Jobs preserve `withLock` patterns (CLAUDE.md rule #10).
- `actor.principal = "system"`, `actor.sessionId = subject + ":" + eventKey` for subscribers; job name + cron-tick for jobs.
- `taint = "SYSTEM"`.
- `nonce` derived from the upstream event id (so replay safe).
- DLQ on REFUSE — push the original NATS payload to `dlq:{eventName}` Redis list.
- Notification.send body sanitization: use the WhatsApp pack's `sanitizeCustomerString` (Task 10) for any customer-derived strings.
- pt-BR for any user-facing fallback messages.

## Implementation requirements

### Phase A: Helper + payment-lifecycle (highest priority)

1. **`system-actor-envelope.ts`** helper:
   ```ts
   export function buildSystemEnvelope<K, P>(args: {
     kind: K; payload: P; sourceSubject: string; eventId: string;
   }): IntentEnvelope<K, P>
   ```

2. **`payment-lifecycle.ts`** — wrap auto-confirm + auto-cancel:
   - On `payment.status_changed { newStatus: "paid" }`:
     - Build `IntentEnvelope<"order.auto_confirm_on_paid", ...>`.
     - Adjudicate → on EXECUTE call `orderCmdSvc.transitionStatus(envelope)` (already envelope-shaped per Task 15).
     - On REFUSE: log + DLQ.
   - On `payment.status_changed { newStatus: "refunded" }`:
     - `IntentEnvelope<"order.auto_cancel_on_refund", ...>`.

### Phase B: cart-intelligence (largest, most subjects)

3. **`cart-intelligence.ts:244` (order.placed)** — wrap each of the 11 mutations in its handler. Some examples:
   - `customerSvc.recordOrderItems(...)` → `IntentEnvelope<"customer.order_items.record", ...>`.
   - `paymentCmdSvc.create(...)` → `IntentEnvelope<"payment.create_from_order_placed", ...>`.
   - `loyaltySvc.addStamp(...)` → `IntentEnvelope<"loyalty.stamp.add", ...>`.

4. **`cart-intelligence.ts:665` (notification.send)** — wrap WhatsApp egress:
   - `IntentEnvelope<"whatsapp.message.send", {to, body, senderRole, templateName?}>`.
   - Use `whatsappPack` policy (Task 10) — applies 24h window + sanitization.
   - On REFUSE (e.g. window expired): log + DLQ + alert.

5. **Other cart-intelligence subjects** — wrap each mutation. Lower-priority subjects (review-prompt, recently-viewed updates, profile counters) can be wrapped in batch.

### Phase C: Other subscribers

6. `handoff-subscriber.ts` → wrap via `whatsappPack` for staff WhatsApp.
7. `conversation-archiver.ts` → wrap via `whatsappPack` (or `messages` pack) for ConversationMessage append.
8. `defer-resolver.ts` (Task 03) — already envelope-aware; verify alignment.

### Phase D: BullMQ jobs

9. `stale-order-checker.ts` — wrap cancel logic:
   - For each candidate order, build `IntentEnvelope<"order.cancel_stale", {orderId, ageMinutes, threshold}>`.
   - Adjudicate → EXECUTE calls `orderCmdSvc.transitionStatus`.

10. `pix-expiry-checker.ts` — same pattern:
    - `IntentEnvelope<"payment.expire_pix", {paymentId, expiredAt}>`.

11. `no-show-checker.ts` — `IntentEnvelope<"reservation.no_show", ...>` (uses `pack-reservations` policy).

12. `pix-expiry-monitor.ts`, `abandoned-cart-checker.ts`, `proactive-engagement.ts`, `reservation-reminder.ts`, etc. — wrap their NATS publishes or direct WhatsApp calls. Lower priority.

### Phase E: Tests

13. Per subscriber/job, test:
    - EXECUTE path runs the mutation.
    - REFUSE path: no mutation; DLQ writes.
    - Audit emitted.
    - Idempotency (replay) honoured (envelope's nonce keyed to event id).

## Acceptance criteria

- [ ] All P0 subscribers (`payment-lifecycle`, `cart-intelligence:order.placed`, `cart-intelligence:notification.send`) wrapped.
- [ ] All P0 jobs (`stale-order-checker`, `pix-expiry-checker`) wrapped.
- [ ] P1/P2 subscribers and jobs wrapped (or scoped to follow-up with clear documentation).
- [ ] DLQ writes on REFUSE.
- [ ] Replay safe (deterministic intentHash via event-id nonce).
- [ ] All governance tests pass.

## Testing requirements

- **Unit:** per-subscriber and per-job test files.
- **Integration:** end-to-end NATS message → adjudicate → mutation, asserted via the existing dedup + DLQ paths.
- **Bypass-detection:** grep-test asserting NO direct `orderCmdSvc.transitionStatus(...)` calls outside an `adjudicate() === EXECUTE` branch in `apps/api/src/subscribers/*` and `apps/api/src/jobs/*`.

## Rollout notes

Per-subscriber shadow first. Recommended order:
1. payment-lifecycle (shadow 7 days)
2. cart-intelligence:order.placed (shadow 14 days — high fan-out)
3. notification.send (shadow 7 days — user-visible)
4. stale-order-checker (shadow 7 days)
5. pix-expiry-checker (shadow 7 days)
6. Remainder per intent kind

## Rollback notes

Per-phase revert possible. Pending in-flight subscriber executions complete on legacy path post-revert. ETA per phase: 30–60 min. No data loss.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 16: NATS subscriber + BullMQ job governance.

CONTEXT
This is an XL task — break into 5 phases (A-E). You may need multiple agent runs; complete one or two phases per run.

Per investigation 04 (P0 #1-#5) in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/04-background-jobs-nats.md:
- 25 NATS subscriber handlers + 11 BullMQ jobs make mutations with ZERO kernel review
- Highest-priority: payment-lifecycle (auto-confirms orders), cart-intelligence:order.placed (11 mutations in one handler), notification.send (universal WhatsApp egress with no taint check)
- A forged NATS event today can confirm/cancel any order — no per-message auth

REPO LAYOUT
- apps/api/src/subscribers/payment-lifecycle.ts
- apps/api/src/subscribers/cart-intelligence.ts (large, 1000+ lines, 22 subjects)
- apps/api/src/subscribers/handoff-subscriber.ts
- apps/api/src/subscribers/conversation-archiver.ts
- apps/api/src/subscribers/defer-resolver.ts (Task 03 — verify alignment)
- apps/api/src/jobs/stale-order-checker.ts
- apps/api/src/jobs/pix-expiry-checker.ts
- apps/api/src/jobs/no-show-checker.ts
- apps/api/src/jobs/*.ts (8 more)
- apps/api/src/subscribers/dedup.ts (isNewEvent)
- apps/api/src/subscribers/dlq.ts (pushToDlq)
- packages/domain/src/services/* (Task 15 — services accept envelopes)
- packages/pack-orders, pack-reservations, pack-whatsapp (Tasks 08, 09, 10)

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- apps/api/src/subscribers/__shared__/system-actor-envelope.ts (CREATE)
- apps/api/src/subscribers/*.ts (MODIFY per phase)
- apps/api/src/jobs/*.ts (MODIFY per phase)
- apps/api/src/__tests__/subscriber-governance.test.ts (CREATE — one file per subscriber under tests)
- apps/api/src/__tests__/job-governance.test.ts (CREATE)

PHASES

Phase A — Helper + payment-lifecycle (1-2 days):
1. system-actor-envelope.ts:
   ```ts
   export function buildSystemEnvelope<K extends string, P>(args: {
     kind: K;
     payload: P;
     sourceSubject: string;
     eventId: string;
     correlationKey?: string;
   }): IntentEnvelope<K, P>
   ```
   - Calls buildEnvelope with actor.principal="system", actor.sessionId=`${args.sourceSubject}:${args.eventId}`, taint="SYSTEM", nonce=args.eventId (deterministic for replay).
2. payment-lifecycle.ts: wrap auto-confirm (paid → transitionStatus to CONFIRMED) and auto-cancel (refunded → transitionStatus to CANCELED):
   - Build IntentEnvelope<"order.auto_confirm_on_paid"|"order.auto_cancel_on_refund", payload>
   - adjudicate(envelope, currentState, ordersPack.policy)
   - audit-emit
   - on EXECUTE: call orderCmdSvc.transitionStatus(envelope) (already envelope-shaped per Task 15)
   - on REFUSE: log + pushToDlq("payment.status_changed", payload) + alert
   - on DEFER: park; resume via defer-resolver later
3. Tests in __tests__/payment-lifecycle-governance.test.ts: 4 outcomes × 2 transitions

Phase B — cart-intelligence (3-4 days, biggest file):
4. order.placed handler (line 244): wrap each of the 11 mutations. Each gets its own intent kind (customer.order_items.record, payment.create_from_order_placed, loyalty.stamp.add, profile.counter.increment, etc.). One audit record per mutation.
5. notification.send handler (line 665): wrap each WhatsApp egress in IntentEnvelope<"whatsapp.message.send", {to, body, senderRole, templateName?}>. Use whatsappPack.policy. On REFUSE (e.g. 24h window expired), do NOT send + DLQ.
6. order.status_changed handler (line 573): wrap projection reconcile in IntentEnvelope<"order.status.reconcile", ...>. Use ordersPack.policy.
7. follow-up.due handler (line 1137): wrap the notification publish in whatsapp.message.send envelope.
8. Lower-priority cart-intelligence subjects (review-prompt, recently-viewed, profile counters): wrap in batch with a shared helper. Some may not need adjudicate (pure analytics counters) — document the choice.

Phase C — Other subscribers (1-2 days):
9. handoff-subscriber.ts: wrap staff WhatsApp message in whatsapp.message.send envelope (whatsappPack handles rate-limit via Task 10's handoff threshold guard).
10. conversation-archiver.ts: wrap ConversationMessage append in IntentEnvelope<"conversation.message.append", ...>. Use whatsappPack or a new messages pack.

Phase D — BullMQ jobs (2-3 days):
11. stale-order-checker.ts: per candidate, build IntentEnvelope<"order.cancel_stale", {orderId, ageMinutes, threshold}>. adjudicate → EXECUTE calls orderCmdSvc.transitionStatus + paymentCmdSvc.transitionStatus.
12. pix-expiry-checker.ts: IntentEnvelope<"payment.expire_pix", {paymentId, expiredAt}>. Same pattern. Preserve existing withLock.
13. no-show-checker.ts: IntentEnvelope<"reservation.no_show", {reservationId}>. Uses reservationsPack.
14. Lower-priority jobs (abandoned-cart-checker, proactive-engagement, etc.): wrap publishes/sends in appropriate envelopes. Some are analytics-only — document choices.

Phase E — Tests (2 days):
15. Per subscriber/job, test:
    - EXECUTE path: mutation runs (or NATS publish fires, or WhatsApp send fires)
    - REFUSE path: no mutation; DLQ writes; audit record emitted
    - DEFER path: envelope parked
    - Idempotency: replay event → no double execution (envelope nonce = event.id makes intentHash deterministic; ledger or dedup catches replay)
    - Audit record emitted per decision
16. Bypass-detection test in __tests__/no-direct-service-calls.test.ts: grep apps/api/src/subscribers and apps/api/src/jobs for direct orderCmdSvc.transitionStatus/paymentCmdSvc.transitionStatus calls; assert all such calls are inside an adjudicate() === EXECUTE branch.

CONSTRAINTS
- Read CLAUDE.md rules 2, 4, 7, 9, 10 first
- Preserve dedup (isNewEvent), DLQ (pushToDlq), withLock patterns
- Use rk() for any new Redis keys
- pt-BR for any user-facing strings
- Deterministic intentHash via nonce = eventId (replay safe)
- TypeScript strict, ESM, .js extensions on local imports
- COORDINATE with Tasks 15 (services accept envelopes) and 18 (audit redactor) — if 18 is not yet merged, document in PR that PII redaction is pending

ACCEPTANCE CHECKLIST (verify per phase before returning)
- [ ] system-actor-envelope.ts helper exists
- [ ] P0 subscribers wrapped: payment-lifecycle, cart-intelligence:order.placed, cart-intelligence:notification.send
- [ ] P0 jobs wrapped: stale-order-checker, pix-expiry-checker
- [ ] DLQ writes on REFUSE
- [ ] All governance tests pass per phase
- [ ] Bypass-detection test passes
- [ ] `pnpm --filter @ibatexas/api typecheck` passes
- [ ] PR description states which phases completed + remaining for follow-up

When complete, return: phases completed, files modified per phase, test output, list of low-priority subscribers/jobs intentionally deferred, and notes on any pack policy gaps discovered.
```
