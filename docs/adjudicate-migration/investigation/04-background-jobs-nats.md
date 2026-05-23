# 04 — Background Jobs, NATS, Deferred Workflows

> Scope: NATS subscribers, publishers, BullMQ workers/jobs, the Redis outbox, the DLQ,
> and the half-wired deferred-intent system. Investigator 4 of 8.
>
> All file paths are absolute and rooted at `/Users/thaisrodolpho/projects/ibatexas`.

## Executive summary

IbateXas runs a wide async surface: **5 NATS subscriber modules** (registering **25 distinct subject handlers** in the API process) plus **7 product/lifecycle Medusa subscribers** in the commerce process; **11 BullMQ workers/queues** (8 repeatable cron-style + 3 delayed-job dispatchers); a Redis **outbox** for 8 critical event types; and a Redis **DLQ** with a CLI replay tool.

The kernel (`@adjudicate/core`) governs only the **LLM-proposed mutating-tool path** (`tool-registry.ts` → intent envelope → `adjudicate()`). **Zero subscribers or background jobs go through `adjudicate()`**. They invoke domain command services (`createOrderCommandService`, `createPaymentCommandService`), Medusa admin APIs, Stripe APIs, and the WhatsApp sender directly. This is a massive un-adjudicated mutation surface — roughly equal in blast radius to the entire LLM tool layer the kernel already protects.

Most alarming finding: **the deferred-intent resolver (`defer-resolver.ts`) is never wired up** (no call to `startDeferResolverSubscriber` in `apps/api/src/index.ts`). PIX-pending intents *are* parked at `defer:pending:${sessionId}` by `llm-responder.ts`, but nothing on the receiving side actually resumes them — and even the implemented resume only flips a dedup ledger key without re-executing the parked envelope.

## NATS subscribers inventory

> Subjects are short-form (NATS client prepends `ibatexas.`).
> "Adjudicated?" means whether the handler runs side effects through `adjudicate()` from `@adjudicate/core/kernel`. **All entries below are No** unless flagged.

### API process (`apps/api/src/subscribers/`)

| Subject | File:line | Action | Adjudicated? | Severity |
|---|---|---|---|---|
| `payment.status_changed` | `payment-lifecycle.ts:34` | Auto-confirm order on `paid`, auto-cancel on `refunded`, notify customer on expire/fail, escalate on dispute. Calls `orderCmdSvc.transitionStatus()` (DB write). Re-publishes `order.status_changed` / `order.canceled` / `order.escalation_needed` / `notification.send`. | No | **P0** |
| `payment.status_changed` | `defer-resolver.ts:50` | Scans `defer:pending:*`, calls `resumeDeferredIntent` which writes `defer:resumed:*` dedup key and deletes the parked envelope. Does **NOT** actually execute the parked intent. **NEVER REGISTERED** at server startup. | No | **P0** |
| `cart.abandoned` | `cart-intelligence.ts:112` | Computes tier 1/2/3 nudge state, persists `cart:nudge:*` to Redis, publishes `notification.send`, sends staff alert (calls WhatsApp directly via `sendText`). | No | P1 |
| `order.placed` | `cart-intelligence.ts:244` | `recordOrderItems` to Postgres (`CustomerOrderItem` bulk insert), copurchase scoring, loyalty stamp award, customer notification, payment row creation (`createPaymentCommandService.create`), order projection creation. Mutates 7 domains in one handler. | No | **P0** |
| `order.payment_failed` | `cart-intelligence.ts:472` | Logs to `OrderEventLog`. | No | P2 |
| `product.viewed` | `cart-intelligence.ts:494` | Updates `customer:recentlyViewed:*` Redis list + profile hash. | No | P2 |
| `search.results_viewed` | `cart-intelligence.ts:526` | Batch update of recently-viewed Redis list. | No | P2 |
| `review.prompt.schedule` | `cart-intelligence.ts:553` | Calls `scheduleReviewPrompt` — writes Redis sorted set entry. | No | P2 |
| `order.status_changed` | `cart-intelligence.ts:573` | Reconciles `OrderProjection` (`orderCmdSvc.reconcileStatus`), sends WhatsApp customer notification, staff alert. | No | **P0** |
| `notification.send` | `cart-intelligence.ts:665` | Looks up customer, calls `sender.sendText(...)` directly to WhatsApp. **Bypasses LLM, kernel, and any taint check on `body`.** Recipient comes from DB but `body` is whatever the publisher passed (LLM-generated text in some paths flows through here). | No | **P0** |
| `reservation.created` | `cart-intelligence.ts:719` | Updates profile hash. | No | P2 |
| `reservation.modified` | `cart-intelligence.ts:736` | Updates profile hash. | No | P2 |
| `reservation.cancelled` | `cart-intelligence.ts:751` | Increments `cancellationCount`. | No | P2 |
| `reservation.no_show` | `cart-intelligence.ts:766` | Increments `noShowCount`. | No | P2 |
| `review.prompt` | `cart-intelligence.ts:781` | Sends a WhatsApp review request (direct `sender.sendText`). | No | P1 |
| `order.refunded` | `cart-intelligence.ts:824` | Increments refund counters; fetches customer via Medusa admin API. | No | P1 |
| `order.disputed` | `cart-intelligence.ts:874` | Sends staff WhatsApp alert (rate-limited via Redis counter); increments `disputeCount`. | No | P1 |
| `order.canceled` | `cart-intelligence.ts:936` | Profile counter. | No | P2 |
| `review.submitted` | `cart-intelligence.ts:984` | Updates product review aggregates in Redis (`product:reviews:*`). | No | P2 |
| `product.intelligence.purge` | `cart-intelligence.ts:1025` | Cleans up Redis copurchase / global-score sets via SCAN. | No | P2 |
| `outreach.sent` | `cart-intelligence.ts:1067` | Profile counter. | No | P2 |
| `cart.item_added` | `cart-intelligence.ts:1093` | Increments `product:cart:popularity` sorted set + profile counter. | No | P2 |
| `follow-up.due` | `cart-intelligence.ts:1137` | Builds message from `reason` switch, publishes `notification.send` (which then sends WhatsApp). | No | P1 |
| `support.handoff_requested` | `handoff-subscriber.ts:14` | Direct WhatsApp message to `STAFF_NOTIFICATION_PHONE`. | No | P1 |
| `conversation.message.appended` | `conversation-archiver.ts:17` | Persists conversation history to Postgres (`conversationSvc.appendMessage`). CDC sink. | No | P2 |

### Commerce process (`apps/commerce/src/subscribers/` — Medusa-native events)

These do **not** subscribe to NATS — they subscribe to Medusa's internal event bus.
But several **publish to NATS** as a side effect (counted here for completeness):

| Medusa event | File | Action | Adjudicated? |
|---|---|---|---|
| `order.delivered` | `order-delivered.ts` | Publishes NATS `review.prompt.schedule`. | No |
| `product.deleted` | `product-deleted.ts` | Deletes from Typesense, invalidates cache, publishes NATS `product.intelligence.purge`. | No |
| `product.created` | `product-created.ts` | Indexes to Typesense (no NATS emit). | n/a |
| `product.updated` | `product-updated.ts` | Re-indexes + cache invalidation. | n/a |
| `product-variant.updated` | `variant-updated.ts` | Re-indexes parent product. | n/a |
| `pricing.price.{created,updated,deleted}` | `price-updated.ts` | Re-indexes parent product. | n/a |

**Subscriber count summary:** 25 NATS subject handlers + 7 Medusa-native handlers = **32 reactive entry points**. **0 are adjudicated.** Adjudication coverage on the async surface: **0%**.

## NATS publishers inventory

Grouped by domain. Every entry includes the file & line plus whether it publishes pre- or post-adjudication.

### Payment domain

| Event | Publisher | Adjudication status |
|---|---|---|
| `payment.status_changed` | `routes/stripe-webhook.ts:79` (Stripe webhook → `reconcilePaymentFromStripe`) | Pre-adjudication. Wire-truth from Stripe. |
| `payment.status_changed` | `routes/admin/payments.ts:78,162,238` (admin "mark paid", refund, waive) | No — admin action skips kernel. |
| `payment.status_changed` | `routes/admin/order-actions.ts:224` (admin waive payment) | No. |
| `payment.status_changed` | `subscribers/payment-lifecycle.ts` (auto-confirm cascade, refund cascade, cancel cascade) | No — subscriber-on-subscriber. |
| `payment.status_changed` | `jobs/pix-expiry-checker.ts:76` (cron, PIX expired) | No. |
| `payment.status_changed` | `jobs/stale-order-checker.ts:130` (cron, stale-order cancel) | No. |
| `payment.status_changed` | `packages/tools/src/cart/cancel-order.ts:49` (kernel-adjudicated path) | Post-adjudication (LLM tool). |
| `payment.status_changed` | `packages/tools/src/cart/regenerate-pix.ts:128` | Post-adjudication (LLM tool). |
| `payment.status_changed` | `packages/tools/src/cart/amend-order.ts:391` | Post-adjudication (LLM tool). |
| `payment.method_changed` | `routes/order-actions.ts:821` (customer switch method) | No. |
| `payment.method_changed` | `packages/tools/src/cart/amend-order.ts:383` | Post-adjudication. |

### Order domain

| Event | Publisher |
|---|---|
| `order.placed` | `routes/stripe-webhook.ts:168` (PIX cart completion), `packages/tools/src/cart/create-checkout.ts:334` (LLM tool) |
| `order.status_changed` | `routes/admin/order-actions.ts:153`, `routes/admin/orders.ts:371`, `subscribers/payment-lifecycle.ts:87` |
| `order.canceled` | `routes/stripe-webhook.ts:341`, `routes/admin/order-actions.ts:94`, `routes/order-actions.ts:228`, `jobs/stale-order-checker.ts:146`, `subscribers/payment-lifecycle.ts:135` |
| `order.refunded` | `routes/stripe-webhook.ts:270` |
| `order.disputed` | `routes/stripe-webhook.ts:305` |
| `order.payment_failed` | `routes/stripe-webhook.ts:230` |
| `order.escalation_needed` | `subscribers/payment-lifecycle.ts:181`, `packages/tools/src/cart/amend-order.ts:196,246`, `packages/tools/src/cart/cancel-order.ts:79` — **no subscriber consumes this event.** |
| `order.note_added` | `routes/admin/payments.ts:282`, `routes/admin/order-actions.ts` indirectly, `routes/order-actions.ts:487`, `packages/tools/src/cart/add-order-note.ts:58` — **no subscriber consumes this event.** |
| `order.type_changed` | `packages/tools/src/cart/switch-order-type.ts:81` — **no subscriber consumes this event.** |
| `order.address_changed` | `packages/tools/src/cart/change-delivery-address.ts:68` — **no subscriber consumes this event.** |

### Cart / commerce intelligence

| Event | Publisher |
|---|---|
| `cart.abandoned` | `jobs/abandoned-cart-checker.ts:96` (BullMQ cron) |
| `cart.item_added` | `packages/tools/src/cart/add-to-cart.ts:79`, `packages/tools/src/cart/reorder.ts:56` |
| `product.viewed` | `packages/tools/src/catalog/get-product-details.ts:20` |
| `product.intelligence.purge` | `apps/commerce/src/subscribers/product-deleted.ts:32` |
| `search.results_viewed` | `packages/tools/src/search/search-products.ts:521` |
| `outreach.sent` | `jobs/proactive-engagement.ts:151` |

### Reservation

| Event | Publisher |
|---|---|
| `reservation.created` | `packages/tools/src/reservation/create-reservation.ts:35` |
| `reservation.modified` | `packages/tools/src/reservation/modify-reservation.ts:33` |
| `reservation.cancelled` | `packages/tools/src/reservation/cancel-reservation.ts:53` |
| `reservation.no_show` | `jobs/no-show-checker.ts:66` (BullMQ cron) |

### Review / notification / support

| Event | Publisher |
|---|---|
| `review.submitted` | `packages/tools/src/intelligence/submit-review.ts:44` |
| `review.prompt` | `jobs/review-prompt-poller.ts:49` |
| `review.prompt.schedule` | `apps/commerce/src/subscribers/order-delivered.ts:35` |
| `notification.send` | `subscribers/cart-intelligence.ts:198,348,384,628,1162`, `subscribers/payment-lifecycle.ts:157,169` — **subscriber-to-subscriber fan-out is heavy here.** |
| `follow-up.due` | `jobs/follow-up-poller.ts:44` |
| `support.handoff_requested` | `packages/tools/src/support/handoff-to-human.ts:10` |

### Conversation / analytics / audit (CDC-style)

| Event | Publisher |
|---|---|
| `conversation.message.appended` | `session/store.ts:62` (every appendMessages call) |
| `analytics.event` | `routes/analytics.ts:82` — **no subscriber consumes this event.** |
| `audit.intent.decision.v1` | `packages/llm-provider/src/intent-audit-wiring.ts:35` (kernel audit sink) — **no subscriber consumes this event.** |

## Pub/sub flow map

```
Stripe webhook (external trust boundary)
   │
   ├── payment.status_changed ─┬──► payment-lifecycle ──► order.status_changed ──► cart-intelligence (projection reconcile + WhatsApp)
   │                            │                          order.canceled         ╲
   │                            │                          order.escalation_needed (NO SUBSCRIBER)
   │                            │                          notification.send ─────► cart-intelligence (WhatsApp send)
   │                            │
   │                            └──► defer-resolver (NEVER WIRED) ──► would resume PIX-deferred intent (but stub only clears dedup key)
   │
   ├── order.placed ──► cart-intelligence (7-step fan-out: CustomerOrderItem insert,
   │                                       copurchase scoring, profile counters, daily metrics,
   │                                       loyalty stamp, staff alert, customer notify,
   │                                       order projection, payment row)
   │                                       │
   │                                       └─ loyalty award → notification.send ─► cart-intelligence ─► WhatsApp
   │
   ├── order.payment_failed ──► cart-intelligence (event log only)
   ├── order.refunded ──► cart-intelligence (profile + medusaAdmin call)
   ├── order.disputed ──► cart-intelligence (staff alert + profile)
   └── order.canceled ──► cart-intelligence (profile counter)

BullMQ cron jobs ────► NATS events ────► subscribers above
   abandoned-cart-checker  (15m)  → cart.abandoned → cart-intelligence → notification.send → WhatsApp
   no-show-checker         (5m)   → reservation.no_show → cart-intelligence
   pix-expiry-checker      (5m)   → payment.status_changed (PAYMENT_EXPIRED) → payment-lifecycle → notification.send
   stale-order-checker     (30m)  → payment.status_changed (CANCELED) + order.canceled → multiple subscribers
   review-prompt-poller    (5m)   → review.prompt → cart-intelligence → WhatsApp
   follow-up-poller        (15m)  → follow-up.due → cart-intelligence → notification.send → WhatsApp
   proactive-engagement    (4h)   → directly sendText to WhatsApp + outreach.sent (analytics-only)
   reservation-reminder    (24h)  → directly sendReservationReminder to WhatsApp (no NATS emit)
   outbox-retry            (60s)  → re-publishes CRITICAL_EVENTS from Redis outbox
   pix-expiry-monitor (delayed)   → directly sendText to WhatsApp
   hesitation-nudge   (delayed 45s) → directly sendText to WhatsApp

Medusa commerce events ────► NATS publishes ──► API subscribers
   order.delivered     ──► review.prompt.schedule → cart-intelligence → review-prompt-poller (sorted set add)
   product.deleted     ──► product.intelligence.purge → cart-intelligence (Redis cleanup)
```

**Fan-out hotspots:**

1. **`order.placed`** triggers an 11-step pipeline inside `cart-intelligence`'s single handler — Postgres bulk inserts, Medusa lookups, Redis profile updates, BullMQ schedule, 2 separate NATS publishes (`notification.send` × 2 for staff + customer), Prisma `OrderProjection.create`, Prisma `Payment.create`. If any single step throws inside `try`, the rest can still run (try-blocks isolate each), but the audit trail is split across loggers and not durable.

2. **`payment.status_changed`** is consumed by **two** subscribers in production code (payment-lifecycle for cascading status changes; defer-resolver for resume — but the latter is dead code). It is published by **9 different sources**. The cascade can recurse: payment-lifecycle on `paid` publishes `order.status_changed`, which is consumed by cart-intelligence which publishes `notification.send`, which is consumed by cart-intelligence which sends WhatsApp.

3. **`notification.send`** is the universal WhatsApp egress — published from at least 8 locations across subscribers, jobs, and the LLM tool path. **The `body` field accepts arbitrary text** with no taint check before the message is sent to the customer.

## Cron / scheduled work

There are **no OS-level crons, no AWS EventBridge schedules, no node-cron**. All recurring work runs in-process via **BullMQ repeatable jobs** registered in `apps/api/src/jobs/register-workers.ts` and managed by `apps/api/src/jobs/queue.ts` (Redis-backed, prefix `ibx`).

| Worker | File | Cadence | Side effect |
|---|---|---|---|
| `abandoned-cart-checker` | `abandoned-cart-checker.ts` | every 15m | Publishes `cart.abandoned`. Uses `HSCAN` on `active:carts` hash. |
| `no-show-checker` | `no-show-checker.ts` | every 5m | Calls `reservationSvc.transition(..., "no_show")` (DB write), publishes `reservation.no_show`. |
| `pix-expiry-checker` | `pix-expiry-checker.ts` | every 5m | Queries `Payment` table, calls `paymentSvc.transitionStatus` (DB write), cancels Stripe PaymentIntent, publishes `payment.status_changed`. **Uses `withLock`.** |
| `pix-expiry-monitor` | `pix-expiry-monitor.ts` | delayed jobs (25m, 30m) | Sends WhatsApp reminder + expiry-explanation messages. Reads `pix:paid:*` key set by Stripe webhook. |
| `stale-order-checker` | `stale-order-checker.ts` | every 30m | Cancels orders + payments past `STALE_ORDER_THRESHOLD_HOURS` (24h default). **Dry-run flag via `STALE_ORDER_DRY_RUN`.** |
| `review-prompt-poller` | `review-prompt-poller.ts` | every 5m | Reads `review:prompt:scheduled` ZSET, publishes `review.prompt`. |
| `follow-up-poller` | `follow-up-poller.ts` | every 15m | Reads `follow-up:scheduled` ZSET, publishes `follow-up.due`. |
| `reservation-reminder` | `reservation-reminder.ts` | every 24h (immediate on boot) | Directly sends WhatsApp via `sendReservationReminder`. |
| `proactive-engagement` | `proactive-engagement.ts` | every 4h | **Sends WhatsApp directly** to dormant customers (lunch/dinner window). Reads `customer:profile:*`. Decides message via `buildOutreachMessage`. **Most autonomous worker.** |
| `outbox-retry` | `outbox-retry.ts` | every 60s + jitter | Re-publishes the 8 `CRITICAL_EVENTS` from Redis outbox lists. Distributed lock via `lock:outbox-retry`. |
| `hesitation-nudge` | `hesitation-nudge.ts` | delayed 45s | Sends WhatsApp nudge if customer hasn't replied to first contact. |

There is also a non-BullMQ heartbeat in `apps/api/src/whatsapp/session.ts:228` (`setInterval` extending agent lock TTL) and `apps/api/src/streaming/execution-queue.ts:66` (HTTP streaming heartbeat). Neither produces user-facing side effects.

## Deferred intent system

### Park mechanism

Implemented in `packages/llm-provider/src/llm-responder.ts:384-406`. When `adjudicate()` returns `{ kind: "DEFER", signal, timeoutMs }`, the responder:

1. Stores the envelope in Redis at `rk(\`defer:pending:${context.sessionId}\`)`.
2. TTL = `Math.ceil(decision.timeoutMs / 1000) + 60` (i.e. signal timeout + 60s grace).
3. Payload shape: `{ envelope, signal, parkedAt }` (matches `ParkedEnvelope` in `@adjudicate/runtime/src/defer-resume.ts`).
4. Returns `{ status: "deferred", message: "Estou aguardando confirmação. Te aviso assim que tudo estiver certo.", signal }` to the LLM as the tool result.

The only intent class that currently defers is `order.confirm`, gated by the PIX-pending guard `deferOnPendingPix` (`packages/llm-provider/src/order-policy-bundle.ts:183` — factory `createPixPendingDeferGuard` from `@adjudicate/pack-payments-pix`).

### Resume signals (full list)

Currently exactly **one** signal name is used:

| Signal | Const | Source | Wire trigger |
|---|---|---|---|
| `payment.confirmed` | `PIX_CONFIRMATION_SIGNAL` | `@adjudicate/pack-payments-pix/src/types.ts:115` | NATS `payment.status_changed` events with newStatus ∈ {`paid`, `captured`, `confirmed`} per `SETTLED_WIRE_STATUSES` in `apps/api/src/subscribers/defer-resolver.ts:32-36` |

No other signals are produced anywhere in the codebase. The pack ships only this one constant; IbateXas does not extend it.

**`resumeDeferredIntent` call sites** (looking for everything that drains parked envelopes):

| Call site | Status |
|---|---|
| `apps/api/src/subscribers/defer-resolver.ts:66` | **Never reached at runtime** — `startDeferResolverSubscriber` is never invoked in `apps/api/src/index.ts`. The file is dead code. |
| (nowhere else) | — |

Even if it were wired, `resumeDeferredIntent` only:
- Reads the parked envelope.
- Writes `defer:resumed:${sha256(intentHash:signal)}` via SET NX (idempotency ledger).
- Deletes `defer:pending:${sessionId}`.
- Returns `{ resumed: true, intentHash, parked }`.

**It does not actually execute the parked intent.** Nothing in the codebase consumes the `parked.envelope` returned by the function — the caller (`defer-resolver.ts`) only logs success. The resumed envelope is lost.

### Timeout / cleanup behavior

- **TTL expiry:** the Redis key disappears silently. No subscriber, no job, no cleanup callback fires. The user's `"Estou aguardando confirmação..."` promise is never honoured if no `payment.confirmed`-class event arrives within the TTL.
- **No timeout sweeper:** there is no background job scanning for expired `defer:pending:*` keys (would need to use `__keyevent@0__:expired` keyspace notifications or a polling sweeper — neither exists).
- **No user-facing follow-up:** if the timeout fires, the customer is left in conversational limbo. The downstream `pix-expiry-monitor` BullMQ job *does* send a WhatsApp "PIX expired — quer um novo QR?" message at 30 minutes for PIX flows, but that is independent of the deferred-intent system. The two systems do not coordinate.
- **Resume ledger TTL:** `defer:resumed:*` keys live for 14 days (`DEFER_PENDING_TTL_GRACE_SECONDS = 14 * 24 * 60 * 60` in `@adjudicate/runtime`). Adequate.

## Workers / queue consumers

All workers are listed in the cron table above. There are **no external queue consumers** (no SQS, no Kafka, no RabbitMQ). NATS is used in **Core mode (fire-and-forget)** per `packages/nats-client/src/index.ts:3-5` — JetStream is deferred ("TODO: Full JetStream migration needed for production reliability"). This means:

- **No NATS-level durability**: if no subscriber is connected at publish time, the message is gone.
- **The Redis outbox compensates for the 8 `CRITICAL_EVENTS` only.** The other 17 subjects can be silently lost on broker restart or subscriber disconnect.
- **Outbox subjects:** `order.placed`, `reservation.created`, `order.status_changed`, `order.refunded`, `order.disputed`, `order.canceled`, `order.payment_failed`, `payment.status_changed`. (Defined in `packages/nats-client/src/index.ts:77-85` as `OUTBOX_EVENTS`, mirrored in `apps/api/src/jobs/outbox-retry.ts:16-25` as `CRITICAL_EVENTS`.)
- **Non-critical lost-on-restart events include**: `cart.abandoned`, `notification.send`, `follow-up.due`, `support.handoff_requested`, `conversation.message.appended`, `analytics.event`, `audit.intent.decision.v1`, every reservation event, every cart-intelligence event.

## Retry / Dead-letter handling

- **Subscriber-level DLQ:** `apps/api/src/subscribers/dlq.ts` — pushes failed payloads to `rk(\`dlq:${eventName}\`)` Redis lists with 7-day TTL. Sentry warning emitted. Used by `cart-intelligence` (notification.send, order.status_changed reconcile failures), `conversation-archiver`, and `handoff-subscriber`. **Not used by `payment-lifecycle` or `defer-resolver`.**
- **CLI inspection / replay:** `packages/cli/src/commands/dlq.ts` provides `ibx dlq list / peek / replay / purge`. Only 5 events are enumerated in the CLI (`order.status_changed`, `order.placed`, `notification.send`, `support.handoff_requested`, `conversation.message.appended`) — meaning entries for other events could exist on disk but be invisible to the CLI.
- **Outbox retry:** `apps/api/src/jobs/outbox-retry.ts` re-publishes from Redis outbox for the 8 critical events every 60s. Subscriber-side idempotency relies on `apps/api/src/subscribers/dedup.ts` (`isNewEvent`, 7-day TTL on `rk(\`nats:processed:${eventKey}\`)`). **Not every subscriber path uses `isNewEvent`** — handoff-subscriber, defer-resolver, conversation-archiver, the order.placed handler, payment-lifecycle do use it; many reservation/profile handlers in cart-intelligence don't.

## Highest-risk un-adjudicated async paths (P0 / P1 / P2)

### P0 — Production-critical

1. **`payment-lifecycle.ts` auto-confirms orders.** On `payment.status_changed` with `newStatus = paid` and `method ≠ cash`, it calls `orderCmdSvc.transitionStatus(orderId, { newStatus: CONFIRMED, actor: "system" })` **with no kernel involvement, no policy check, no business-rule guard.** If an attacker can publish a forged `payment.status_changed` to NATS (no auth on the NATS broker — see `docker-compose.yml`), they can confirm any pending order.

2. **`payment-lifecycle.ts` auto-cancels orders on refund.** Same vector: forging `newStatus = refunded` flips any pending/confirmed order to `CANCELED`. No kernel guard.

3. **`cart-intelligence.ts` order.placed handler creates Payment rows.** `paymentCmdSvc.create` runs from inside a NATS subscriber, with no kernel adjudication. If `order.placed` is replayed or forged, duplicate payment rows are prevented by `ActivePaymentExistsError` and DB uniqueness — but that's a domain-service invariant, not a policy decision.

4. **`stale-order-checker.ts` cancels orders.** Runs every 30m, queries `OrderProjection` for `pending` orders older than 24h with non-paid payment, and cancels them via `orderCmdSvc.transitionStatus` + `paymentCmdSvc.transitionStatus`. **No kernel check.** A misconfigured threshold (env var) or a stuck payment status would mass-cancel real orders. Has a `STALE_ORDER_DRY_RUN` flag but no audit trail comparison to verify what would be canceled before flipping it off.

5. **`defer-resolver.ts` is never wired and would not execute the resumed intent anyway.** Customers who hit the PIX-pending DEFER path are silently dropped when their PIX confirms — the kernel's "I'll wait for the signal" promise is broken.

6. **`notification.send` subscriber sends arbitrary WhatsApp body text.** The `body` field is whatever the publisher passed. Many publishers compose the body via `buildOutreachMessage`, `buildCartRecoveryMessage`, `buildOrderStatusMessage` — all template-based and safe. But `cart-intelligence.ts:1162` (follow-up.due → notification.send) embeds `customer.name` directly into a switch-case message without escaping; and `payment-lifecycle.ts:160,172` hardcode the body but flow through the same channel. If any publisher path were to include LLM-generated text in `body`, it would reach the customer without any taint check.

### P1 — Important

7. **`abandoned-cart-checker` → `cart.abandoned` → `cart-intelligence` → WhatsApp.** The tier-1/2/3 escalation logic decides on its own to send up to 3 messages per cart over 48h. No customer consent recheck. Staff-alert path also queries Medusa admin (`/admin/orders`) and sends WhatsApp alerts above R$200 — rate-limited but un-adjudicated.

8. **`proactive-engagement` job sends unsolicited WhatsApp** to dormant customers. Calls `sendText` directly, with cooldown via Redis. Builds message using customer profile + weather + day-of-week. **The most autonomous side-effect job in the system** — no kernel oversight, no centralized opt-out, time-of-day guard only.

9. **`payment-lifecycle` cascade can recurse.** `payment.status_changed` → publishes `order.status_changed` → consumed by `cart-intelligence` → publishes `notification.send` → consumes `notification.send` → WhatsApp. No depth limit, no audit chain.

10. **Medusa subscribers re-publish into NATS without policy.** `order.delivered` → `review.prompt.schedule`; `product.deleted` → `product.intelligence.purge`. Medusa is a sibling service (`apps/commerce`) and its events are treated as trusted system signals even though Medusa workflows themselves are not adjudicated by IbateXas's kernel.

### P2 — Hygiene / observability

11. **Orphan events** with no subscriber: `order.escalation_needed`, `order.note_added`, `order.type_changed`, `order.address_changed`, `analytics.event`, `audit.intent.decision.v1`. These are emitted but vanish into the void — no DLQ, no alert.

12. **`isNewEvent` dedup is inconsistent.** Some handlers use it, some don't. Reservation/profile handlers in cart-intelligence rely on `redis.hIncrBy` to be idempotent-ish (incrementing on duplicate delivery would over-count, but not catastrophically).

13. **No NATS broker auth.** `docker-compose.yml` exposes NATS on `127.0.0.1:4222` with no `--auth` or token. Production Terraform sets up `nats.tf` (not inspected here) but a misconfigured production NATS would allow any internal pod to forge any event.

14. **`OrderEventLog` audit is best-effort.** Most append calls use `.catch(() => {})`. There is no centralized "all NATS events received" log; the audit trail is split between Postgres event_log, Sentry, and the DLQ.

## Gaps and recommendations

### Architectural

1. **Wire `startDeferResolverSubscriber` into `apps/api/src/index.ts`.** Highest-priority bug. Then design what "resume" actually means: who re-executes the parked envelope? Likely a new path in `llm-responder` that picks up parked envelopes on the next conversation turn, or a kernel-side resume executor.

2. **Add adjudication to subscribers and jobs.** Every place a subscriber/job invokes a domain command service (`orderCmdSvc.transitionStatus`, `paymentCmdSvc.transitionStatus`, `paymentCmdSvc.create`) should build an `IntentEnvelope` with `actor.principal = "system"` and pass it through `adjudicate()` with a system-actor PolicyBundle. The kernel-EXECUTE path then calls the command service. This is the same pattern as the LLM intent-bridge but with a different `principal`.

3. **Govern `notification.send` body content.** Either (a) require publishers to pass a `templateName + variables` instead of a free-form body, or (b) gate every WhatsApp egress through the kernel with a `NotificationSendIntent` envelope.

4. **Define a deferred-intent timeout policy.** What happens at `defer:pending:${sessionId}` expiry? Probably: publish a NATS `intent.defer.timeout` event and let a subscriber send a "estamos com problemas" follow-up. Today, silent loss.

### Operational

5. **Migrate critical events to JetStream.** Core NATS losing un-subscribed messages is an availability bug, not a feature.

6. **Authenticate NATS in production.** Use NKey or JWT auth; require auth-decorated subscribers per subject.

7. **Centralize DLQ enumeration.** The CLI's `DLQ_EVENTS` list is hardcoded and incomplete. Build it from the subscriber registry.

8. **Add a subscriber registry.** Today, the only way to know what subscribes to what is `grep`. A typed registry at `apps/api/src/subscribers/registry.ts` exporting `{ subject, handler, dedupKey?, dlqKey?, adjudicatedActor? }` would let tooling enumerate the async surface.

### Quick wins

9. **Add `isNewEvent` to the reservation handlers in cart-intelligence** — otherwise NATS redelivery double-counts profile counters.

10. **Add `pushToDlq` to `payment-lifecycle`** — currently it logs and swallows errors when `transitionStatus` fails, losing the event.

11. **Delete or land** `defer-resolver.ts`. Dead code is worse than missing code when the doc & ADR say it exists.

12. **Add an integration test asserting every published subject has at least one subscriber, or is explicitly marked "fire-and-forget analytics".** Would catch the 6 orphan events.
