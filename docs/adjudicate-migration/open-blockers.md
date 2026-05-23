# Open Blockers

Anything marked `BLOCKED` here halts a specific task. Dependents are marked `DEFERRED` in `current-state.md`.

## Post-task-15 follow-ups (informational — none are BLOCKED)

Task 15 landed the chokepoint helper (`withAdjudicate`) plus envelope-typed entry points (`*FromEnvelope`) on all 5 command services, and consolidated the 3 rogue cart writers (`add-order-note`, `switch-order-type`, `change-delivery-address`) under `OrderCommandService`. Per decision D8, the legacy bare-arg methods are retained as `@deprecated` so dependent tasks can migrate callers incrementally.

**What dependent M3 tasks need to do after task 15 lands:**

- **Task 12 (Stripe webhook adopter):** the Stripe webhook handler at `apps/api/src/routes/stripe-webhook.ts` should build a `payment.status.reconcile` envelope (SYSTEM taint, system actor, nonce = stripeEventId for idempotency) and call `paymentCmdSvc.reconcileFromWebhookFromEnvelope(envelope)` instead of `paymentCmdSvc.reconcileFromWebhook(id, input)`. The kernel adds the uniform audit gate; the executor preserves the existing idempotency / ownership / out-of-order guards.

- **Task 13 (Admin routes):** the admin endpoints at `apps/api/src/routes/admin/{orders,order-actions,payments,reservations}.ts` should build `order.status.transition` / `payment.status.transition` / `reservation.{checkin,complete,no_show.mark}` envelopes (TRUSTED taint, principal=admin) and call the `*FromEnvelope` entry points. The legacy methods continue to work in the interim.

- **Task 14 (Customer routes):** the customer-facing endpoints at `apps/api/src/routes/{auth,me,order-actions,cart}.ts` should build envelopes for the customer-driven intents (`customer.profile.update`, `customer.preferences.update`, `customer.pix.details.save`, `customer.anonymize`, `order.cancel`, `order.type.switch`, `order.address.change`, etc.) and call the `*FromEnvelope` entry points. The `customer.anonymize` DEFER (24h grace) per `@ibatexas/pack-customer-onboarding` is the most novel — task 14 owns the Redis parking + resume orchestration.

- **Task 16 (NATS subscribers):** the subscribers at `apps/api/src/subscribers/{cart-intelligence,payment-lifecycle,conversation-archiver}.ts` should build envelopes for the system-actor intents they consume (`order.status.reconcile`, `order.projection.create`, `conversation.message.append`, etc.) and call the `*FromEnvelope` entry points. SYSTEM taint via `actor.principal="system"`.

- **Task 17 (Medusa wrapper):** the Medusa order-projection subscriber wrapper consumes `order.placed` and emits `order.projection.create` envelopes (SYSTEM-only). Wire to `orderCmdSvc.createFromEnvelope(envelope, fullInput)` — the full `CreateOrderProjectionInput` is passed as a second argument (the mapper output carries Prisma-typed JSON fields that don't round-trip cleanly through the envelope wire).

**Out-of-scope from task 15 (deliberately deferred — none are BLOCKED):**

- Reservations: only the most-used methods (`create`, `modify`, `cancel`, `transition`) got envelope-typed entry points. `joinWaitlist` / `promoteWaitlist` use the same pattern and can be added in a follow-up if a caller actually needs envelope dispatch for them.
- Customer: `customer.address.add` and `customer.address.remove` from `pack-customer-onboarding` were not wired up — the existing `customer.service.ts` has no corresponding methods (addresses live in `apps/api/src/routes/me.ts` direct Prisma writes). Future task: add `addAddressFromEnvelope` / `removeAddressFromEnvelope` once a service-level abstraction exists.
- Payments: `payment.method.switch` intent kind is declared in `paymentProjectionPolicyBundle` but the executor side is out of scope (the method-switch lives in `packages/tools/src/cart/amend-order.ts` today). Wiring it in is a follow-up — add to task 14's customer-route migration if it becomes a dependency.
