# 02 — API & Webhook Mutation Paths

> Investigator 2 of 8 — HTTP API routes & webhook handlers.
> Scope: `apps/api/src/routes/`, `apps/api/src/subscribers/`, `apps/api/src/jobs/`, admin proxy in `apps/admin/`.
> Method: full read of every route file + subscriber + job; cross-referenced against `adjudicate()`/`IntentEnvelope` usage.

## Executive summary

**The HTTP and webhook surface bypasses `adjudicate()` almost entirely.** The kernel
governs **exactly one** path: LLM-proposed tool calls inside `runOrchestrator()`
(packages/llm-provider/src/llm-responder.ts → `adjudicate()`/`adjudicateWithShadow()`).

A grep of `apps/api/src/` for `adjudicate|IntentEnvelope` returns **three lines, all
in one file** (`subscribers/defer-resolver.ts`). Even that file uses runtime helpers
(`resumeDeferredIntent`) — it does not gate webhook-driven mutations through the kernel.

Concretely:

- **0 of 17** customer-facing mutating HTTP routes (`/api/cart/*`, `/api/orders/*`, `/api/reservations/*`, `/api/me/data`) call `adjudicate()`.
- **0 of 27** admin mutating routes (`/api/admin/orders/*`, `/api/admin/products/*`, `/api/admin/schedule/*`, `/api/admin/delivery-zones/*`, `/api/admin/banner`, `/api/admin/tables`, `/api/admin/reservations/*`, `/api/admin/timeslots`) call `adjudicate()`.
- **Stripe webhook** (5 event types, including refunds + dispute opens) writes `Payment` rows, completes carts, and publishes `order.placed` / `order.refunded` / `order.disputed` **without adjudication**.
- **Twilio/WhatsApp inbound** webhook is the **only** large surface that *transitively* hits `adjudicate()` — and only because it pipes through `runOrchestrator()`. Shortcuts/state-machine paths bypass even that.
- **`defer-resolver` subscriber is defined but never started** (`startDeferResolverSubscriber` not called in `apps/api/src/index.ts`). The DEFER resume path documented in ADR #9 / Runbook 04 is **inert at runtime**.
- **Two background jobs** (`stale-order-checker`, `pix-expiry-checker`) cancel orders / expire payments without adjudication.
- **Two NATS subscribers** (`payment-lifecycle`, `cart-intelligence:order.placed`) auto-confirm orders, auto-cancel orders on refund, and create Payment rows — all by calling command services directly.

Approximate adjudication coverage by mutating path:
- LLM-issued mutating tools (WhatsApp/Web chat via `runOrchestrator`): **gated**
- Everything else: **ungated**

If we count distinct mutating entry points (HTTP + webhook + subscriber + job), governance coverage is **~5%** by entry count, **~30–50%** by request volume (WhatsApp/chat are high-traffic).

---

## Route inventory

Files in `apps/api/src/routes/index.ts`, registered in this order. "Adj?" = does this route construct an `IntentEnvelope` and call `adjudicate()`? Answer for every row below is **No**.

### Customer-facing (`/api/...`)

| Method | Path | Auth | Side effect | Classification | Adj? | Bypass severity |
|---|---|---|---|---|---|---|
| POST | /api/webhooks/stripe | Stripe sig | Order create, payment row, NATS, Stripe API | EXTERNAL_SIDE_EFFECT | No | **P0** |
| POST | /api/webhooks/whatsapp | Twilio sig | Triggers `runOrchestrator()` → LLM → tools → adjudicate | EXTERNAL_SIDE_EFFECT | No (entry); **Yes** (via orchestrator for LLM-issued mutating tools) | P1 (shortcuts/state bypass) |
| GET | /health | none | Read-only checks | READ | n/a | OK |
| POST | /api/auth/send-otp | none | Twilio Verify send | EXTERNAL_SIDE_EFFECT | No | P2 |
| POST | /api/auth/verify-otp | none | Customer upsert, JWT issue, refresh token store | MUTATING | No | P1 |
| POST | /api/auth/logout | optional | JWT revocation (Redis), refresh token delete | MUTATING | No | P2 |
| POST | /api/auth/refresh | none | Refresh token rotate, JWT issue | MUTATING | No | P2 |
| GET | /api/auth/me | required | Read | READ | n/a | OK |
| POST | /api/auth/staff/send-otp | none | Twilio Verify send (staff) | EXTERNAL_SIDE_EFFECT | No | P2 |
| POST | /api/auth/staff/verify-otp | none | Staff JWT issue | MUTATING | No | P1 |
| POST | /api/chat/messages | optional | Session lock, append message, start `runOrchestrator()` | MUTATING | No (entry); **Yes** (via orchestrator) | P1 (entry untracked) |
| GET | /api/chat/stream/:sessionId | optional | SSE read | READ | n/a | OK |
| GET | /api/products | none | Typesense read | READ | n/a | OK |
| GET | /api/products/personalized | optional | Typesense read | READ | n/a | OK |
| GET | /api/products/:id | none | Read | READ | n/a | OK |
| GET | /api/products/:id/reviews | none | Read | READ | n/a | OK |
| GET | /api/categories | none | Read | READ | n/a | OK |
| POST | /api/cart | optional | Medusa cart create | MUTATING | No | P1 |
| GET | /api/cart/:id | optional | Read | READ | n/a | OK |
| POST | /api/cart/:id/line-items | optional | Medusa cart write | MUTATING | No | P1 |
| PATCH | /api/cart/:id/line-items/:itemId | optional | Medusa cart write | MUTATING | No | P1 |
| DELETE | /api/cart/:id/line-items/:itemId | optional | Medusa cart write | MUTATING | No | P1 |
| POST | /api/cart/:id/sync | optional | Bulk cart write | MUTATING | No | P1 |
| POST | /api/cart/:id/promotions | optional | Medusa promotion attach | MUTATING | No | P1 |
| POST | /api/cart/:id/payment-sessions | optional | Medusa payment session init | MUTATING | No | P1 |
| POST | /api/cart/checkout | optional* | `createCheckout()` — order placement, Stripe PI create, Payment row | MUTATING | No | **P0** |
| GET | /api/cart/pix-details | required | Read | READ | n/a | OK |
| GET | /api/cart/delivery-estimate | none | Read | READ | n/a | OK |
| GET | /api/cart/orders/:orderId | optional | Read | READ | n/a | OK |
| GET | /api/cart/orders/:orderId/status | optional | Read | READ | n/a | OK |
| POST | /api/coupons/validate | optional | Read | READ | n/a | OK |
| GET | /api/shipping/estimate | none | Read | READ | n/a | OK |
| GET | /api/banner/text | none | Redis read | READ | n/a | OK |
| GET | /api/schedule/status | none | Redis read | READ | n/a | OK |
| GET | /api/recommendations | optional | Read | READ | n/a | OK |
| GET | /api/recommendations/also-added | none | Read | READ | n/a | OK |
| GET | /api/customer/orders | required | Read | READ | n/a | OK |
| GET | /api/reservations/availability | none | Read | READ | n/a | OK |
| POST | /api/reservations | required | `createReservation()` tool — Reservation row, NATS | MUTATING | No | **P0** |
| GET | /api/reservations | required | Read | READ | n/a | OK |
| PATCH | /api/reservations/:id | required | `modifyReservation()` tool | MUTATING | No | P1 |
| DELETE | /api/reservations/:id | required | `cancelReservation()` tool | MUTATING | No | P1 |
| POST | /api/reservations/:id/waitlist | required | `joinWaitlist()` tool | MUTATING | No | P2 |
| POST | /api/orders/:id/cancel | required | Order status → CANCELED, payment cancel, NATS | MUTATING | No | **P0** |
| POST | /api/orders/:id/amend/batch | required | `amendOrder()` tool, sequenced | MUTATING | No | **P0** |
| POST | /api/orders/:id/amend | required | `amendOrder()` tool (legacy) | MUTATING | No | **P0** |
| POST | /api/orders/:id/notes | required | OrderNote insert, NATS | MUTATING | No | P2 |
| GET | /api/orders/:id/notes | required | Read | READ | n/a | OK |
| GET | /api/orders/:id/payment | required | Read | READ | n/a | OK |
| POST | /api/orders/:id/payment/retry | required | Payment cancel + create | MUTATING | No | **P0** |
| POST | /api/orders/:id/payment/regenerate-pix | required | Payment cancel + create | MUTATING | No | **P0** |
| PATCH | /api/orders/:id/payment/method | required | Payment cancel + create, NATS | MUTATING | No | **P0** |
| PATCH | /api/orders/:id/address | required | `changeDeliveryAddress()` tool | MUTATING | No | P1 |
| PATCH | /api/orders/:id/type | required | `switchOrderType()` tool | MUTATING | No | P1 |
| POST | /api/analytics/track | none | NATS publish only | EXTERNAL_SIDE_EFFECT | No | P3 (event firehose only) |
| GET | /api/me/data | required | Read | READ | n/a | OK |
| DELETE | /api/me/data | required | `anonymizeCustomer()` — destructive PII overwrite | MUTATING | No | **P0** |

`*` POST /api/cart/checkout requires auth when paymentMethod ∈ {cash, pix}; card may be guest.

### Admin (`/api/admin/...`)

Auth column shows the *minimum* role; all routes are also reachable via `x-admin-key` (legacy). `requireManagerRole` is permissive when only API key is present.

| Method | Path | Auth | Side effect | Classification | Adj? | Bypass severity |
|---|---|---|---|---|---|---|
| GET | /api/admin/dashboard | staff/key | Read | READ | n/a | OK |
| GET | /api/admin/products | staff/key | Read | READ | n/a | OK |
| PATCH | /api/admin/products/:id | MANAGER+ | Medusa product update | MUTATING | No | P1 |
| GET | /api/admin/products/:id | staff/key | Read | READ | n/a | OK |
| GET | /api/admin/orders | staff/key | Read | READ | n/a | OK |
| GET | /api/admin/orders/:id | staff/key | Read | READ | n/a | OK |
| PATCH | /api/admin/orders/:id | MANAGER+ | Order status transition + NATS | MUTATING | No | **P0** |
| GET | /api/admin/reservations | staff/key | Read | READ | n/a | OK |
| POST | /api/admin/reservations/:id/checkin | MANAGER+ | Reservation state machine | MUTATING | No | P1 |
| POST | /api/admin/reservations/:id/complete | MANAGER+ | Reservation state machine | MUTATING | No | P1 |
| POST | /api/admin/reservations/:id/cancel | MANAGER+ | Reservation cancel + TimeSlot decrement | MUTATING | No | P1 |
| GET | /api/admin/reviews | staff/key | Read | READ | n/a | OK |
| GET | /api/admin/tables | staff/key | Read | READ | n/a | OK |
| POST | /api/admin/tables | MANAGER+ | Table upsert | MUTATING | No | P2 |
| POST | /api/admin/timeslots | MANAGER+ | Bulk TimeSlot insert | MUTATING | No | P2 |
| GET | /api/admin/delivery-zones | staff/key | Read | READ | n/a | OK |
| POST | /api/admin/delivery-zones | MANAGER+ | DeliveryZone create | MUTATING | No | P1 |
| PUT | /api/admin/delivery-zones/:id | MANAGER+ | DeliveryZone update | MUTATING | No | P1 |
| DELETE | /api/admin/delivery-zones/:id | MANAGER+ | DeliveryZone delete | MUTATING | No | P1 |
| GET | /api/admin/analytics/summary | staff/key | Read | READ | n/a | OK |
| GET | /api/admin/schedule | staff/key | Read | READ | n/a | OK |
| PUT | /api/admin/schedule/weekly | MANAGER+ | 7-day schedule upsert + cache invalidate | MUTATING | No | P1 |
| POST | /api/admin/schedule/holidays | MANAGER+ | Holiday insert + cache invalidate | MUTATING | No | P2 |
| DELETE | /api/admin/schedule/holidays/:id | MANAGER+ | Holiday delete | MUTATING | No | P2 |
| GET | /api/admin/schedule/overrides | staff/key | Read | READ | n/a | OK |
| PUT | /api/admin/schedule/overrides/:date | MANAGER+ | Override upsert | MUTATING | No | P2 |
| DELETE | /api/admin/schedule/overrides/:date | MANAGER+ | Override delete | MUTATING | No | P2 |
| POST | /api/admin/orders/:id/payment/confirm-cash | ATTENDANT+ | Payment → PAID, NATS | MUTATING | No | **P0** |
| POST | /api/admin/orders/:id/payment/refund | MANAGER+ | Payment → REFUNDED, NATS | MUTATING | No | **P0** |
| PATCH | /api/admin/orders/:id/payment/status | OWNER | Force any payment status | MUTATING | No | **P0** |
| POST | /api/admin/orders/:id/notes | ATTENDANT+ | OrderNote insert + NATS | MUTATING | No | P2 |
| GET | /api/admin/orders/:id/notes | ATTENDANT+ | Read | READ | n/a | OK |
| GET | /api/admin/orders/:id/payments | ATTENDANT+ | Read | READ | n/a | OK |
| POST | /api/admin/orders/:id/force-cancel | MANAGER+ | Force order CANCELED + payment cancel + NATS | MUTATING | No | **P0** |
| POST | /api/admin/orders/:id/advance | ATTENDANT+ | Advance order fulfillment status | MUTATING | No | **P0** |
| POST | /api/admin/orders/:id/waive | OWNER | Payment → WAIVED + NATS | MUTATING | No | **P0** |
| POST | /api/admin/orders/:id/staff-notes | ATTENDANT+ | OrderNote internal insert | MUTATING | No | P3 |
| GET | /api/admin/banner | staff/key | Read | READ | n/a | OK |
| PUT | /api/admin/banner | MANAGER+ | Banner text set | MUTATING | No | P3 |
| DELETE | /api/admin/banner | MANAGER+ | Banner text clear | MUTATING | No | P3 |

### Totals

- HTTP routes inventoried: **80**.
- Mutating / external-side-effect routes: **47** (customer 20, admin 27).
- Adjudicated at the HTTP layer: **0**.
- Indirectly adjudicated via `runOrchestrator()`: **2** entry points (`POST /api/webhooks/whatsapp`, `POST /api/chat/messages`), but only for LLM-issued tool calls; route-side side effects (session writes, locks, message append) are not.

---

## Webhook handlers (deep dives)

### Stripe (`apps/api/src/routes/stripe-webhook.ts`)

**Endpoint:** `POST /api/webhooks/stripe`
**Auth:** Stripe signature (HMAC) via `stripe.webhooks.constructEvent`
**Idempotency:** Redis `webhook:processed:{event.id}` NX EX 7 days; failure path drops TTL to 5min so retries can succeed
**Events handled:**

| Stripe event | Side effects | Adjudicated? |
|---|---|---|
| `payment_intent.succeeded` | (1) `medusaStore POST /store/carts/{id}/complete` to create order for PIX, (2) `stripe.paymentIntents.update` to persist `medusaOrderId`, (3) `svc.capturePayment()` (Medusa admin), (4) `publishNatsEvent("order.placed", …)`, (5) `paymentCmdSvc.reconcileFromWebhook` → Payment row to PAID, (6) `publishNatsEvent("payment.status_changed", …)`, (7) `eventLogSvc.append` audit row, (8) `markPixPaid()` Redis, (9) Customer pending-order cleanup | **No** |
| `payment_intent.payment_failed` | `reconcilePaymentFromStripe` → PAYMENT_FAILED, NATS `order.payment_failed` | **No** |
| `charge.refunded` | `reconcilePaymentFromStripe` → REFUNDED or PARTIALLY_REFUNDED, NATS `order.refunded` | **No** |
| `charge.dispute.created` | `reconcilePaymentFromStripe` → DISPUTED, NATS `order.disputed` (escalation) | **No** |
| `payment_intent.canceled` | `reconcilePaymentFromStripe` → CANCELED, NATS `order.canceled` | **No** |

The webhook is **the highest-risk single mutation path in the system.** It

1. **Creates orders** that the LLM/agent never proposed (PIX cart completion). Adjudicate has no visibility — there is no envelope, no policy bundle, no ledger entry.
2. **Issues refunds and disputes**, which are state transitions Pack #pix-payments was created to govern, yet the kernel never sees them.
3. Couples Stripe wire vocabulary (`paid`, `captured`, `confirmed`) to internal `PaymentStatus` via `reconcileFromWebhook` — a duplicate of policy logic that should be in the kernel.

**Downstream subscribers** (`payment-lifecycle.ts`, `cart-intelligence.ts: order.placed`) consume the resulting NATS events and *further mutate state* (auto-confirm order, auto-cancel order on refund, create Payment row). None of these subscribers call `adjudicate()`.

### Twilio / WhatsApp (`apps/api/src/routes/whatsapp-webhook.ts`)

**Endpoint:** `POST /api/webhooks/whatsapp`
**Auth:** Twilio signature via `twilio.validateRequest`
**Idempotency:** Redis `wa:webhook:{MessageSid}` NX EX 24h
**Rate limit:** 20 msgs/min per phone hash via Lua-backed atomic INCR
**Debounce:** 2s window to batch rapid-fire messages

Flow:
1. Verify sig → idempotency → rate limit → 200 OK *immediately* (sync).
2. Async: `resolveWhatsAppSession`, conversation metrics INCR, GPS storage, LGPD opt-in send, append user message to Redis session, debounce 2s, acquire agent lock.
3. `tryShortcutOrStateMachine` — if shortcut matches (`/help`, `/welcome`), send static text directly. **Bypasses LLM entirely** — no adjudicate.
4. Otherwise: `runOrchestrator(input, history, context)` — this is where mutating tools propose intents and `adjudicate()` gates them. The orchestrator path is the one truly governed surface.
5. Send response via `sendText` / `sendMedia` to Twilio API (no adjudicate).
6. Schedule PIX expiry monitor and hesitation nudge (BullMQ enqueue, no adjudicate).

**Risk surface:**
- The webhook itself appends messages, sets welcome credits, and schedules background jobs *outside* the orchestrator. Welcome-credit set is a Redis-only economic mutation (R$15 credit, see CLAUDE.md), and it bypasses the kernel.
- Shortcut path sends arbitrary canned text without policy gates — minor risk (static content), but no audit trail.
- `setWelcomeCredit` (`apps/api/src/whatsapp/session.ts`) is the only place a R$15 promotional credit is created. It is not an `IntentEnvelope`. If the kernel one day enforces a "loyalty.welcome_credit.granted" intent, this site needs migration.

### WhatsApp Business

There is **no separate WhatsApp Business webhook**. IbateXas uses Twilio's WhatsApp channel exclusively (confirmed by reading `apps/api/src/whatsapp/client.ts` and absence of any `meta`/`facebook`/`graph.facebook.com` references in the routes).

### Medusa internal webhooks

There are **no inbound Medusa webhooks** in `apps/api/`. The integration is outbound only — `medusaAdmin()` and `medusaStore()` helpers in `@ibatexas/tools` and `apps/api/src/routes/admin/_shared.ts`.

Medusa has its own subscribers in `apps/commerce/src/subscribers/` (`order-delivered`, `product-created`, etc.) but those run inside the Medusa container and use its event bus, not Fastify endpoints.

### Other (analytics, health)

- `POST /api/analytics/track` is technically an external-mutation surface (publishes to NATS), but only for analytics events from a whitelist. **No adjudicate.** Severity P3 — pure observability.
- `GET /health` is read-only.
- `GET /api/schedule/status`, `GET /api/banner/text` are public reads.

---

## NATS subscribers inventory

Located in `apps/api/src/subscribers/`. All are started in `apps/api/src/index.ts` *except* `defer-resolver`.

| File | Subjects | Side effects | Adj? | Severity |
|---|---|---|---|---|
| `cart-intelligence.ts` | `cart.abandoned`, `order.placed`, `order.payment_failed`, `product.viewed`, `search.results_viewed`, `review.prompt.schedule`, `order.status_changed`, `notification.send`, `reservation.created`, `reservation.modified`, `reservation.cancelled`, `reservation.no_show`, `review.prompt`, `order.refunded`, `order.disputed`, `order.canceled`, `review.submitted`, `product.intelligence.purge`, `outreach.sent`, `cart.item_added`, `follow-up.due` | **Heavy mutating**: creates Payment row on `order.placed` (line 446 `paymentCmdSvc.create`), creates OrderProjection, updates copurchase scores, customer profile, schedules review prompts, sends WhatsApp notifications | **No** | **P0** |
| `handoff-subscriber.ts` | `support.handoff_requested` | Sends WhatsApp to STAFF_NOTIFICATION_PHONE via `getWhatsAppSender()` | No | P2 |
| `conversation-archiver.ts` | `conversation.message.appended` | Postgres append to Conversation/Message tables (CDC sink) | No | P3 (durable archive) |
| `payment-lifecycle.ts` | `payment.status_changed` | **Auto-confirms order on PAID**, **auto-cancels order on REFUNDED**, sends customer notifications on EXPIRED/FAILED, escalates DISPUTED | **No** | **P0** |
| `defer-resolver.ts` | `payment.status_changed` (PIX confirmation only) | Calls `resumeDeferredIntent()` from `@adjudicate/runtime` to unblock parked LLM intents | **No** (uses runtime helper, not `adjudicate()`); **and not wired into `index.ts`** | **P0** (DEFER path is inert at runtime) |
| `dedup.ts` | helper (not a subscriber) | — | n/a | — |
| `dlq.ts` | helper (DLQ writer) | — | n/a | — |

**Critical finding:** `startDeferResolverSubscriber` is exported but never imported or called. `apps/api/src/index.ts` lines 6–10 register four subscribers (`startCartIntelligenceSubscribers`, `startHandoffSubscriber`, `startConversationArchiver`, `startPaymentLifecycleSubscriber`) — defer-resolver is absent. This means:

- The DEFER + webhook-resume path documented in ADR #9 and `docs/ops/runbooks/04-stage-financial-mutations.md` (the lighthouse Pack flow!) **does not actually run in production**.
- Any LLM intent that adjudicate routes to a DEFER decision will park in Redis (`defer:pending:*`) and never resume on PIX confirmation.
- Confirmed by: `grep -rn "startDeferResolverSubscriber" apps/api/` returns only the definition line — no call sites.

---

## Admin surface analysis

The admin app (`apps/admin/`) is a Next.js frontend. Its only API route is a thin proxy:

- `apps/admin/src/app/api/proxy/[...path]/route.ts` forwards any `/api/admin/*` or `/api/auth/staff/*` request to the Fastify backend, injecting `x-admin-key` and forwarding cookies.
- The proxy enforces an allow-list (`["/api/admin/", "/api/auth/staff/"]`) but does **not** call `adjudicate()`. It is pure HTTP relay.

The admin app does not have its own database writes — every mutation goes through the Fastify routes in `apps/api/src/routes/admin/*`.

**Admin mutating surface (27 routes, listed in the inventory above):** zero adjudication. Key risks:

- **Force-cancel order** (`POST /api/admin/orders/:id/force-cancel`, MANAGER+): bypasses all order policy. The kernel's `order-policy-bundle.ts` defines transition validity — admin force-cancel ignores it.
- **Force payment status** (`PATCH /api/admin/orders/:id/payment/status`, OWNER): can set any of 12 payment states without policy review.
- **Refund** (`POST /api/admin/orders/:id/payment/refund`, MANAGER+): writes refunded amount into Payment table directly via `prisma.payment.update`, only checks `refundableAmount` arithmetic — no policy bundle, no ledger entry, no `IntentEnvelope`.
- **Waive payment** (`POST /api/admin/orders/:id/waive`, OWNER): sets PaymentStatus.WAIVED — the "we ate the cost" terminal state. No adjudicate review of who/when/why beyond the route handler's role check.

The dual-auth model (API key `x-admin-key` OR staff JWT) means **headless scripts with the API key** can perform any admin mutation. Since the API key is in `process.env.ADMIN_API_KEY`, any process that holds it (CI, ops scripts, the admin proxy) is a fully privileged actor with zero adjudicate gating.

---

## Background jobs (BullMQ workers)

Registered in `apps/api/src/jobs/register-workers.ts`:

| Job | Mutating effect | Adj? | Severity |
|---|---|---|---|
| `stale-order-checker` (30min) | **Cancels** unpaid orders past STALE_ORDER_THRESHOLD_HOURS via `orderCmdSvc.transitionStatus` → CANCELED, cancels active payment, publishes `order.canceled` | **No** | **P0** |
| `pix-expiry-checker` (5min) | Transitions PIX payments past `pixExpiresAt` → PAYMENT_EXPIRED, cancels Stripe PI, publishes `payment.status_changed` | **No** | **P0** |
| `pix-expiry-monitor` | Per-order BullMQ-scheduled PIX reminders + final expired notification; sends WhatsApp via `sendText` | **No** | P2 |
| `outbox-retry` | Replays failed NATS events from outbox queues | **No** | P2 (replay only) |
| `abandoned-cart-checker` (15min) | Publishes `cart.abandoned` NATS events — no direct DB writes | **No** | P2 |
| `reservation-reminder` | Sends WhatsApp reminders for upcoming reservations | **No** | P3 |
| `no-show-checker` | Marks reservations no-show via `createReservationService` | **No** | P2 |
| `review-prompt-poller` | Schedules review prompts after delivery | **No** | P3 |
| `hesitation-nudge` | Sends WhatsApp nudge to hesitating customers | **No** | P3 |
| `proactive-engagement` | Initiates outreach campaigns | **No** | P3 |
| `follow-up-poller` | Pulls `follow-up.due` events | **No** | P3 |

**Critical:** `stale-order-checker` is the only system actor that auto-cancels orders for inactivity. It runs unguarded by the kernel even though the order-policy-bundle defines what cancel transitions are legal.

---

## Top bypass paths (P0/P1/P2)

### P0 — high blast radius, money-touching, runs without adjudicate

1. **Stripe webhook → order create + Payment reconcile + NATS publish** (`POST /api/webhooks/stripe`). Single entry point for every successful PIX/card payment. Captures real money, no kernel review.
2. **Admin payment refund** (`POST /api/admin/orders/:id/payment/refund`). Sends money out, no kernel review.
3. **Admin force payment status / waive payment / force-cancel order** (3 routes under `/api/admin/orders/:id/*`). Each can put the system in any terminal state without policy review.
4. **Customer checkout** (`POST /api/cart/checkout`). Creates order, Stripe PaymentIntent, Payment row. Largest customer-facing money event, fully ungated.
5. **Customer order cancel** (`POST /api/orders/:id/cancel`). PONR validation happens in the route handler via `canPerformAction()` (good!) but no `IntentEnvelope`, no ledger entry, no adjudicate.
6. **Customer payment retry / regenerate-PIX / switch payment method** (3 routes under `/api/orders/:id/payment/*`). Each cancels one Payment and creates another.
7. **Admin order status PATCH and order advance** (`PATCH /api/admin/orders/:id`, `POST /api/admin/orders/:id/advance`). Transitions order fulfillment state; only enforces version concurrency + `canTransition()` static map, no policy bundle.
8. **`payment-lifecycle` subscriber** auto-confirms orders on PAID and auto-cancels on REFUNDED.
9. **`cart-intelligence:order.placed` subscriber** creates the Payment row on every order — the *primary* path Payment rows enter the system for non-webhook flows.
10. **`stale-order-checker` job** cancels orders by clock alone, no adjudicate.
11. **`pix-expiry-checker` job** expires payments + cancels Stripe PIs by clock alone, no adjudicate.
12. **`defer-resolver` subscriber NOT WIRED.** The DEFER resume path is inert; any kernel decision of "DEFER" will park forever.
13. **`DELETE /api/me/data`** — destructive PII overwrite (LGPD anonymize). Should at minimum be a discrete intent for audit.

### P1 — visible mutations, no kernel oversight

14. **Cart mutations** (`POST/PATCH/DELETE /api/cart/:id/line-items/*`, `POST /api/cart/:id/sync`). Allergen-bearing decisions (`HARD-RULE` #1) happen at variant-add time; bypass.
15. **Reservation create/modify/cancel** (`/api/reservations/*`). Composes reservation state machine; no kernel.
16. **Admin reservation checkin/complete/cancel** (`/api/admin/reservations/:id/*`). Manager-only but no kernel.
17. **Admin schedule mutations** (`/api/admin/schedule/*`). Sets restaurant open hours — affects KITCHEN_CLOSED checkout gates downstream.
18. **Admin delivery-zone CRUD** (`/api/admin/delivery-zones/*`). Sets delivery fees + zones.
19. **Admin product PATCH** (`PATCH /api/admin/products/:id`). Sets product status (published/draft) and metadata — directly affects catalog visibility.
20. **`changeDeliveryAddress` and `switchOrderType` via HTTP** (`PATCH /api/orders/:id/address`, `PATCH /api/orders/:id/type`). These exact functions ARE in `TOOL_CLASSIFICATION.MUTATING` when called via LLM, but HTTP route calls them directly with `apiContext()` — same function, two routes, one adjudicated and one not.

### P2 — auth/identity, support flows, schedule overrides

21. **Customer/staff OTP verify** (`POST /api/auth/(staff/)verify-otp`). JWT issuance + customer/staff upsert. Should be an intent if we ever want kernel-side rate limits or attestation.
22. **Logout / refresh** (`POST /api/auth/logout`, `POST /api/auth/refresh`). JWT/refresh revocation in Redis.
23. **Customer note insert and admin note insert** (`POST /api/orders/:id/notes`, `POST /api/admin/orders/:id/notes`, `POST /api/admin/orders/:id/staff-notes`). Customer-visible audit log entries.
24. **`handoff-subscriber`** — staff WhatsApp notification fan-out for support escalations.

---

## Gaps and recommendations

### Most consequential gaps

1. **Webhooks are the single biggest gap.** Stripe events are the only path through which money is captured/refunded, and they enter the system with zero kernel oversight. Every Payment row created by the webhook is an undocumented intent.
2. **The DEFER resume path is dead code.** Whatever runbook 04 promises, in current production no DEFER decision can complete. This needs verification urgently — if the kernel is shadow-enforced for any PIX intents today, the corresponding deferred intents are accumulating in Redis without resume.
3. **HTTP routes duplicate tool logic.** `amendOrder`, `changeDeliveryAddress`, `switchOrderType`, `createCheckout`, `createReservation`, `cancelReservation`, `modifyReservation`, `joinWaitlist` are all tools in `TOOL_CLASSIFICATION.MUTATING` *and* HTTP endpoints. The LLM call is gated; the HTTP call is not. **Same function, two security models.**
4. **Subscribers mutate without kernel review.** `payment-lifecycle.ts` auto-confirms/auto-cancels orders in reaction to webhook-driven NATS events — the policy decisions ("can this order be auto-confirmed?") live in if-statements, not in a policy bundle.
5. **Background jobs cancel orders/payments by wall clock.** Two jobs (`stale-order-checker`, `pix-expiry-checker`) make terminal state transitions with no kernel involvement.

### Recommended sequencing

**Phase API-1 (governance for webhook surface):**
- Wrap Stripe webhook handlers (`payment_intent.succeeded`, `charge.refunded`, `charge.dispute.created`, `payment_intent.canceled`) in `IntentEnvelope` construction → `adjudicate()` → execute. Use existing `order-policy-bundle.ts` and `pack-payments-pix` Pack. Treat the webhook event as the source of the intent (actor = "stripe-webhook", correlation = event.id).
- **Wire `startDeferResolverSubscriber` into `apps/api/src/index.ts`** before shadow/enforce rollout for PIX. This is a one-line fix and must precede any DEFER-emitting kernel deployment.

**Phase API-2 (route ↔ tool unification):**
- HTTP routes that call the eight overlapping tool functions (`amendOrder`, `createCheckout`, etc.) should go through a thin "API intent gateway": build an envelope, call `adjudicate()`, then dispatch. Estimated 4–6 routes get changed; all reuse existing tool functions as executors.

**Phase API-3 (admin surface):**
- The 12 highest-blast admin routes (force-cancel, refund, waive, force payment status, status PATCH, advance, product PATCH, schedule PUTs, delivery-zone CRUD, banner PUT) need kernel envelopes. Each has a clear discriminator (`admin:{action}:{orderId|productId|zoneId}`) that can drive the ledger.
- Consider keeping a parallel "admin escape hatch" for true emergencies that records an envelope with `ADJUDICATE_BYPASS=true` plus operator identity — better than silent direct mutation.

**Phase API-4 (subscribers + jobs):**
- `payment-lifecycle` auto-confirm/auto-cancel branches each become an intent (`order.auto_confirm_on_paid`, `order.auto_cancel_on_refund`).
- `stale-order-checker` cancel becomes `order.cancel_stale` intent — easiest to start with this one since it runs every 30 minutes and produces clean test cases.
- `pix-expiry-checker` payment-expire becomes a Pack-managed intent (already lives in `pack-payments-pix`'s vocabulary, just needs the adapter).

**Phase API-5 (low-priority breadth):**
- Notes, auth, analytics, banner CRUD — fold in last; risk is low and benefit is consistency, not safety.

### Effort estimate

To bring the API surface to ≥95% governance coverage:

- **Phase API-1 (webhook + defer wiring):** ~3–5 days. The bulk is testing — the wiring is small. Defer wiring is 1 LOC.
- **Phase API-2 (tool/HTTP unification):** ~5–8 days for 6–8 routes. Each route gets ~50 LOC of envelope construction + tests. Reuses existing tool implementations.
- **Phase API-3 (admin surface):** ~10–14 days for 12 high-risk admin routes. Each transition becomes an envelope kind + policy gate + ledger entry.
- **Phase API-4 (subscribers + 2 jobs):** ~5–7 days. Subscribers need careful handling — they execute concurrently and the ledger must be idempotent across redelivery.
- **Phase API-5 (long tail):** ~5 days mop-up for notes, auth, banner, schedule overrides.

**Total to 95% coverage:** ~30–40 engineer-days. Critical-path P0 items (Phase API-1 + DEFER wiring) are achievable in **1 week**.

