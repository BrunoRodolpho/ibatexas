# 05 Audit: Redis Architecture & State Management

## Executive Summary

The Redis layer is well-structured with consistent use of the `rk()` key factory and proper TTLs on most transient data. However, the audit identified **2 Critical**, **3 High**, and **4 Medium** severity findings. The most dangerous issue is **unbounded growth of co-purchase sorted sets and cache stats counters** (no TTL, no pruning mechanism in code). Second is **the Redis client singleton race condition** that can create duplicate connections under concurrent startup. The `rk()` compliance is strong — all production code uses `rk()` correctly. The `APP_ENV` default-to-"development" is documented but remains a deployment risk if misconfigured.

**Top 3 risks:**
1. **C-01**: 6 key patterns have NO TTL — unbounded memory growth (co-purchase sets, cache stats counters, active:carts set, review:prompt:scheduled sorted set)
2. **H-01**: Redis client singleton has a TOCTOU race — concurrent `getRedisClient()` calls during startup can create multiple connections
3. **H-02**: `customer:recentlyViewed:{customerId}` list has no EXPIRE call in code despite docs claiming 7-day TTL

---

## Scope

Redis usage across the IbateXas monorepo: key management (`rk()`), client singleton, sessions, caching (query, embedding), rate limiting, WhatsApp session state, abandoned cart tracking, intelligence sorted sets, review prompts, NATS/webhook idempotency, analytics rate limiting, and failure handling.

Files audited:
- `packages/tools/src/redis/key.ts` — rk() helper
- `packages/tools/src/redis/client.ts` — Redis client singleton
- `apps/api/src/session/store.ts` — Session storage
- `packages/tools/src/cache/query-cache.ts` — Query cache (L0/L1)
- `packages/tools/src/cache/embedding-cache.ts` — Embedding cache
- `apps/api/src/routes/auth.ts` — OTP rate limit keys
- `apps/api/src/whatsapp/session.ts` — WhatsApp session state
- `apps/api/src/jobs/abandoned-cart-checker.ts` — Abandoned cart detection
- `apps/api/src/subscribers/cart-intelligence.ts` — Co-purchase/global scores
- `apps/api/src/jobs/review-prompt.ts` + `review-prompt-poller.ts` — Review scheduling
- `apps/api/src/routes/stripe-webhook.ts` — Stripe idempotency
- `apps/api/src/routes/whatsapp-webhook.ts` — WhatsApp idempotency + rate limit
- `apps/api/src/routes/analytics.ts` — Analytics rate limit
- `apps/api/src/routes/cart.ts` — active:carts tracking
- `docs/ops/redis-memory.md` — Documented key patterns

---

## System Invariants (Must Always Be True)

1. All Redis keys use `rk()` — never raw strings
2. Every key has a TTL — no unbounded growth
3. Redis failure degrades gracefully — doesn't crash the system
4. Session data cannot bleed between environments
5. Cache invalidation is consistent — no stale data served after updates

---

## Assumptions That May Be False

| # | Assumption | Evidence For | Evidence Against | Verdict |
|---|-----------|-------------|-----------------|---------|
| 1 | `APP_ENV` is always set in production | `.env.example` documents it; `apps/api/src/index.ts:14` logs it at startup | No CI/CD validation found; fallback is `"development"` in `key.ts:9`; not in any Dockerfile | **RISKY** — silent failure |
| 2 | Co-purchase sorted sets are "small enough" | Only ~200 products in catalog (per cache invalidation comment) | O(n^2) pairs per order; 10 items/order = 90 ZINCRBY per order; 1000 orders/day = 90k writes/day growing forever | **FALSE** at scale |
| 3 | `active:carts` set is cleaned by abandoned-cart-checker | Checker runs every 15min and removes processed entries | No TTL on the set itself; if checker is stopped/crashes, set grows without bound | **FRAGILE** |
| 4 | Pipeline (MULTI/EXEC) is atomic | Redis docs confirm MULTI/EXEC is atomic | True — but the session store comment claims "atomic append, avoiding read-modify-write races" which is correct | **TRUE** |
| 5 | `review:prompt:scheduled` sorted set is self-cleaning | Poller removes entries after processing | If poller crashes or NATS publish fails, entries accumulate; poller leaves failed entries in set for retry but never removes stale ones | **PARTIALLY TRUE** |
| 6 | `customer:recentlyViewed` has a 7-day TTL | `docs/ops/redis-memory.md` line 15 says "7 d" | No `expire()` call found in `cart-intelligence.ts:196-198` where it's written (LPUSH + LTRIM but no EXPIRE) | **FALSE** — doc/code mismatch |
| 7 | Redis client is truly singleton | `client.ts` checks `if (!redis)` before creating | No mutex/lock — concurrent calls during startup can both pass the null check | **FALSE** under concurrency |

---

## Findings

### C-01: Six Key Patterns Have No TTL — Unbounded Memory Growth [CRITICAL]

**Severity:** C (Critical)

**Evidence:**

| Key Pattern | Type | Documented TTL | Actual TTL in Code | File |
|-------------|------|---------------|-------------------|------|
| `copurchase:{productId}` | Sorted Set | "—" (none) | None | `cart-intelligence.ts:42` |
| `product:global:score` | Sorted Set | "30 d" (docs) | None | `cart-intelligence.ts:54` |
| `active:carts` | Set | "—" (none) | None | `cart.ts:31` |
| `cache:stats:l0:hit/miss` | Counter | "—" (none) | None | `query-cache.ts:291` |
| `cache:stats:l1:hit/miss` | Counter | "—" (none) | None | `query-cache.ts:291` |
| `cache:stats:embed:hit/miss` | Counter | "—" (none) | None | `embedding-cache.ts:17` |
| `review:prompt:scheduled` | Sorted Set | "—" (none) | None | `review-prompt.ts:27` |

**Code evidence — copurchase (no TTL set):**
```
// cart-intelligence.ts:38-46
const pipeline = redis.multi();
for (let i = 0; i < productIds.length; i++) {
  for (let j = 0; j < productIds.length; j++) {
    if (i === j) continue;
    pipeline.zIncrBy(rk(`copurchase:${productIds[i]}`), 1, productIds[j]);
  }
}
await pipeline.exec();
// NO pipeline.expire() call
```

**Code evidence — global score (no TTL despite docs claiming 30d):**
```
// cart-intelligence.ts:48-57
async function updateGlobalScores(...) {
  const redis = await getRedisClient();
  const pipeline = redis.multi();
  for (const { productId, quantity } of items) {
    pipeline.zIncrBy(rk("product:global:score"), quantity, productId);
  }
  await pipeline.exec();
  // NO pipeline.expire() call — docs say 30d but code never sets it
}
```

**Code evidence — cache stats counters (no TTL):**
```
// query-cache.ts:289-293
function incrStat(key: string): void {
  void getRedisClient()
    .then((r) => r.incr(rk(key)))  // INCR with no EXPIRE
    .catch(() => {})
}
```

**Blast radius:** Memory leak. Co-purchase sets grow O(n^2) per order (10 items = 90 new entries). At 1000 orders/day with 10 items each, that's 90,000 ZINCRBY operations/day across ~200 product keys. Cache stats counters grow monotonically forever. `active:carts` grows if the abandoned-cart-checker fails.

**Time to failure:** Co-purchase: months (slow growth per product). Cache stats: never causes OOM but wastes memory. `active:carts`: weeks if checker is down.

**Production simulation:** After 1 year, each of 200 products could have 200 members in its co-purchase sorted set (bounded by catalog size), consuming ~200 * 200 * ~50 bytes = ~2MB. Not catastrophic but violates the "every key has a TTL" invariant. Cache stats: 6 unbounded counters = negligible memory but bad practice. `product:global:score`: single key with 200 members, negligible. `review:prompt:scheduled`: grows if poller fails — NATS publish failures leave entries forever.

**Recommendation:**
1. Add `pipeline.expire(rk("product:global:score"), 30 * 86400)` in `updateGlobalScores()`
2. Add periodic pruning for co-purchase sets (e.g., ZREMRANGEBYRANK to keep top 50)
3. Add TTL to cache stats counters (e.g., 30 days, reset with each INCR)
4. Consider adding TTL to `active:carts` or a cleanup job

---

### C-02: `customer:recentlyViewed:{customerId}` Has No TTL [CRITICAL]

**Severity:** C (Critical)

**Evidence:**

`docs/ops/redis-memory.md:15` documents this key with a "7 d" TTL. However, the only code that writes to this key is in `cart-intelligence.ts:196-198`:

```typescript
// cart-intelligence.ts:196-198
pipeline.lPush(rk(`customer:recentlyViewed:${customerId}`), productId);
pipeline.lTrim(rk(`customer:recentlyViewed:${customerId}`), 0, RECENTLY_VIEWED_MAX - 1);
// NO pipeline.expire() call
```

The `resetProfileTtl()` function called afterward only sets TTL on `customer:profile:{customerId}`, NOT on `customer:recentlyViewed:{customerId}`:

```typescript
// cart-intelligence.ts:73-76
async function resetProfileTtl(customerId: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.expire(rk(`customer:profile:${customerId}`), PROFILE_TTL_SECONDS);
  // Does NOT touch customer:recentlyViewed:{customerId}
}
```

**Blast radius:** Every customer who views a product gets a `recentlyViewed` list that never expires. With 1000 daily unique customers, that's 1000 new keys/day that persist forever. Each key holds up to 20 product IDs (~640 bytes). After 1 year: ~365,000 orphaned keys * 640 bytes = ~233 MB.

**Recommendation:** Add `pipeline.expire(rk(\`customer:recentlyViewed:${customerId}\`), 7 * 86400)` after the LTRIM in `cart-intelligence.ts`.

---

### H-01: Redis Client Singleton Has TOCTOU Race Condition [HIGH]

**Severity:** H (High)

**Evidence:**

`packages/tools/src/redis/client.ts:8-23`:
```typescript
let redis: ReturnType<typeof createClient> | null = null;

export async function getRedisClient() {
  if (!redis) {                    // Thread A reads null
    const redisUrl = ...           // Thread B also reads null (before A writes)
    redis = createClient(...)      // Both create connections
    ...
    await redis.connect()
  }
  return redis
}
```

Two concurrent callers during cold start both see `redis === null`, both call `createClient()`, both call `connect()`. The second assignment overwrites the first, leaking one connection.

**Blast radius:** Leaked Redis connection on every cold start with concurrent requests. In a serverless/auto-scaling environment, this happens on every new instance. Each leaked connection consumes a Redis connection slot.

**Recommendation:** Use a connecting promise as a mutex:
```typescript
let connectingPromise: Promise<RedisClient> | null = null;
export async function getRedisClient() {
  if (!connectingPromise) {
    connectingPromise = (async () => { ... connect ... })();
  }
  return connectingPromise;
}
```

---

### H-02: Redis Error Handler Nullifies Singleton — Subsequent Calls Reconnect Without Cleanup [HIGH]

**Severity:** H (High)

**Evidence:**

`packages/tools/src/redis/client.ts:15-18`:
```typescript
redis.on("error", (err) => {
  console.error("[Redis] Client error:", err)
  redis = null  // Clear reference so next call creates a fresh connection
})
```

When a transient Redis error fires (e.g., network blip), the error handler sets `redis = null`. The old client is NOT properly closed (`quit()` is not called). The next `getRedisClient()` call creates a new connection while the old one may still be alive in a reconnecting state. This compounds with H-01 — each error event + next call leaks a connection.

Additionally, the `node-redis` client has built-in reconnection logic. Setting `redis = null` on any error (not just fatal disconnect) fights against the library's own reconnection, creating unnecessary churn.

**Blast radius:** Connection leak on every transient Redis error. Under sustained Redis instability, rapid connection creation/abandonment can exhaust the Redis connection pool.

**Recommendation:** Remove the `redis = null` from the error handler. Only null-ify on the `end` event (permanent disconnect). Or use a circuit breaker pattern.

---

### H-03: Agent Lock Key Mismatch With Debounce Key [HIGH]

**Severity:** H (High)

**Evidence (cross-referenced from whatsapp-auditor's Wave 1 finding):**

- Agent lock: `rk(\`wa:agent:${sessionId}\`)` — keyed by `sessionId` (`whatsapp/session.ts:121`)
- Debounce: `rk(\`wa:debounce:${hash}\`)` — keyed by `phoneHash` (`whatsapp/session.ts:166`)

A single phone number maps to one `hash` but can have different `sessionId` values if the session expires and recreates. If session A expires mid-conversation and a new session B is created:
- Debounce still holds under `hash` (phone-level, correct)
- Agent lock is keyed by old `sessionId` A
- New session B can acquire a NEW lock immediately, allowing concurrent agent runs

**Blast radius:** Concurrent LLM agent executions for the same phone, producing duplicate or conflicting WhatsApp responses. Edge case but reproducible when session TTL boundary coincides with user activity.

**Recommendation:** Key the agent lock by phone hash, not session ID: `rk(\`wa:agent:${hash}\`)`.

---

### M-01: `rk()` Evaluates `APP_ENV` at Module Load Time — Cannot Change at Runtime [MEDIUM]

**Severity:** M (Medium)

**Evidence:**

`packages/tools/src/redis/key.ts:9`:
```typescript
const ENV_PREFIX: string = process.env.APP_ENV ?? "development";
```

This is a module-level constant evaluated once at import time. If `APP_ENV` is not set when the module is first imported, ALL keys get `"development:"` prefix for the entire process lifetime, even if `APP_ENV` is set later (e.g., by a late-loading config system).

**Blast radius:** If `APP_ENV` is unset in a production deployment, production data writes to `development:*` keys. If a development instance shares the same Redis, it reads production data. Cross-environment data bleed.

**Mitigation already in place:** `.env.example` documents `APP_ENV=development`. The API startup log includes the environment value (`apps/api/src/index.ts:14`). However, there's no fail-fast validation — the app starts silently with the wrong prefix.

**Recommendation:** Add a startup check that throws if `APP_ENV` is not explicitly set in production (`NODE_ENV=production`):
```typescript
if (process.env.NODE_ENV === "production" && !process.env.APP_ENV) {
  throw new Error("APP_ENV must be set in production");
}
```

---

### M-02: Documentation Lists Key Patterns That Don't Exist in Code [MEDIUM]

**Severity:** M (Medium)

**Evidence:**

`docs/ops/redis-memory.md` documents these key patterns that have NO corresponding code:
- `cart:session:{cartId}` (Hash, 24h) — grep across entire codebase returns 0 matches in .ts files
- `delivery:zones:cache` (String, 5min) — grep returns 0 matches in .ts files
- `query:exact:{hash}` — actual code uses `search_exact:{channel}:{hash}` (different prefix)
- `query:dynamic:{hash}` — actual code uses `search_cache:{channel}:{bucket}:...` (completely different structure)
- `query:static:{hash}` — not found in code

Conversely, these actual key patterns are MISSING from the docs:
- `search_exact:{channel}:{hash}` (L0 exact cache)
- `search_cache:{channel}:{bucket}:...` (L1 semantic cache)
- `nats:processed:{eventKey}` (partially documented)

**Blast radius:** Operational confusion. Engineers relying on redis-memory.md for debugging or capacity planning will look for keys that don't exist and miss keys that do.

**Recommendation:** Regenerate redis-memory.md from a grep of all `rk()` calls in the codebase.

---

### M-03: INCR + Conditional EXPIRE Race in Rate Limiters [MEDIUM]

**Severity:** M (Medium)

**Evidence:**

Multiple rate limiters use the same non-atomic pattern:

`apps/api/src/routes/auth.ts:62-65` (OTP IP rate limit):
```typescript
const count = await redis.incr(key);
if (count === 1) {
  await redis.expire(key, 3600);
}
```

`apps/api/src/routes/whatsapp-webhook.ts:122-128` (WhatsApp rate limit):
```typescript
const rateCount = await redis.incr(rateKey);
if (rateCount === 1) {
  await redis.expire(rateKey, 60);
}
```

`apps/api/src/routes/analytics.ts:70-73` (Analytics rate limit):
```typescript
const count = await redis.incr(rateLimitKey);
if (count === 1) {
  await redis.expire(rateLimitKey, 60);
}
```

If the process crashes between `INCR` (returning 1) and `EXPIRE`, the key persists forever without a TTL, permanently counting up and eventually permanently rate-limiting that IP/phone.

**Blast radius:** A single crash at the wrong moment permanently blocks an IP or phone from using the system. Requires manual Redis key deletion to fix. Worst case (per security-auditor F-04 + F-13): behind a reverse proxy with `trustProxy` not configured, all users share one IP. If that single IP's rate limit key loses its TTL after a crash, ALL users are permanently rate-limited on OTP sends.

**Note:** The global rate limiter at `apps/api/src/plugins/rate-limit.ts` uses `@fastify/rate-limit` with its own internal store — it is NOT affected by this race. Only the 4 hand-rolled Redis rate limiters in route files are vulnerable: `auth.ts:62` (OTP IP), `auth.ts:71` (OTP phone), `whatsapp-webhook.ts:122` (WhatsApp per-phone), `analytics.ts:70` (analytics per-IP).

**Recommendation:** Use a Lua script or `SET key 1 EX ttl NX` + `INCR` pattern to ensure TTL is always set atomically. Or use `EXPIRE` unconditionally on every INCR (idempotent, costs one extra RTT but guarantees TTL).

---

### M-04: Abandoned Cart Checker Uses Session TTL As Proxy for Last Activity — Inaccurate [MEDIUM]

**Severity:** M (Medium)

**Evidence:**

`apps/api/src/jobs/abandoned-cart-checker.ts:42-46`:
```typescript
const ttl = await redis.ttl(sessionKey);
const GUEST_TTL = 48 * 60 * 60;
const remainingMs = ttl * 1000;
const lastActivityAgoMs = GUEST_TTL * 1000 - remainingMs;
```

This assumes all sessions are guest sessions (48h TTL). If the session is authenticated (24h TTL per `store.ts:11`), the calculation is wrong — it uses `GUEST_TTL` (48h) as the base but the actual TTL is 24h, making `lastActivityAgoMs` off by 24 hours. An authenticated session idle for 1 hour would be calculated as idle for 25 hours, triggering false-positive abandoned cart events.

**Blast radius:** Authenticated customers receive premature "abandoned cart" WhatsApp nudges, creating a poor user experience. The nudge fires for sessions that are only 1-2 hours old.

**Recommendation:** Store the actual TTL value or a `lastActivityAt` timestamp in the `active:carts` data structure instead of deriving it from session TTL.

---

### L-01: `incrementQueryCacheHits` Uses Read-Modify-Write — Race Condition on Hit Count [LOW]

**Severity:** L (Low)

**Evidence:**

`packages/tools/src/cache/query-cache.ts:191-213`:
```typescript
const cached = await redisClient.get(key);       // READ
const entry = JSON.parse(cached);
entry.hitCount++;                                  // MODIFY
await redisClient.setEx(key, ttl, JSON.stringify(entry)); // WRITE
```

Two concurrent cache hits can both read `hitCount=5`, both increment to 6, and both write 6 — losing one count. Not critical since hit count is purely for analytics, but it's a correctness bug.

**Recommendation:** Use a separate `INCR` counter for hits, or accept the inaccuracy for analytics.

---

### L-02: `scanIterator` in Cache Invalidation Could Be Slow Under High Key Count [LOW]

**Severity:** L (Low)

**Evidence:**

`packages/tools/src/cache/query-cache.ts:230-236`:
```typescript
for await (const key of redisClient.scanIterator({ MATCH: rk("search_cache:*"), COUNT: 100 })) {
  keys.push(key)
}
```

SCAN is non-blocking per iteration but accumulates ALL matching keys in memory before deleting. If there are 100k cache keys, this array consumes significant memory.

Comment at line 222 says "Appropriate for <200 products, <10k queries/day" — this is likely fine for current scale.

**Recommendation:** Delete keys in batches during SCAN iteration rather than accumulating all keys first.

---

## rk() Compliance Audit

**Result: PASS** — All production code uses `rk()` correctly.

Grep for raw Redis key strings (`.set("literal`, `.get("literal`) across all .ts files found:
- Only false positives: `URLSearchParams.set()`, `sessionStorage.set()`, test mocks
- Test file `packages/tools/src/__tests__/cache-roundtrip.test.ts:17` uses raw keys like `mockRedis.set("cache:costela", ...)` — acceptable in tests using mock Redis
- Zero violations in production code

---

## Redis Failure Handling Assessment

| Component | Failure Mode | Graceful? | Evidence |
|-----------|-------------|-----------|---------|
| Query cache (L0/L1) | Redis down | Yes | `try/catch` returns `{ hit: false }` — falls through to Typesense (`query-cache.ts:103,150`) |
| Embedding cache | Redis down | Yes | `try/catch` returns `null` — recomputes embedding (`embedding-cache.ts:23`) |
| Analytics rate limit | Redis down | Yes | `try/catch` allows event through (`analytics.ts:77-79`) |
| Session store | Redis down | **NO** | `getRedisClient()` throws — no try/catch in `loadSession()` or `appendMessages()` (`store.ts:23,45`) |
| WhatsApp session | Redis down | **NO** | `resolveWhatsAppSession()` has no try/catch — Redis failure crashes the webhook handler |
| OTP rate limit | Redis down | **NO** | `checkIpRateLimit()` has no try/catch — Redis failure returns 500 to user |
| Agent lock | Redis down | Partial | Lock acquisition throws, but `releaseAgentLock` has try/catch (`session.ts:149-154`) |

**Critical gap:** Session store and WhatsApp session have no Redis failure fallback. If Redis goes down, ALL WhatsApp message processing stops and web chat sessions fail. These are the highest-traffic paths.

---

## Memory Estimation (1000 daily orders, ~200 products)

| Key Pattern | Count | Avg Size | Total | TTL |
|-------------|-------|----------|-------|-----|
| `session:{id}` | ~2000 active | ~5KB (50 msgs * 100B) | ~10 MB | 24-48h |
| `wa:phone:{hash}` | ~500 active | ~200B | ~100 KB | 24h |
| `customer:profile:{id}` | ~1000 active | ~2KB | ~2 MB | 30d |
| `customer:recentlyViewed:{id}` | ~1000 (growing!) | ~640B | ~640 KB + growth | **NONE** |
| `copurchase:{productId}` | ~200 | ~10KB (200 members) | ~2 MB | **NONE** |
| `product:global:score` | 1 | ~10KB | ~10 KB | **NONE** |
| `search_exact:*` | ~1000 | ~2KB | ~2 MB | 5 min |
| `search_cache:*` | ~500 | ~2KB | ~1 MB | 1 hour |
| `product_embedding:*` | ~200 | ~6KB (1536-dim) | ~1.2 MB | 30d |
| `otp:*/wa:rate:*/analytics:rate:*` | ~200 | ~50B | ~10 KB | 1h/60s |
| `nats:processed:*` | ~7000/week | ~50B | ~350 KB | 7d |
| `cache:stats:*` | 6 | ~50B | ~300B | **NONE** |
| `review:prompt:*` | ~100 | ~100B | ~10 KB | 24h |
| `active:carts` | 1 set, ~500 members | ~25KB | ~25 KB | **NONE** |

**Estimated total: ~20 MB active + slow unbounded growth from `recentlyViewed` keys**

This is well within typical Redis capacity. The unbounded growth from `customer:recentlyViewed` (C-02) is the primary long-term concern (~233 MB/year).

---

## Cross-Agent Findings

- **From security-auditor (Wave 1):** Rate limit key `otp:ip:{ip}` uses IP directly — behind a proxy, `request.ip` may always be the proxy IP, effectively sharing a rate limit across all users. Confirmed in auth.ts:59-67. Related to M-03 (rate limiter atomicity).
- **From security-auditor (Wave 2):** Confirmed M-03 pattern in all 4 hand-rolled rate limiters. Noted that `@fastify/rate-limit` plugin (`plugins/rate-limit.ts`) uses its own internal store and is NOT affected — only the custom Redis-based rate limiters are vulnerable. The interaction between F-04 (sessionId bypass), F-13 (trustProxy not configured), and M-03 (INCR+EXPIRE race) creates a worst-case scenario: single shared IP + immortal rate limit key = permanent OTP lockout for all users. Updated M-03 blast radius accordingly.
- **From whatsapp-auditor (Wave 1):** Agent lock uses `sessionId` but debounce uses `phoneHash` — key mismatch. Confirmed and documented as H-03.
- **From ai-agent-auditor (Wave 1):** Unbounded SSE streams Map in `emitter.ts` — not Redis-related but same "unbounded growth" pattern.
- **From whatsapp-auditor (Wave 2):** Three additional findings integrated:
  1. **Agent lock session eviction bypass** — Under LRU memory pressure, Redis can evict the `wa:phone:{hash}` session hash, causing `resolveWhatsAppSession()` to create a new session with a new UUID. The new sessionId bypasses the existing agent lock (`wa:agent:{oldSessionId}`), allowing concurrent agent runs. This compounds H-03 — not just session TTL expiry but also memory-pressure eviction creates the race. Recommendation already in H-03: key lock by phone hash.
  2. **Phone hash truncation — 48-bit collision space** — `hashPhone()` in `whatsapp/session.ts:31` truncates SHA-256 to 12 hex chars (48 bits). Birthday collision threshold ~16.8M unique phones. Used in `wa:phone:{hash}`, `wa:rate:{hash}`, `wa:debounce:{hash}`. At current scale (<10k phones) this is safe, but a collision would merge two users' sessions, rate limits, and debounce windows. **Severity: L (Low at current scale, H if phone base grows to millions).**
  3. **No circuit breaker on `getRedisClient()` — Twilio thundering herd** — When Redis is down, every WhatsApp webhook call to `checkIdempotency()` throws, returning 500 to Twilio. Twilio retries failed webhooks (up to 3x with backoff). When Redis recovers, the accumulated retries flood the system simultaneously. This amplifies the Redis failure handling gap already documented in the Failure Handling Assessment table (WhatsApp session row). Recommendation: add a circuit breaker or in-memory fallback for the idempotency check so Twilio gets 200 even when Redis is down.
- **From data-layer-auditor (Wave 2):** `reservedCovers` counter on `TimeSlot` can go negative via concurrent cancel + no-show race. **Redis impact assessed: LOW.** Availability data is NOT cached in Redis — reservation tools (`check-availability.ts`) query Prisma directly. However, the customer profile hash in Redis tracks `reservationCount`, `cancellationCount`, and `noShowCount` via `hIncrBy` (`cart-intelligence.ts:278,310,325`). If both `reservation.cancelled` and `reservation.no_show` NATS events fire for the same reservation, the profile double-counts (one reservation inflates both counters). Informational counters only — no decision-making impact.
