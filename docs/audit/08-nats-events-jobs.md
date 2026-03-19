# 08 Audit: NATS Events & Background Jobs

## Executive Summary

The NATS event system and background jobs are **functionally correct for the current scale** but carry **significant durability risk**. The most critical finding is that JetStream is enabled in Docker but the application uses NATS Core (fire-and-forget), meaning **every event published during a server restart, deployment, or subscriber crash is silently lost**. This affects order intelligence, customer profiling, abandoned cart nudges, review prompts, and product indexing. At current volume this is acceptable risk; at scale it becomes a data loss vector.

Background jobs use `setInterval` without overlap guards — if any job's execution time exceeds its interval period, multiple instances will run concurrently, causing duplicate NATS events and duplicate WhatsApp messages. The abandoned cart checker additionally uses a flawed idle-time heuristic that produces false positives for authenticated sessions.

**Top 3 Findings:**
1. **(C) NATS Core fire-and-forget: events silently lost during deploys** — `packages/nats-client/src/index.ts:3`
2. **(H) No job overlap guard: concurrent runs cause duplicate events/messages** — all jobs in `apps/api/src/jobs/`
3. **(H) Abandoned cart idle heuristic assumes guest TTL for all sessions** — `apps/api/src/jobs/abandoned-cart-checker.ts:43`

## Scope
- NATS client package (`packages/nats-client/`)
- Background jobs (`apps/api/src/jobs/`)
- Event subscribers (`apps/api/src/subscribers/`, `apps/commerce/src/subscribers/`)
- Server startup and shutdown lifecycle (`apps/api/src/index.ts`)
- Docker NATS configuration (`docker-compose.yml`)

## System Invariants (Must Always Be True)
1. No event is ever published without at least one subscriber
2. Background jobs never overlap (concurrent runs)
3. Job failures never crash the server
4. Events during deployment are not silently lost
5. NATS subjects always use short-form naming

## Assumptions That May Be False

| # | Assumption | Evidence | Risk |
|---|---|---|---|
| 1 | All sessions in `active:carts` are guest sessions with 48h TTL | `abandoned-cart-checker.ts:43` hardcodes `GUEST_TTL = 48 * 60 * 60` | **High** — Authenticated sessions use 24h TTL. The idle calculation `GUEST_TTL * 1000 - remainingMs` overestimates idle time by ~24h for auth sessions, triggering false-positive abandoned cart events and spurious WhatsApp nudges. Cross-ref: redis-auditor finding. |
| 2 | NATS subscribers are always online when events are published | Code uses NATS Core (fire-and-forget), not JetStream | **Critical** — During deploys, restarts, or crashes, all in-flight events are silently dropped. Affects order intelligence, review prompts, product indexing. |
| 3 | A single API server instance runs at a time | No distributed lock on `setInterval` jobs | **High** — If horizontally scaled, every instance runs its own abandoned-cart/no-show/review-prompt jobs concurrently. Duplicate events, duplicate WhatsApp messages. |
| 4 | Background job execution completes before the next interval fires | No overlap guard in any job | **Medium** — If Redis SSCAN over a large `active:carts` set takes >15min, or DB queries are slow, concurrent job runs cause duplicate processing. |
| 5 | `closeNatsConnection()` is called before all in-flight publishes complete | Shutdown calls `stopJobs()` then `closeNatsConnection()` — but jobs use `void` fire-and-forget publishes | **Medium** — In-flight `publishNatsEvent` calls from the last job tick may race against connection closure. |
| 6 | The `active:carts` Redis SET is eventually consistent (all members have valid sessions) | Cart members are only cleaned up during the abandoned-cart-checker run | **Low** — If the checker is down for an extended period, stale members accumulate but are harmless (just extra SSCAN iterations). |

## Event Inventory

### NATS Events Published

| Event (short form) | Publisher(s) | Subscriber(s) | Durability | Notes |
|---|---|---|---|---|
| `cart.abandoned` | `abandoned-cart-checker.ts:61` | `cart-intelligence.ts:84` | Core (lossy) | Triggers WhatsApp nudge via `notification.send` relay |
| `cart.item_added` | `add-to-cart.ts:24`, `reorder.ts:53` | **NONE** | Core (lossy) | **Dead event** — published but no subscriber |
| `order.placed` | `stripe-webhook.ts:52`, `create-checkout.ts:108` | `cart-intelligence.ts:101` | Core (lossy) | Drives customer intelligence, copurchase scores |
| `order.payment_failed` | `stripe-webhook.ts:239` | `cart-intelligence.ts:164` | Core (lossy) | Observability only (log) |
| `order.refunded` | `stripe-webhook.ts:85` | **NONE** | Core (lossy) | **Dead event** — published but no subscriber |
| `order.disputed` | `stripe-webhook.ts:112` | **NONE** | Core (lossy) | **Dead event** — published but no subscriber |
| `order.canceled` | `stripe-webhook.ts:145` | **NONE** | Core (lossy) | **Dead event** — published but no subscriber |
| `product.viewed` | `search-products.ts:523`, `get-product-details.ts:20` | `cart-intelligence.ts:178` | Core (lossy) | Updates recentlyViewed in Redis profile |
| `product.indexed` | `_product-indexing.ts:39`, `product-deleted.ts:29`, `price-updated.ts:97`, `variant-updated.ts:69` | **NONE** | Core (lossy) | **Dead event** — informational, no consumer |
| `review.prompt.schedule` | `order-delivered.ts:35` | `cart-intelligence.ts:208` | Core (lossy) | Bridges Medusa → API review-prompt scheduling |
| `review.prompt` | `review-prompt-poller.ts:44` | `cart-intelligence.ts:333` | Core (lossy) | Sends WhatsApp review request |
| `review.submitted` | `submit-review.ts:44` | **NONE** | Core (lossy) | **Dead event** — published but no subscriber |
| `notification.send` | `cart-intelligence.ts:91` | `cart-intelligence.ts:228` | Core (lossy) | Internal relay: cart.abandoned → WhatsApp delivery |
| `reservation.created` | `create-reservation.ts:35` | `cart-intelligence.ts:271` | Core (lossy) | Updates profile reservationCount |
| `reservation.modified` | `modify-reservation.ts:29` | `cart-intelligence.ts:288` | Core (lossy) | Updates profile lastReservationModifiedAt |
| `reservation.cancelled` | `cancel-reservation.ts:49` | `cart-intelligence.ts:303` | Core (lossy) | Increments cancellationCount |
| `reservation.no_show` | `no-show-checker.ts:59` | `cart-intelligence.ts:318` | Core (lossy) | Increments noShowCount |
| `whatsapp.message.received` | `whatsapp-webhook.ts:296` | **NONE** | Core (lossy) | **Dead event** — observability intent, no consumer |
| `whatsapp.message.sent` | `whatsapp-webhook.ts:396` | **NONE** | Core (lossy) | **Dead event** — observability intent, no consumer |
| `web.*` (33 event types) | `analytics.ts:83` | **NONE** | Core (lossy) | **Dead events** — all analytics events have no NATS subscriber |

### Summary
- **Total unique event types:** 20+ (excluding 33 `web.*` analytics variants)
- **Events with subscribers:** 11
- **Dead events (no subscriber):** 9+ (plus 33 `web.*` variants)

### Medusa Internal Events (not NATS)
These use Medusa's internal event bus, NOT NATS:
- `product.created` → `product-created.ts` (Medusa subscriber)
- `product.updated` → `product-updated.ts` (Medusa subscriber)
- `product.deleted` → `product-deleted.ts` (Medusa subscriber)
- `product-variant.updated` → `variant-updated.ts` (Medusa subscriber)
- `pricing.price.updated/created/deleted` → `price-updated.ts` (Medusa subscriber)
- `order.delivered` → `order-delivered.ts` (Medusa subscriber)

---

## Findings

### F-01 [C] NATS Core Fire-and-Forget — Events Lost During Deploys

**Evidence:** `packages/nats-client/src/index.ts:3` — explicit comment: `"NOTE: Uses Core NATS (fire-and-forget), not JetStream."` Docker config at `docker-compose.yml:64` enables JetStream (`--jetstream`), but application code never creates streams or consumers.

**Blast Radius:** ALL 11 event-with-subscriber flows. During a deploy or crash:
- `order.placed` events lost → customer intelligence not updated, copurchase scores stale
- `review.prompt.schedule` lost → customer never gets review prompt
- `cart.abandoned` lost → abandoned cart nudge never sent
- `reservation.*` lost → customer profile counters incorrect

**Time to Failure:** Every deployment. With a rolling deploy and 2+ instances the window is smaller, but with a single API instance the window equals restart time (~5-15s). Any event published in this window is permanently lost.

**Production Simulation:**
1. Stripe webhook fires `order.placed` during API restart
2. `publishNatsEvent` connects to NATS, publishes to subject `ibatexas.order.placed`
3. No subscriber is listening (API server is restarting)
4. NATS Core discards the message — no persistence, no retry
5. Customer intelligence never updated. No review prompt scheduled. Silent data loss.

**Mitigation:** Either (a) migrate to JetStream with durable consumers (the `--jetstream` flag is already enabled), or (b) add a Redis-backed outbox pattern for critical events.

---

### F-02 [H] No Job Overlap Guard — Concurrent Runs Cause Duplicates

**Evidence:** All four `setInterval`-based jobs lack an `isRunning` guard:
- `abandoned-cart-checker.ts:84` — `setInterval(() => { void checkAbandonedCarts()... }, 15min)`
- `no-show-checker.ts:85` — `setInterval(() => { void checkNoShows()... }, 5min)`
- `review-prompt-poller.ts:65` — `setInterval(() => { void pollReviewPrompts()... }, 5min)`

None of these check whether the previous invocation is still running. The pattern is:
```
setInterval(() => {
  void someAsyncFunction().catch(...)
}, INTERVAL_MS)
```

**Blast Radius:**
- **abandoned-cart-checker:** If SSCAN over a large `active:carts` set takes >15min, two concurrent runs process the same carts. The `sRem` after publish is not atomic with publish — race window exists where both runs publish `cart.abandoned` for the same cart, sending duplicate WhatsApp messages.
- **no-show-checker:** If `svc.transition()` is slow, two runs could call `transition(id, "no_show")` for the same reservation. The domain layer likely throws on double-transition, but `publishNatsEvent` may fire twice.
- **review-prompt-poller:** The Redis `zRem` + `del` pipeline after publish is not atomic with the publish itself. Two concurrent runs could both read the same sorted set entries before either removes them.

**Time to Failure:** Under normal load, unlikely (job execution is <1s). Under degraded conditions (slow Redis, slow DB), overlap becomes possible.

**Production Simulation:**
1. Redis latency spikes to 30s due to background save
2. `checkAbandonedCarts()` SSCAN takes 16min (>15min interval)
3. Second invocation starts, SSCAN reads same members
4. Both publish `cart.abandoned` for same carts → duplicate WhatsApp nudges

**Mitigation:** Add `let isRunning = false` guard at the top of each job function. Return early if `isRunning === true`. Set to `false` in finally block.

---

### F-03 [H] Abandoned Cart Checker Assumes All Sessions Are Guest (48h TTL)

**Evidence:** `apps/api/src/jobs/abandoned-cart-checker.ts:43`:
```typescript
const GUEST_TTL = 48 * 60 * 60;
const remainingMs = ttl * 1000;
const lastActivityAgoMs = GUEST_TTL * 1000 - remainingMs;
```

The idle-time calculation uses a hardcoded 48h TTL. But authenticated sessions use 24h TTL (per redis-auditor cross-finding).

**Blast Radius:** For an authenticated session with 24h TTL:
- Session created at T=0, TTL=24h remaining
- At T=1h: actual idle = 1h. TTL remaining = 23h. Calculated idle = `48h - 23h = 25h` > 2h threshold.
- Result: session flagged as "idle for 25h" when it's actually been idle for 1h.
- `cart.abandoned` event fires incorrectly → spurious WhatsApp nudge sent to active customer.

**Time to Failure:** Immediately for any authenticated customer who adds items to cart. Every authenticated session in `active:carts` will be incorrectly flagged as abandoned on the first checker run.

**Production Simulation:**
1. Authenticated customer logs in (session TTL = 24h)
2. Customer adds item to cart → sessionId added to `active:carts`
3. 15 minutes later: abandoned-cart-checker runs
4. TTL remaining = ~23.75h → calculated idle = `48h - 23.75h = 24.25h` → exceeds 2h threshold
5. `cart.abandoned` fires → customer receives "Esqueceu algo no carrinho?" WhatsApp message while still browsing

**Mitigation:** Store the session type (guest/authenticated) alongside the sessionId in `active:carts`, or store the original TTL as metadata. Use the actual TTL for the calculation.

---

### F-04 [H] Nine Dead Events — Published But Never Consumed

**Evidence:** See Event Inventory above. These events are published (with `await` or `void`) but have zero NATS subscribers:

| Dead Event | Publisher | Concern |
|---|---|---|
| `cart.item_added` | `add-to-cart.ts:24`, `reorder.ts:53` | Wastes NATS bandwidth |
| `order.refunded` | `stripe-webhook.ts:85` | **Refund intelligence lost** — no profile update, no analytics |
| `order.disputed` | `stripe-webhook.ts:112` | **Dispute intelligence lost** — no alerting |
| `order.canceled` | `stripe-webhook.ts:145` | **Cancellation intelligence lost** |
| `product.indexed` | Multiple commerce subscribers | Informational, low concern |
| `review.submitted` | `submit-review.ts:44` | Review analytics lost |
| `whatsapp.message.received` | `whatsapp-webhook.ts:296` | WhatsApp analytics lost |
| `whatsapp.message.sent` | `whatsapp-webhook.ts:396` | WhatsApp analytics lost |
| `web.*` (33 types) | `analytics.ts:83` | **All frontend analytics events have no consumer** |

**Blast Radius:** The `order.refunded`, `order.disputed`, and `order.canceled` events represent financial operations with no intelligence capture. The 33 `web.*` analytics events are being published to NATS but nothing reads them — the entire frontend analytics pipeline is a no-op.

**Mitigation:** Either add subscribers for events that should drive intelligence/analytics, or stop publishing dead events to avoid confusion and wasted resources.

---

### F-05 [M] NATS Connection Singleton Race Condition in `finally` Block

**Evidence:** `packages/nats-client/src/index.ts:65-71`:
```typescript
try {
  natsConn = await pendingConnection
  // ... (omitted)
  return natsConn
} catch (error) {
  pendingConnection = null
  throw error
} finally {
  pendingConnection = null  // ← THIS
}
```

The `finally` block sets `pendingConnection = null` even on success. This is correct for the singleton pattern (since `natsConn` is now set), BUT creates a subtle issue: between `natsConn` being set at line 35 and `pendingConnection` being nulled at line 70, if the connection drops immediately (before status monitor starts), the connection object may be stale.

**Blast Radius:** Low in practice. The `reconnect: true` option handles transient disconnects. The race window is nanoseconds.

**Mitigation:** None needed — the current code is functionally correct. The `finally` cleanup is actually the right approach.

---

### F-06 [M] Graceful Shutdown Does Not Drain NATS Connection

**Evidence:** `apps/api/src/index.ts:34-41`:
```typescript
const shutdown = async (): Promise<void> => {
  stopNoShowChecker();
  stopReviewPromptPoller();
  stopAbandonedCartChecker();
  await closeNatsConnection();
  await server.close();
  process.exit(0);
};
```

And `packages/nats-client/src/index.ts:129-135`:
```typescript
export async function closeNatsConnection(): Promise<void> {
  if (natsConn) {
    await natsConn.close()  // ← close(), not drain()
    natsConn = null
    pendingConnection = null
  }
}
```

NATS best practice is `drain()` before `close()`. `drain()` flushes pending publishes and gracefully unsubscribes. `close()` immediately disconnects — any pending publishes in the NATS client buffer are lost.

**Blast Radius:** Events published in the last milliseconds before shutdown may be lost. Combined with F-01 (no JetStream), this means events published by the final job tick are not guaranteed to reach subscribers.

**Mitigation:** Change `closeNatsConnection()` to call `natsConn.drain()` instead of `natsConn.close()`. `drain()` returns a promise that resolves when all pending messages are flushed and subscriptions are drained.

---

### F-07 [M] Startup Subscriber Registration Race

**Evidence:** `apps/api/src/index.ts:46-56`:
```typescript
await server.listen({ port: PORT, host: "0.0.0.0" });
// ...
startNoShowChecker();              // publishes reservation.no_show immediately (line 83)
startReviewPromptPoller(server.log); // publishes review.prompt immediately (line 71)
startAbandonedCartChecker(server.log);
await startCartIntelligenceSubscribers(server.log);  // ← subscribers registered LAST
```

Jobs are started BEFORE subscribers are registered. Both `startNoShowChecker` and `startReviewPromptPoller` run their check functions immediately on startup (fire-and-forget). If the initial check publishes an event before `startCartIntelligenceSubscribers` completes, that event has no subscriber and is lost.

**Time to Failure:** On every server restart, if there are pending no-show reservations or review prompts. The race window is the time to register ~12 NATS subscriptions (typically <100ms), but the initial job checks also involve Redis/DB queries, so the window depends on which completes first.

**Production Simulation:**
1. API server restarts
2. `startNoShowChecker()` runs `checkNoShows()` immediately
3. DB query returns 3 no-show candidates
4. `publishNatsEvent("reservation.no_show", ...)` fires for all 3
5. `startCartIntelligenceSubscribers` is still awaiting NATS connection
6. Events arrive at NATS Core with no subscriber → lost

**Mitigation:** Register subscribers BEFORE starting jobs:
```typescript
await startCartIntelligenceSubscribers(server.log);
startNoShowChecker();
startReviewPromptPoller(server.log);
startAbandonedCartChecker(server.log);
```

---

### F-08 [M] `order.placed` Published From Two Sources With Different Schemas

**Evidence:**
1. `apps/api/src/routes/stripe-webhook.ts:52`:
```typescript
await publishNatsEvent("order.placed", {
  eventType: "order.placed",
  orderId,
  customerId: result.customerId,
  items: result.items,                    // ← includes items array
  stripePaymentIntentId: paymentIntent.id,
});
```

2. `packages/tools/src/cart/create-checkout.ts:108`:
```typescript
void publishNatsEvent("order.placed", {
  eventType: "order.placed",
  orderId,
  paymentMethod: "cash",
  customerId: ctx.customerId,
  // ← NO items array
});
```

The subscriber at `cart-intelligence.ts:101` destructures `items` from the payload and uses it for copurchase scores, global scores, and `recordOrderItems`. When the cash checkout path publishes without `items`, the subscriber receives `undefined` for items, which will cause `items.map(...)` to throw.

**Blast Radius:** Cash orders break the order.placed intelligence handler. `items.map()` on undefined throws TypeError, caught by the try/catch but intelligence is lost.

**Production Simulation:**
1. Customer pays cash → `create-checkout.ts` publishes `order.placed` without `items`
2. `cart-intelligence.ts` receives event, destructures `items` as `undefined`
3. `items.map(i => i.productId)` at line 132 throws TypeError
4. Caught by try/catch — copurchase scores, global scores, profile update all skipped

**Mitigation:** Include `items` in the cash checkout `order.placed` event, or add defensive check in subscriber: `if (!items?.length) return`.

---

### F-09 [L] NATS Subject Naming Convention — All Callers Compliant

**Evidence:** Grep of all `publishNatsEvent` calls shows every caller passes the short form (e.g., `"cart.abandoned"`, `"order.placed"`). No caller passes the full `"ibatexas."` prefix.

**Verdict:** Invariant #5 is satisfied. No finding.

---

### F-10 [M] Search Results Publish O(n) product.viewed Events Per Query

**Evidence:** `packages/tools/src/search/search-products.ts:503-526` — `publishViewedEvents()` fires one `publishNatsEvent("product.viewed", ...)` per product in results via `Promise.all`. With `limit` up to 100, a single search call generates up to 100 NATS publishes.

The subscriber at `cart-intelligence.ts:178-205` handles each event with:
1. Redis `SET NX` for 60s debounce (per customer+product) — 1 Redis roundtrip
2. If not debounced: Redis pipeline (LPUSH + LTRIM + HSET) + `resetProfileTtl` — 2 more roundtrips

For a search returning 100 unique products: 100 NATS messages → 100 Redis SET NX calls → up to 100 pipeline executions. The debounce only deduplicates repeated views of the *same product within 60s*, not distinct products from a single search.

**Blast Radius:** Under normal load this is fine — NATS Core and Redis handle the throughput. Under burst conditions (multiple concurrent users searching), the subscriber processes events sequentially (NATS `for await` loop in `subscribeNatsEvent`), creating backpressure. With 10 concurrent searches returning 50 products each, that's 500 events queued in the single subscriber's async iterator, each doing 1-3 Redis roundtrips.

**Mitigation:** Consider publishing a single `search.results_viewed` batch event with all productIds instead of N individual events. The subscriber can then batch the Redis operations into a single pipeline.

---

### F-11 [L] Medusa Subscribers Have No Retry on Typesense Failure

**Evidence:** All Medusa product subscribers (`product-created.ts`, `product-updated.ts`, `product-deleted.ts`, `price-updated.ts`, `variant-updated.ts`) catch errors and log them but do not retry:
```typescript
} catch (error) {
  logger.error(`[Product Indexing] handler failed for ${data.id}:`, ...)
}
```

**Blast Radius:** If Typesense is down during a product update, the search index becomes stale. Products may show wrong prices or appear deleted until the next manual re-index.

**Mitigation:** Acceptable for now if manual re-index is available. For production, consider a retry queue or periodic full re-index job.

---

## Cross-Agent Findings

### From whatsapp-auditor
- NATS `publishNatsEvent` calls in `whatsapp-webhook.ts:296,396` use `void` + `.catch(() => {})` pattern — fire-and-forget with swallowed errors. Combined with F-01 (no durability), WhatsApp analytics events are doubly unreliable.

### From redis-auditor
- `active:carts` SET has no TTL — members accumulate indefinitely if the abandoned-cart-checker stops running. Members are only cleaned up during checker runs.
- Confirmed: authenticated sessions use 24h TTL, not 48h. This directly causes F-03.

### From data-layer-auditor
- Reservation system `transition()` may throw on double-transition. This is actually a **safeguard** against F-02 (job overlap) — if two concurrent no-show-checker runs try to transition the same reservation, the second call throws, preventing a duplicate NATS event. However, this is accidental protection, not intentional.
- **TOCTOU race in reservation creation** (`packages/domain/src/services/reservation.service.ts:225-263`): Two concurrent reservation requests for the last available slot can both succeed, each publishing a `reservation.created` NATS event with valid-looking data. Downstream consumers (profile counter increment, WhatsApp confirmation) process both as legitimate — resulting in double-counted `reservationCount` in the customer profile and two confirmation messages sent. The event layer has no way to detect or deduplicate these since both events are semantically valid at publish time.

---

## Invariant Verification

| Invariant | Status | Notes |
|---|---|---|
| 1. No event published without subscriber | **VIOLATED** | 9+ dead events (F-04) |
| 2. Background jobs never overlap | **VIOLATED** | No overlap guard (F-02) |
| 3. Job failures never crash server | **PASSED** | All jobs use `.catch()` and try/catch |
| 4. Events during deployment not lost | **VIOLATED** | NATS Core = fire-and-forget (F-01) |
| 5. NATS subjects use short-form naming | **PASSED** | All callers compliant (F-09) |
