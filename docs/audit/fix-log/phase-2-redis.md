# Phase 2: Redis & State Management Audit Fixes

**Date:** 2026-03-18
**Audit reports:** `docs/audit/05-redis-state-management.md`, `docs/audit/03-whatsapp-webhooks.md`

---

## Summary

Fixed 10 findings across 2 Critical, 3 High, and 4 Medium severity issues plus 1 documentation fix. All changes tagged with `// AUDIT-FIX: {FINDING-ID}`.

---

## Fixes Applied

### CRITICAL

| ID | Finding | Fix | Files |
|----|---------|-----|-------|
| REDIS-C01 | 6 key patterns had no TTL (unbounded growth) | Added TTLs: copurchase 30d, product:global:score 30d, active:carts 48h, cache:stats 30d, review:prompt:scheduled 1d | `cart-intelligence.ts`, `cart.ts`, `query-cache.ts`, `embedding-cache.ts`, `review-prompt.ts` |
| REDIS-C02 | `customer:recentlyViewed` had no TTL despite docs claiming 7d | Added `pipeline.expire()` with 7-day TTL after LTRIM | `cart-intelligence.ts` |

### HIGH

| ID | Finding | Fix | Files |
|----|---------|-----|-------|
| REDIS-H01 | Redis client singleton TOCTOU race | Refactored to promise-based mutex (`connectingPromise`) | `packages/tools/src/redis/client.ts` |
| REDIS-H02 | Error handler nullifies singleton, fights auto-reconnect | Removed `redis = null` from error handler; only nullify on `end` event | `packages/tools/src/redis/client.ts` |
| REDIS-H03 / WA-H01 | Agent lock keyed by sessionId but debounce uses phoneHash | Changed `acquireAgentLock()` and `releaseAgentLock()` to accept phoneHash; updated callers in webhook handler | `whatsapp/session.ts`, `routes/whatsapp-webhook.ts` |
| WA-H02 | Silent message loss when agent lock is held | Added post-lock-release re-check: if last message in history is from user (unprocessed), re-acquire lock and re-run agent once | `routes/whatsapp-webhook.ts` |

### MEDIUM

| ID | Finding | Fix | Files |
|----|---------|-----|-------|
| REDIS-M01 | `APP_ENV` evaluated at module load with silent fallback | Added fail-fast: `throw` if `NODE_ENV=production` and `APP_ENV` unset | `packages/tools/src/redis/key.ts` |
| REDIS-M03 | INCR + conditional EXPIRE race in rate limiters | Made EXPIRE unconditional on every INCR (4 locations) | `routes/auth.ts`, `routes/whatsapp-webhook.ts`, `routes/analytics.ts` |
| REDIS-M04 | Abandoned cart checker uses guest TTL for all sessions | Changed `active:carts` from Set to Hash storing `{cartId, sessionType, lastActivity}`; checker now uses `lastActivity` directly | `routes/cart.ts`, `jobs/abandoned-cart-checker.ts` |
| REDIS-M02 | redis-memory.md listed non-existent key patterns | Regenerated doc from `rk()` grep; removed 5 phantom patterns, added 3 missing ones, updated TTLs | `docs/ops/redis-memory.md` |

---

## Files Modified

- `packages/tools/src/redis/client.ts` (H01, H02)
- `packages/tools/src/redis/key.ts` (M01)
- `packages/tools/src/cache/query-cache.ts` (C01 - cache stats TTL)
- `packages/tools/src/cache/embedding-cache.ts` (C01 - cache stats TTL)
- `apps/api/src/subscribers/cart-intelligence.ts` (C01 copurchase/global, C02 recentlyViewed)
- `apps/api/src/routes/cart.ts` (C01 active:carts, M04 hash metadata)
- `apps/api/src/jobs/review-prompt.ts` (C01 review:prompt:scheduled TTL)
- `apps/api/src/jobs/abandoned-cart-checker.ts` (M04 HSCAN + lastActivity)
- `apps/api/src/whatsapp/session.ts` (H03 agent lock by phoneHash)
- `apps/api/src/routes/whatsapp-webhook.ts` (H03 callers, WA-H02 re-check, M03 rate limiter)
- `apps/api/src/routes/auth.ts` (M03 rate limiters)
- `apps/api/src/routes/analytics.ts` (M03 rate limiter)
- `docs/ops/redis-memory.md` (M02 doc regeneration)

---

## Not Fixed (deferred / out of scope)

- **L-01** (query cache hit count read-modify-write race): Low severity, analytics-only impact
- **L-02** (SCAN accumulates all keys in memory): Acceptable at current scale (<200 products)
- **WA M-03** (early crash in handleMessageAsync leaves user without response): Separate from Redis audit
- **WA M-04** (no rate limit on customer auto-creation): Separate from Redis audit

---

## Test Results

```
Test Files  109 passed (109)
Tests       1494 passed (1494)
Duration    17.99s
```

All tests pass. Test files updated to support the new Redis patterns:
- `cart-intelligence.test.ts` — added `expire` to pipeline mocks, updated subscriber count (11 -> 12)
- `cart-routes.test.ts` — changed from `sAdd`/`sRem` to `hSet`/`hDel` mocks for active:carts Hash
- `abandoned-cart-checker.test.ts` — full rewrite for Hash-based `active:carts` with HSCAN + JSON metadata
- `review-prompt.test.ts` — added `expire` to pipeline mock
