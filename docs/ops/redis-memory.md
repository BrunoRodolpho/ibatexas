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

---

## Abandoned Cart Detection

The `abandoned-cart-checker` job runs every 15 minutes and:
1. Uses `SSCAN` to iterate `active:carts` (never `KEYS *`)
2. For each cart ID, checks if `cart:session:{cartId}` has expired (TTL = 0)
3. If expired (idle > 24 h), publishes `ibatexas.cart.abandoned` NATS event
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
