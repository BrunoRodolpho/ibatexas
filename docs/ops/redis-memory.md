# Redis Key Patterns & TTLs

All keys are namespaced with `${APP_ENV}:` via the `rk()` helper.  
Example: `development:cart:session:abc123`

---

## Key Inventory

| Pattern | Type | TTL | Description |
|---------|------|-----|-------------|
| `cart:session:{cartId}` | Hash | 24 h | Active cart session — items, timestamps, customerId |
| `active:carts` | Set | — | Set of active cart IDs polled by abandoned-cart-checker |
| `customer:profile:{customerId}` | Hash | 30 d | Cached customer profile — orderCount, favoriteTags, lastSeenAt |
| `customer:recentlyViewed:{customerId}` | List | 7 d | Last 20 product IDs viewed (LPUSH + LTRIM) |
| `copurchase:{productId}` | Sorted Set | — | Products bought together with `productId`, score = co-purchase count |
| `product:global:score` | Sorted Set | 30 d | Global product popularity by total units ordered |
| `delivery:zones:cache` | String (JSON) | 5 min | Cached delivery zones list |
| `embedding:{hash}` | String | 30 d | Cached OpenAI embedding vectors |
| `query:exact:{hash}` | String | 5 min | L0 exact query result cache |
| `query:dynamic:{hash}` | String | 10 min | Availability-sensitive query cache |
| `query:static:{hash}` | String | 1 h | Static catalog query cache |
| `query:log:*` | List | 7 d | Query log entries for analytics |
| `wa:phone:{phoneHash}` | Hash | 24 h | WhatsApp session — phone, sessionId, customerId, lastMessageAt, state |
| `wa:rate:{phoneHash}` | String | 60 s | WhatsApp rate limit counter (max 20/min) |
| `wa:webhook:{MessageSid}` | String | 24 h | WhatsApp webhook idempotency (prevents Twilio retry reprocessing) |
| `wa:debounce:{phoneHash}` | String | 2 s | WhatsApp message debounce (batches rapid-fire messages) |
| `wa:agent:{sessionId}` | String | 30 s | WhatsApp distributed agent lock (heartbeat extends TTL every 10s) |
| `otp:ip:{ip}` | String | 1 h | OTP send rate limit per IP (max 10/hour) |
| `otp:rate:{phoneHash}` | String | 10 min | OTP send rate limit (max 3 per phone per 10 min) |
| `otp:fail:{phoneHash}` | String | 1 h | OTP brute-force counter (locks after 5 failures per hour) |
| `review:prompt:{customerId}:{orderId}` | String | 24 h | Idempotency marker for review prompt scheduling |
| `review:prompt:scheduled` | Sorted Set | — | Due review prompts (score = fire timestamp), polled every 5 min |
| `nats:processed:{eventKey}` | String | 7 d | NATS event idempotency guard (prevents duplicate subscriber processing) |
| `webhook:processed:{event.id}` | String | 7 d | Stripe webhook idempotency guard (prevents replay reprocessing) |
| `analytics:rate:{ip}` | String | 60 s | Analytics endpoint rate limit (max 100 events/min per IP) |
| `session:{sessionId}` | Hash | 24-48 h | Chat conversation history (guest 48h, authenticated 24h) |
| `product_embedding:{productId}` | String | 30 d | Cached product embedding vector for semantic search |
| `cache:stats:l0:hit` | Counter | — | L0 exact cache hit count (INCR on each hit) |
| `cache:stats:l0:miss` | Counter | — | L0 exact cache miss count |
| `cache:stats:l1:hit` | Counter | — | L1 semantic cache hit count |
| `cache:stats:l1:miss` | Counter | — | L1 semantic cache miss count |
| `cache:stats:embed:hit` | Counter | — | Embedding cache hit count |
| `cache:stats:embed:miss` | Counter | — | Embedding cache miss count |

---

## Abandoned Cart Detection

The `abandoned-cart-checker` job runs every 15 minutes and:
1. Uses `SSCAN` to iterate `active:carts` (never `KEYS *`)
2. For each cart ID, checks if `cart:session:{cartId}` has expired (TTL = 0)
3. If expired (idle > 24 h), publishes `cart.abandoned` NATS event
4. Removes the cart ID from `active:carts`

The cart session TTL is refreshed on every cart mutation (add/remove/update).

---

## Co-Purchase Intelligence

Co-purchase sorted sets are built from `CustomerOrderItem` history:

- **Key**: `{env}:copurchase:{productId}`
- **Members**: other product IDs bought in the same order
- **Score**: number of times bought together

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
- **TTL**: 30 days

Rebuild after bulk imports:
```bash
ibx intel global-score-rebuild --reset
```

---

## Memory Management Tips

- Redis maxmemory policy should be `allkeys-lru` in production
- Co-purchase sets have no TTL — prune yearly or after catalog resets
- Embedding cache (30 d TTL) accounts for the most memory; monitor with `ibx svc health redis`
- For multi-tenant / staging isolation, `APP_ENV` prefix prevents key bleed

---

## Monitoring Commands

```bash
ibx svc health redis              # ping + memory info
redis-cli -u $REDIS_URL info memory
redis-cli -u $REDIS_URL dbsize
redis-cli -u $REDIS_URL --scan --pattern "production:copurchase:*" | wc -l
```
