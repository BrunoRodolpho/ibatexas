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

## Task 14 follow-up — remaining customer routes (scope cuts)

Task 14 landed the customer-intent gateway (`apps/api/src/routes/__shared__/customer-intent-gateway.ts`), the LGPD anonymize 3-endpoint flow with 24h grace + resolver subscriber, and wrapped three high-value routes: `POST /api/cart/checkout`, `POST /api/orders/:id/cancel`, `POST /api/orders/:id/amend`. The remaining customer routes from the task spec were deliberately deferred (not blocked — they have working legacy paths and the gateway pattern is now in place):

**Order routes still on the legacy direct-tool path:**

- `POST /api/orders/:id/amend/batch` — batch amend. Same shape as the single-amend wrap; `OrderAmendRequestPayload` already supports multiple changes. ~30min to wrap.
- `POST /api/orders/:id/payment/retry` — payment retry. The pack-orders Pack doesn't declare a dedicated intent kind (`order.payment.retry`) yet; either piggyback on `payment.create` from the projection bundle or add a kind to pack-orders. ~1h.
- `POST /api/orders/:id/payment/regenerate-pix` — PIX regen. Needs `order.pix.regenerate` or `payment.create` reuse. ~1h.
- `PATCH /api/orders/:id/payment/method` — method switch. The `payment.method.switch` intent kind exists in `paymentProjectionPolicyBundle`; route can build the envelope and call a new `*FromEnvelope` on the payment command service. ~1.5h.
- `PATCH /api/orders/:id/address` — address change. `order.address.change` intent kind exists in `orderProjectionPolicyBundle`; `changeAddressFromEnvelope` exists on `OrderCommandService`. Route currently calls the `changeDeliveryAddress` tool function directly. ~45min.
- `PATCH /api/orders/:id/type` — type switch. `order.type.switch` intent kind exists; `switchTypeFromEnvelope` exists. Same shape as address. ~45min.

**Cart line-item routes still on the legacy Medusa-passthrough path:**

- `POST /api/cart/:id/line-items` (kind `order.item.add`)
- `PATCH /api/cart/:id/line-items/:itemId` (kind `order.item.update`)
- `DELETE /api/cart/:id/line-items/:itemId` (kind `order.item.remove`)
- `POST /api/cart/:id/sync` (kind `order.item.add` × N)

These would each be ~30-45min following the checkout pattern. The blocker for them is that the pack's `OrderItemAddPayload` requires an `allergens: string[]` field that the current HTTP API doesn't surface — adding it without breaking the web/mobile client is a separate UX decision.

**Pure-legacy posture (deliberate):**

The customer-intent gateway already supports `IBX_KERNEL_ENFORCE` / `IBX_KERNEL_SHADOW` per the M3 rollout playbook. Routes that ARE wrapped (checkout, cancel, amend) run in pure-legacy mode by default — they only adjudicate when their intent kind appears in the enforce/shadow env list. This is intentional: the M3 enforce flip happens incrementally per intent class with 7-14 days of clean shadow each.

The anonymize flow is the exception — `customer.anonymize` and `customer.anonymize.cancel` are in the gateway's `ALWAYS_ENFORCE` set because the kernel DEFER + 24h grace IS the safety model (no fallback path).

**Reservation routes (out of task 14 scope):**

The task spec also names `reservations.ts` (create, modify, cancel, waitlist). Task 14 deliberately left those untouched — pack-reservations exists and the patterns are well-understood, but a separate follow-up should wrap them so the M3 milestone tracking stays coherent.

## Task 13 follow-up — admin-force REQUEST_CONFIRMATION at the pack layer

Task 13 wired the four admin force-* routes (`force-cancel`, `payment/refund`, `waive`, `payment/status`) through `*FromEnvelope` per task 15 and added a **route-level** two-person confirmation flow (`apps/api/src/routes/admin/admin-confirmation-store.ts`) — a Redis-backed pending-intent store with Lua atomic consume and 600s TTL.

The deeper pack-level integration (a `confirmationToken` payload field + `createConfirmGuard` for admin intents that emits `REQUEST_CONFIRMATION` decisions from the kernel itself, like `pack-deployments-approval.confirmDestructiveRollback`) was **deliberately deferred**:

- `@ibatexas/pack-orders` does not declare `order.admin.force_cancel` / `order.admin.refund` / `order.admin.waive_payment` / `order.admin.force_payment_status` intent kinds. It governs the LLM-proposable surface only (cart, item, checkout, cancel, note, amend). The LLM has no business proposing admin force-* actions.
- `orderProjectionPolicyBundle` / `paymentProjectionPolicyBundle` carry the canonical projection-lifecycle intents (`order.status.transition`, `payment.status.transition`, etc.) that task 13's admin routes now dispatch. These are domain-internal policies and do not (yet) carry the admin-force confirmation guards.

The route-level confirmation flow shipped here is functionally equivalent (atomic single-use receipt + audit trail), but the receipt token is NOT bound to the envelope's `intentHash` and the kernel does NOT substitute EXECUTE on second-pass dispatch (it adjudicates each step independently). Equivalence is achieved by the route handler refusing to mutate without a consumed receipt.

**Follow-up task (M4 candidate):** add `confirmationToken?: string` to `OrderStatusTransitionPayload` / `PaymentStatusTransitionPayload` (or introduce dedicated `order.admin.*` / `payment.admin.*` intent kinds in a new `@ibatexas/pack-admin-actions` Pack) and wire `createConfirmGuard` so the kernel emits REQUEST_CONFIRMATION natively. At that point the route's `confirmationStore.consume()` becomes the receipt-substitution path proper, and the audit trail carries `predecessorAt` linking the two adjudications.
