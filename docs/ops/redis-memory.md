# Redis Key Patterns & TTLs

<!-- AUDIT-FIX: REDIS-M02 — regenerated from grep of all rk() calls in the codebase -->

All keys are namespaced with `${APP_ENV}:` via the `rk()` helper.
Example: `production:customer:profile:cust_123`

---

## Key Inventory

| Pattern | Type | TTL | Description | Source file |
|---------|------|-----|-------------|-------------|
| `session:{sessionId}` | List | 24-48 h | Chat conversation history (guest 48h, authenticated 24h) | `apps/api/src/session/store.ts` |
| `active:carts` | Hash | 48 h | Hash of active cart IDs with metadata `{cartId, sessionType, lastActivity}` polled by abandoned-cart-checker | `apps/api/src/routes/cart.ts` |
| `customer:profile:{customerId}` | Hash | 30 d | Cached customer profile — orderCount, favoriteTags, lastSeenAt, scores | `apps/api/src/subscribers/cart-intelligence.ts` |
| `customer:recentlyViewed:{customerId}` | List | 7 d | Last 20 product IDs viewed (LPUSH + LTRIM) | `apps/api/src/subscribers/cart-intelligence.ts` |
| `copurchase:{productId}` | Sorted Set | 30 d | Products bought together with `productId`, score = co-purchase count | `apps/api/src/subscribers/cart-intelligence.ts` |
| `product:global:score` | Sorted Set | 30 d | Global product popularity by total units ordered | `apps/api/src/subscribers/cart-intelligence.ts` |
| `search_exact:{channel}:{hash}` | String (JSON) | 5 min | L0 exact query result cache (sha256 of normalized query + filters) | `packages/tools/src/cache/query-cache.ts` |
| `search_cache:{channel}:{bucket}:...` | String (JSON) | 1 h | L1 semantic bucket cache (djb2 of quantized embedding + filters) | `packages/tools/src/cache/query-cache.ts` |
| `query_log:{timestamp}:{sessionId}:{hash}` | String (JSON) | 7 d | Query log entries for analytics | `packages/tools/src/cache/query-cache.ts` |
| ~~`product_embedding:{productId}`~~ | — | — | REMOVED — dead embeddings code deleted | — |
| ~~`embedding:{key}`~~ | — | — | REMOVED — dead embeddings code deleted | — |
| `wa:phone:{phoneHash}` | Hash | 24 h | WhatsApp session — phone, sessionId, customerId, lastMessageAt, state | `apps/api/src/whatsapp/session.ts` |
| `wa:rate:{phoneHash}` | String | 60 s | WhatsApp rate limit counter (max 20/min) | `apps/api/src/routes/whatsapp-webhook.ts` |
| `wa:webhook:{MessageSid}` | String | 24 h | WhatsApp webhook idempotency (prevents Twilio retry reprocessing) | `apps/api/src/routes/whatsapp-webhook.ts` |
| `wa:debounce:{phoneHash}` | String | 2 s | WhatsApp message debounce (batches rapid-fire messages) | `apps/api/src/whatsapp/session.ts` |
| `wa:agent:{phoneHash}` | String | 30 s | WhatsApp distributed agent lock (heartbeat extends TTL every 10s) | `apps/api/src/whatsapp/session.ts` |
| `wa:optin:{phoneHash}` | String | none | LGPD opt-in consent marker — set on first WhatsApp contact after disclosure | `apps/api/src/whatsapp/session.ts` |
| `otp:ip:{ip}` | String | 1 h | OTP send rate limit per IP (max 10/hour) | `apps/api/src/routes/auth.ts` |
| `otp:rate:{phoneHash}` | String | 10 min | OTP send rate limit (max 3 per phone per 10 min) | `apps/api/src/routes/auth.ts` |
| `otp:fail:{phoneHash}` | String | 1 h | OTP brute-force counter (locks after 5 failures per hour) | `apps/api/src/routes/auth.ts` |
| `review:prompt:{customerId}:{orderId}` | String | 24 h | Idempotency marker for review prompt scheduling | `apps/api/src/jobs/review-prompt.ts` |
| `review:prompt:scheduled` | Sorted Set | 1 d | Due review prompts (score = fire timestamp), polled every 5 min | `apps/api/src/jobs/review-prompt.ts` |
| `reminder:sent:{reservationId}` | String | 24 h | Reservation reminder idempotency guard (prevents re-sending on restart) | `apps/api/src/jobs/reservation-reminder.ts` |
| `nats:processed:{eventKey}` | String | 7 d | NATS event idempotency guard (prevents duplicate subscriber processing) | `apps/api/src/subscribers/cart-intelligence.ts` |
| `webhook:processed:{event.id}` | String | 7 d | Stripe webhook idempotency guard (prevents replay reprocessing) | `apps/api/src/routes/stripe-webhook.ts` |
| `analytics:rate:{ip}` | String | 60 s | Analytics endpoint rate limit (max 100 events/min per IP) | `apps/api/src/routes/analytics.ts` |
| `jwt:revoked:{jti}` | String | remaining JWT lifetime | JWT revocation marker (set on logout, checked on every authenticated request) | `apps/api/src/routes/auth.ts`, `apps/api/src/middleware/auth.ts` |
| `refresh:{token}` | String (JSON) | 30 d | Refresh token payload `{customerId, issuedAt}` — single-use, deleted on consume (rotation) or logout | `apps/api/src/routes/auth.ts` |
| `product:reviews:{productId}` | Hash | 30 d | Product review analytics: `avgRating`, `reviewCount`, `lastReviewAt` | `apps/api/src/subscribers/cart-intelligence.ts` |
| `product:cart:popularity` | Sorted Set | 30 d | Add-to-cart frequency per product (score = total quantity added) | `apps/api/src/subscribers/cart-intelligence.ts` |
| `cache:stats:l0:hit` | Counter | 30 d | L0 exact cache hit count (INCR on each hit) | `packages/tools/src/cache/query-cache.ts` |
| `cache:stats:l0:miss` | Counter | 30 d | L0 exact cache miss count | `packages/tools/src/cache/query-cache.ts` |
| `cache:stats:l1:hit` | Counter | 30 d | L1 semantic cache hit count | `packages/tools/src/cache/query-cache.ts` |
| `cache:stats:l1:miss` | Counter | 30 d | L1 semantic cache miss count | `packages/tools/src/cache/query-cache.ts` |
| ~~`cache:stats:embed:hit`~~ | — | — | REMOVED — dead embeddings cache deleted | — |
| ~~`cache:stats:embed:miss`~~ | — | — | REMOVED — dead embeddings cache deleted | — |
| `session:owner:{sessionId}` | String | 24 h | Maps chat session to owning customerId (ownership guard for SSE streaming) | `apps/api/src/routes/chat.ts` |
| `llm:tokens:{sessionId}` | String | configurable | LLM token usage counter per session (prevents runaway token spend) | `packages/llm-provider/src/agent.ts` |
| `ratelimit:customer:create` | String | configurable | Rate limit for customer creation via WhatsApp (prevents abuse) | `apps/api/src/whatsapp/session.ts` |
| `embedding:query:{base64}` | String | 30 d | Cached query embedding vector for semantic search | `packages/tools/src/search/search-products.ts` |

**Removed patterns** (documented previously but not found in code):
- `cart:session:{cartId}` — does not exist; carts are tracked via `active:carts` hash + `session:{sessionId}` list
- `delivery:zones:cache` — not found in any `.ts` file
- `query:exact:{hash}` — actual key is `search_exact:{channel}:{hash}`
- `query:dynamic:{hash}` — actual key is `search_cache:{channel}:{bucket}:...`
- `query:static:{hash}` — not found in code

---

## Abandoned Cart Detection

The `abandoned-cart-checker` job runs every 15 minutes and:
1. Uses `HSCAN` to iterate `active:carts` hash (never `KEYS *`)
2. Each hash field stores `{cartId, sessionType, lastActivity}` as JSON
3. Compares `lastActivity` against idle threshold (2h)
4. If idle, publishes `cart.abandoned` NATS event
5. Removes the cart ID from `active:carts`

The `active:carts` hash has a 48h TTL refreshed on each `trackCartId()` call.

---

## Co-Purchase Intelligence

Co-purchase sorted sets are built from `CustomerOrderItem` history:

- **Key**: `{env}:copurchase:{productId}`
- **Members**: other product IDs bought in the same order
- **Score**: number of times bought together
- **TTL**: 30 days (refreshed on each order)

To re-build after data import or score corruption:
```bash
ibx intel copurchase-reset          # delete all keys
ibx intel copurchase-rebuild        # rebuild from DB
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

- Redis maxmemory policy should be `allkeys-lru` in production
- Co-purchase sets now have 30-day TTL (refreshed on each order)
- Embedding cache (30 d TTL) accounts for the most memory; monitor with `ibx svc health redis`
- For multi-tenant / staging isolation, `APP_ENV` prefix prevents key bleed
- All keys now have TTLs — no unbounded growth patterns remain

---

## Monitoring Commands

```bash
ibx svc health redis              # ping + memory info
redis-cli -u $REDIS_URL info memory
redis-cli -u $REDIS_URL dbsize
redis-cli -u $REDIS_URL --scan --pattern "production:copurchase:*" | wc -l
```
