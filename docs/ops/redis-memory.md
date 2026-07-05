# Redis Key Patterns & TTLs

All keys are namespaced with `${APP_ENV}:` via the `rk()` helper from `@ibatexas/tools`
(CLAUDE.md rule #7 — never build raw key strings inline).
Example: `production:customer:profile:cust_123`

> This inventory is regenerated from a grep of all `rk()` calls in `apps/` + `packages/`
> (excluding tests and `node_modules`). Code is the source of truth.

---

## Sessions & chat

| Pattern | Type | TTL | Description | Source |
|---------|------|-----|-------------|--------|
| `session:{sessionId}` | List | 24–48 h | Chat conversation history (guest 48 h, authenticated 24 h). Each `appendMessages()` publishes `conversation.message.appended` to NATS for durable Postgres archival (CDC). | `apps/api/src/session/store.ts` |
| `session:lastActivity:{sessionId}` | String | 24 h | Last-activity timestamp used by the chat single-flight guard. | `apps/api/src/routes/chat.ts` |
| `session:owner:{sessionId}` | String | 24 h | Maps chat session to owning customerId (ownership guard for SSE streaming). | `apps/api/src/routes/chat.ts` |
| `session:secret:{sessionId}` | String (UUID) | 1 h | Guest session secret (prevents session hijacking). | `apps/api/src/routes/chat.ts` |
| `claustrum:session:{sessionId}` | String (JSON) | 24 h (customer) / 48 h (guest) | Claustrum Conductor per-session memory. Distinct namespace from `session:*` (the history list). | `apps/api/src/claustrum-bootstrap.ts` |
| `chat:stream:{sessionId}` | Stream | — | SSE stream channel for web chat token delivery. | `apps/api/src/streaming/emitter.ts` |
| `chat:stream:replay:{sessionId}` | Stream | — | Replay buffer for reconnecting SSE clients. | `apps/api/src/streaming/emitter.ts` |
| `web:agent:{sessionId}` | String (UUID) | 30 s | Web chat agent lock — UUID value, Lua conditional release, 10 s heartbeat. | `apps/api/src/streaming/execution-queue.ts` |
| `llm:tokens:{channel}:{customerId}` | String (counter) | configurable | LLM token-usage counter per channel+customer (prevents runaway token spend). Pattern also queried by `ibx rate`. | `apps/api/src/claustrum/resolve-and-assemble.ts` |

---

## WhatsApp

| Pattern | Type | TTL | Description | Source |
|---------|------|-----|-------------|--------|
| `wa:phone:{phoneHash}` | Hash | 24 h | WhatsApp session — phone, sessionId, customerId, lastMessageAt, state. | `apps/api/src/whatsapp/session.ts` |
| `wa:rate:{phoneHash}` | String | 60 s | Inbound WhatsApp rate limit counter (max 20/min). | `apps/api/src/routes/whatsapp-webhook.ts` |
| `wa:send:rate:{from}` | String | — | Outbound send token-bucket (Lua refill+consume, atomic). | `apps/api/src/whatsapp/client.ts` |
| `wa:webhook:{MessageSid}` | String | 24 h | WhatsApp webhook idempotency (prevents Twilio retry reprocessing). | `apps/api/src/routes/whatsapp-webhook.ts` |
| `wa:dedup:{phoneHash}` | String | 5 min | Inbound message dedup (covers WhatsApp ~60 s retries). | `apps/api/src/whatsapp/session.ts` |
| `wa:debounce:{phoneHash}` | String | 2 s | Message debounce (batches rapid-fire messages). | `apps/api/src/whatsapp/session.ts` |
| `wa:agent:{phoneHash}` | String (UUID) | 30 s | WhatsApp agent lock — UUID value, Lua conditional release, 10 s heartbeat. | `apps/api/src/whatsapp/session.ts` |
| `wa:optin:{phoneHash}` | String | none (residual — should add 365 d TTL) | LGPD opt-in consent marker — set on first WhatsApp contact after disclosure. | `apps/api/src/whatsapp/session.ts` |
| `wa:nudge:replied:{phoneHash}` | String | 120 s | Set on any incoming message; checked by hesitation-nudge job — if present, nudge is skipped. | `apps/api/src/jobs/hesitation-nudge.ts` |
| `ratelimit:customer:create` | String | configurable | Rate limit for customer creation via WhatsApp (prevents abuse). | `apps/api/src/whatsapp/session.ts` |
| `welcome:credit:{customerId}` | String | 30 d | Welcome credit code, applied once via atomic `GETDEL`. | `apps/api/src/whatsapp/session.ts`, `packages/tools/src/intelligence/welcome-credit.ts` |

---

## Carts & checkout

| Pattern | Type | TTL | Description | Source |
|---------|------|-----|-------------|--------|
| `active:carts` | Hash | 48 h | Active cart IDs with metadata `{cartId, sessionType, lastActivity}`, polled by the abandoned-cart checker. | `apps/api/src/routes/cart.ts` |
| `cart:active:session:{sessionId}` | String | — | Session → active cartId mapping. | `packages/tools/src/cart/get-or-create-cart.ts` |
| `cart:create:lock:{sessionId}` | String | 10 s | Cart creation lock (prevents TOCTOU double-create race). | `packages/tools/src/cart/get-or-create-cart.ts` |
| `cart:owner:{cartId}` | String | 24 h | Cart ownership mapping (IDOR prevention). | `apps/api/src/routes/cart.ts` |
| `cart:nudge:{cartId}` | String (JSON) | 48 h | Recovery tier sent for an abandoned cart `{tier, sentAt}`. | `apps/api/src/subscribers/cart-intelligence.ts` |
| `checkout:idem:{idemToken}` | String | 120 s | Checkout single-flight gate (NX) — blocks concurrent/duplicate checkout submits. | `apps/api/src/routes/cart.ts` |
| `checkout:confirmation:{confirmationId}` | String (JSON) | 10 min | Customer checkout-confirmation receipt, drained atomically on consume. | `apps/api/src/routes/checkout-confirmation-store.ts` |
| `customer:pending-orders:{customerId}` | Hash | 7 d | In-flight payment intents per customer, keyed by paymentIntentId. | `packages/tools/src/cart/create-checkout.ts` |

---

## Payments

| Pattern | Type | TTL | Description | Source |
|---------|------|-----|-------------|--------|
| `customer:pix:{customerId}` | Hash | — | Cached PIX billing details (name, email, cpf). Pre-filled on returning customer sessions. | `apps/api/src/routes/cart.ts` |
| `pix:regen:rate:{customerId}` | Counter | 3600 s | PIX regeneration rate limit (max 3/hr via INCR + EXPIRE). | `packages/tools/src/cart/regenerate-pix.ts` |
| `pix:paid:{orderId}` | String | 2 h | Idempotency guard — PIX marked paid by the expiry monitor. | `apps/api/src/jobs/pix-expiry-monitor.ts` |
| `pix:reminder-sent:{orderId}:{stage}` | String | — | PIX-pending reminder idempotency per stage. | `apps/api/src/jobs/pix-expiry-monitor.ts` |
| `lock:payment:{paymentId}` | String (UUID) | 10 s | Distributed lock for payment mutations (webhook, PIX expiry, method switch). Lua conditional `DEL`. | `packages/tools/src/redis/distributed-lock.ts` |
| `stripe:circuit:{method}` | Counter | 300 s | Stripe circuit breaker per method (INCR on failure, open if >5 in window). | `packages/tools/src/cart/_stripe-helpers.ts` |
| `webhook:processed:{event.id}` | String | 7 d | Stripe webhook idempotency guard (prevents replay reprocessing). | `apps/api/src/routes/stripe-webhook.ts` |
| `refund:daily-total:{staffId}:{YYYY-MM-DD}` | Counter | 25 h | Per-staff-day refund total enforcing the daily refund cap. 25 h TTL covers DST + clock skew. | `apps/api/src/routes/admin/payments.ts` |

---

## Auth & rate limits

| Pattern | Type | TTL | Description | Source |
|---------|------|-----|-------------|--------|
| `otp:ip:{ip}` | String | 1 h | OTP send rate limit per IP (max 10/hour). | `apps/api/src/routes/auth.ts` |
| `otp:rate:{phoneHash}` | String | 10 min | OTP send rate limit (max 3 per phone per 10 min). | `apps/api/src/routes/auth.ts` |
| `otp:fail:{phoneHash}` | String | 1 h | OTP brute-force counter (locks after 5 failures/hour). | `apps/api/src/routes/auth.ts` |
| `jwt:revoked:{jti}` | String | remaining JWT lifetime | JWT revocation marker (set on logout, checked on every authenticated request). | `apps/api/src/routes/auth.ts`, `apps/api/src/middleware/auth.ts` |
| `refresh:{token}` | String (JSON) | 30 d | Refresh token payload `{customerId, issuedAt}` — single-use, deleted on consume (rotation) or logout. | `apps/api/src/routes/auth.ts` |
| `rate:amend:{customerId}` | String (counter) | 600 s | Rate limit for order amendments — max 5 per 10 min. | `apps/api/src/routes/me.ts` |
| `rate:cancel:{customerId}` | String (counter) | 600 s | Rate limit for order cancellations — max 5 per 10 min. | `apps/api/src/routes/me.ts` |
| `analytics:rate:{ip}` | String | 60 s | Analytics endpoint rate limit (max 100 events/min per IP). | `apps/api/src/routes/analytics.ts` |

---

## LGPD anonymize

The LGPD anonymize flow (`/api/me/data/*`) is the most destructive customer-driven
operation; these keys gate it. See `apps/api/src/routes/me/anonymize-otp-gate.ts` for the
full state machine. Anonymize is irreversible, so the OTP window (5 min) is tighter than login (10 min).

| Pattern | Type | TTL | Description | Source |
|---------|------|-----|-------------|--------|
| `anonymize:otp:{customerId}` | String | 5 min | Fresh OTP sent marker. | `apps/api/src/routes/me/anonymize-otp-gate.ts` |
| `anonymize:otp_verified:{customerId}` | String | 60 s | Short freshness window — initiate-deletion requires this. | `apps/api/src/routes/me/anonymize-otp-gate.ts` |
| `anonymize:fail:{customerId}` | Counter | 30 min | OTP brute-force counter; 5 → lockout. | `apps/api/src/routes/me/anonymize-otp-gate.ts` |
| `anonymize:lockout:{customerId}` | String | 30 min | Lockout flag set when the fail counter crosses threshold. | `apps/api/src/routes/me/anonymize-otp-gate.ts` |
| `anonymize:cancel-cooldown:{customerId}` | String | 30 min | Set on cancel-deletion — blocks re-initiate (kills the harassment loop). | `apps/api/src/routes/me/anonymize-otp-gate.ts` |
| `anonymize:pending:{customerId}` | String (JSON) | 24 h | Parked deletion receipt during the cancel grace window. | `packages/pack-customer-onboarding/src/signals.ts`, `apps/api/src/routes/me.ts` |
| `anonymize:active:{customerId}` | String (UUID) | 60 s | Mutex over the anonymize Prisma TX — Lua conditional release. | `apps/api/src/routes/me/anonymize-active-lock.ts` |
| `anonymize:medusa:pending:{customerId}` | Hash | 7 d | Per-customer Medusa anonymize retry queue. | `packages/tools/src/medusa/anonymize-pending.ts` |
| `anonymize:medusa:pending:index` | Set | — | Index of customerIds with a pending Medusa anonymize, swept by the retry job. | `packages/tools/src/medusa/anonymize-pending.ts` |
| `lock:anonymize-medusa-retry` | String (UUID) | 270 s | Distributed lock for the Medusa anonymize retry job. | `apps/api/src/jobs/anonymize-medusa-retry.ts` |

---

## Kernel defer (parked intents)

The kernel DEFER mechanism parks intents that cannot execute yet (e.g. PIX-pending) and
resumes them on a signal. Implemented in `@adjudicate/runtime`, driven by IbateXas adapters/subscribers.

| Pattern | Type | TTL | Description | Source |
|---------|------|-----|-------------|--------|
| `defer:pending:{sessionId}` | String (JSON) | 14 d (grace) | Parked intent receipt awaiting resume. | `apps/api/src/subscribers/defer-resolver.ts`, `apps/api/src/adapters/park-nx.ts` |
| `defer:cycle:{intentHash}` | Counter | 14 d (grace) | Resume-cycle guard preventing infinite re-park loops. | `apps/api/src/subscribers/defer-resolver.ts` |
| `defer:resumed:{deferResumeHash}` | String | 60 s | Short idempotency marker — a resume fires at most once. | `apps/api/src/subscribers/defer-resolver.ts` |
| `defer:count:{sessionId}` | Counter | — | Live count of parked intents per session (quota). | `apps/api/src/subscribers/defer-resolver.ts` |
| `heartbeat:defer-sweeper` | String | 2× sweep interval | Liveness heartbeat for the defer-timeout sweeper job. | `apps/api/src/jobs/defer-timeout-sweeper.ts` |

---

## Admin

| Pattern | Type | TTL | Description | Source |
|---------|------|-----|-------------|--------|
| `admin:confirmation:{confirmationId}` | String (JSON) | 10 min | Two-step admin confirmation receipt, consumed atomically via Lua. | `apps/api/src/routes/admin/admin-confirmation-store.ts` |
| `order:status:dedup:{requestId}` | String | 300 s | Admin order PATCH request-ID dedup (catches double-clicks). | `apps/api/src/routes/admin/orders.ts` |
| `product:update:dedup:{requestId}` | String | 300 s | Admin product PATCH request-ID dedup. | `apps/api/src/routes/admin/products.ts` |
| `dz:{action}:dedup:{requestId}` | String | 300 s | Admin delivery-zone mutation dedup (create/update/delete). | `apps/api/src/routes/admin/delivery-zones.ts` |

---

## Escalations & take-over

| Pattern | Type | TTL | Description | Source |
|---------|------|-----|-------------|--------|
| `escalation:rec:{sessionId}` | String (JSON) | — | Escalation record: open/resolved lifecycle + bot-pause + the AUT-017 `pendingIntents` projection (parked money intents awaiting OWNER approval). | `apps/api/src/escalation/escalation-store.ts` |
| `escalation:open` | Set | — | Index of sessionIds with an OPEN escalation (self-healing on read). | `apps/api/src/escalation/escalation-store.ts` |
| `escalation:park:{token}` | String (JSON) | 24 h (`ESCALATION_PARK_TTL_SECONDS`) | **AUT-017** — the FULL parked envelope (rebuild inputs) for an escalated, resumable money intent (today: an above-threshold `payment.refund.issue`). Single-use: consumed atomically via Lua GET+DEL when an OWNER approves; the resume rebuilds the identical `intentHash` and re-adjudicates through the audited kernel. | `apps/api/src/escalation/escalation-park-store.ts` |

---

## NATS, jobs & DLQ

| Pattern | Type | TTL | Description | Source |
|---------|------|-----|-------------|--------|
| `nats:processed:{eventKey}` | String | 7 d | NATS event idempotency guard (prevents duplicate subscriber processing). Shared via `isNewEvent()`. | `apps/api/src/subscribers/dedup.ts` |
| `dlq:{eventType}` | List | 7 d | Dead-letter queue for non-retryable subscriber failures (full payload + `_failedAt` + `_error`). Inspect with `ibx dlq list` / `ibx dlq peek <event>`. | `apps/api/src/subscribers/dlq.ts` |
| `lock:outbox-retry` | String (UUID) | 55 s | Distributed lock for the outbox retry job. Lua conditional `DEL`. | `apps/api/src/jobs/outbox-retry.ts` |
| `review:prompt:{customerId}:{orderId}` | String | 24 h | Idempotency marker for review-prompt scheduling. | `apps/api/src/jobs/review-prompt.ts` |
| `review:prompt:scheduled` | Sorted Set | 1 d | Due review prompts (score = fire timestamp), polled every 5 min. | `apps/api/src/jobs/review-prompt.ts` |
| `reminder:sent:{reservationId}` | String | 24 h | Reservation reminder idempotency guard. | `apps/api/src/jobs/reservation-reminder.ts` |
| `follow-up:scheduled` | Sorted Set | per-entry (via score) | Scheduled follow-up reminders, polled every 15 min. | `packages/tools/src/intelligence/schedule-follow-up.ts` |
| `outreach:last:{customerId}` | String | 3–7 d | Cooldown preventing repeated outreach to the same customer. | `apps/api/src/jobs/proactive-engagement.ts` |
| `outreach:weekly:count` | String (counter) | 7 d | Weekly outreach message counter for the admin dashboard. | `apps/api/src/jobs/proactive-engagement.ts` |

---

## Intelligence (co-purchase, scores, reviews)

| Pattern | Type | TTL | Description | Source |
|---------|------|-----|-------------|--------|
| `customer:profile:{customerId}` | Hash | 30 d | Cached customer profile — orderCount, favoriteTags, lastSeenAt, scores. | `apps/api/src/subscribers/cart-intelligence.ts` |
| `customer:recentlyViewed:{customerId}` | List | 7 d | Last 20 product IDs viewed (LPUSH + LTRIM). | `apps/api/src/subscribers/cart-intelligence.ts` |
| `copurchase:{productId}` | Sorted Set | 30 d | Products bought together (score = co-purchase count, capped at 50 entries). | `apps/api/src/subscribers/cart-intelligence.ts` |
| `product:global:score` | Sorted Set | 30 d | Global product popularity by total units ordered. | `apps/api/src/subscribers/cart-intelligence.ts` |
| `product:cart:popularity` | Sorted Set | 30 d | Add-to-cart frequency per product (score = total quantity added). | `apps/api/src/subscribers/cart-intelligence.ts` |
| `product:reviews:{productId}` | Hash | 30 d | Review analytics: `avgRating`, `reviewCount`, `lastReviewAt`. | `apps/api/src/subscribers/cart-intelligence.ts` |
| `alert:staff:hourly` | String (counter) | 1 h | Staff high-value cart alert rate limiter (max 10/hour). | `apps/api/src/subscribers/cart-intelligence.ts` |

---

## Search & embeddings cache

| Pattern | Type | TTL | Description | Source |
|---------|------|-----|-------------|--------|
| `search_exact:{channel}:{hash}` | String (JSON) | 5 min | L0 exact query result cache (sha256 of normalized query + filters). | `packages/tools/src/cache/query-cache.ts` |
| `search_cache:{channel}:{bucket}:...` | String (JSON) | 1 h | L1 semantic bucket cache (djb2 of quantized embedding + filters). | `packages/tools/src/cache/query-cache.ts` |
| `query_log:{timestamp}:{sessionId}:{hash}` | String (JSON) | 7 d | Query log entries for analytics. | `packages/tools/src/cache/query-cache.ts` |
| `embedding:{key}` | String | configurable | Generic cached embedding vector (batch embed helper). | `packages/tools/src/embeddings/client.ts` |
| `embedding:query:{base64}` | String | 30 d | Cached query embedding vector for semantic search. | `packages/tools/src/search/search-products.ts` |
| `product_embedding:{productId}` | String | configurable | Cached product embedding for Typesense indexing. | `packages/tools/src/typesense/index-product.ts` |
| `cache:stats:l0:hit` / `:l0:miss` | Counter | 30 d | L0 exact cache hit/miss counters. | `packages/tools/src/cache/query-cache.ts` |
| `cache:stats:l1:hit` / `:l1:miss` | Counter | 30 d | L1 semantic cache hit/miss counters. | `packages/tools/src/cache/query-cache.ts` |
| `cache:stats:embed:hit` / `:embed:miss` | Counter | 30 d | Embedding cache hit/miss counters (read by `getCacheStats()`). | `packages/tools/src/cache/query-cache.ts` |

---

## Metrics & general caches

| Pattern | Type | TTL | Description | Source |
|---------|------|-----|-------------|--------|
| `metrics:conversations:daily:{date}` | String (counter) | 48 h | Daily WhatsApp conversation count (new sessions). | `apps/api/src/routes/whatsapp-webhook.ts` |
| `metrics:wa_orders:daily:{date}` | String (counter) | 48 h | Daily WhatsApp order count. | `apps/api/src/subscribers/cart-intelligence.ts` |
| `metrics:messages:{sessionId}` | String (counter) | 48 h | Message count per WhatsApp session. | `apps/api/src/routes/whatsapp-webhook.ts` |
| `metrics:avg_messages_to_checkout` | String (number) | none | EMA of messages-to-checkout (0.9 old + 0.1 new). | `apps/api/src/subscribers/cart-intelligence.ts` |
| `restaurant:schedule` | String (JSON) | none | Cached weekly schedule + holidays. Invalidated on every admin write. | `packages/tools/src/cache/schedule-cache.ts` |
| `site:banner:text` | String | none | Site banner text. Lives until overwritten or cleared. | `packages/tools/src/cache/banner-cache.ts` |
| `weather:current` | String (JSON) | 1 h | Cached current weather. | `apps/api/src/jobs/weather-helper.ts` |
| `delivery:cep:{cep}` | String (JSON) | 1 h (`DELIVERY_CACHE_TTL`) | Cached delivery estimate per CEP. | `packages/tools/src/catalog/estimate-delivery.ts` |
| `trace:{traceId}` | String (JSON) | 1 h (`TRACE_TTL_SECONDS`) | Per-turn execution trace for debugging. | `packages/tools/src/tracing/trace.ts` |
| `replay:{traceId}` | String (JSON) | 24 h (`REPLAY_TTL_SECONDS`) | Stored turn for post-mortem replay analysis. | `packages/tools/src/replay/store.ts` |
| `audit:spill:queue` | List | 7 d | Spill buffer for kernel audit records when the primary sink is unavailable (RPUSH on append, EXPIRE reset each push). | `packages/audit-sink/src/redis-spill-storage.ts` |

---

## Removed / renamed (do not reintroduce)

- `packages/llm-provider/*` keys — the legacy XState brain (`@ibatexas/llm-provider`) was deleted in the claustrum cutover. `customer:pix` now lives in `apps/api/src/routes/cart.ts`; `llm:tokens` moved to `apps/api/src/claustrum/resolve-and-assemble.ts` with the new `llm:tokens:{channel}:{customerId}` shape.
- `wa:machine:{sessionId}` — XState snapshot persistence is gone. Only a dead-code comment survives (`apps/api/src/whatsapp/session.ts`) plus a CLI flush sweep that GCs any stale keys (`packages/cli/src/commands/chat.ts`). Not written by any live path.
- `retry:{paymentId}:{ts}` / `switch:{orderId}:{requestId}` — referenced a non-existent `apps/api/src/routes/orders.ts`; no such keys exist.
- `cart:session:{cartId}` — carts are tracked via `active:carts` + `session:{sessionId}`.
- `query:exact:*` / `query:dynamic:*` / `query:static:*` — superseded by `search_exact:*` / `search_cache:*`.

---

## Abandoned Cart Detection

The `abandoned-cart-checker` job runs every 15 min and:
1. `HSCAN`s the `active:carts` hash (never `KEYS *`).
2. Each field stores `{cartId, sessionType, lastActivity}` JSON.
3. Compares `lastActivity` against the idle threshold (2 h).
4. If idle, publishes a `cart.abandoned` NATS event.
5. Removes the cart ID from `active:carts`.

The `active:carts` hash has a 48 h TTL refreshed on each `trackCartId()` call.

---

## Co-Purchase Intelligence

Co-purchase sorted sets are built from `CustomerOrderItem` history:

- **Key**: `{env}:copurchase:{productId}`
- **Members**: other product IDs bought in the same order
- **Score**: number of times bought together (set capped at 50 entries via `zRemRangeByRank`)
- **TTL**: 30 days (refreshed on each order)

Keys auto-purge when a product is deleted via the `product.intelligence.purge` NATS event:
the subscriber removes the product's own set and SCANs to remove it from all other sets.

Rebuild after data import or score corruption:
```bash
ibx intel copurchase-reset            # delete all keys
ibx intel copurchase-rebuild          # rebuild from DB
ibx intel scores-inspect {productId}  # inspect a product
```

---

## Global Score

- **Key**: `{env}:product:global:score`
- **Members**: product IDs
- **Score**: total units ordered across all time
- **TTL**: 30 days (refreshed on each order)

Rebuild after bulk imports:
```bash
ibx intel global-score-rebuild --reset
```

---

## Memory Management Tips

- Redis `maxmemory` policy should be `allkeys-lru` in production.
- The 30-day caches (embedding, customer profiles, co-purchase/score sorted sets) dominate memory — monitor with `ibx svc health redis`.
- `APP_ENV` prefix isolates multi-tenant / staging keys (no bleed).
- Agent locks and payment/anonymize mutexes use UUID values with Lua conditional release — no cascading lock breaches.
- `welcome:credit:{customerId}` uses atomic `GETDEL` to prevent double-apply.
- Metrics counters use the `atomicIncr()` Lua script — no immortal keys from INCR/EXPIRE races.
- All keys have TTLs except a small set of intentional caches/markers: `wa:optin:*` (residual — should be 365 d), `restaurant:schedule`, `site:banner:text`, and single keys like `metrics:avg_messages_to_checkout`.

---

## Monitoring Commands

```bash
ibx svc health redis              # ping + memory info
redis-cli -u $REDIS_URL info memory
redis-cli -u $REDIS_URL dbsize
redis-cli -u $REDIS_URL --scan --pattern "production:copurchase:*" | wc -l
```
