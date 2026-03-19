# Audit Comment Cleanup Log
> 224 comments processed across 63 files

## Removed (107)
| File | Line | Original Comment | Action |
|------|------|-----------------|--------|
| apps/api/src/index.ts | 6 | `// AUDIT-FIX: INFRA-08 — Import reservation-reminder job` | Deleted (import is self-explanatory) |
| apps/api/src/index.ts | 10 | `// AUDIT-FIX: INFRA-05 — Import closeRedisClient and prisma` | Deleted |
| apps/api/src/index.ts | 14 | `// AUDIT-FIX: EVT-F01 — outbox retry job for critical NATS events` | Deleted |
| apps/api/src/index.ts | 24 | `// AUDIT-FIX: INFRA-11 — Warn if Sentry is not configured` | Deleted |
| apps/api/src/index.ts | 51 | `// AUDIT-FIX: INFRA-08` (inline) | Deleted |
| apps/api/src/index.ts | 52 | `// AUDIT-FIX: EVT-F01` (inline) | Deleted |
| apps/api/src/index.ts | 55 | `// AUDIT-FIX: INFRA-05` (inline) | Deleted |
| apps/api/src/index.ts | 56 | `// AUDIT-FIX: INFRA-05` (inline) | Deleted |
| apps/api/src/index.ts | 81 | `// AUDIT-FIX: INFRA-08 — Start reservation-reminder job` | Deleted |
| apps/api/src/index.ts | 87 | `// AUDIT-FIX: EVT-F01 — Start outbox retry job` | Deleted |
| apps/api/src/routes/whatsapp-webhook.ts | 22 | `// AUDIT-FIX: EVT-F04 — Removed unused publishNatsEvent import` | Deleted |
| apps/api/src/routes/whatsapp-webhook.ts | 373 | `// AUDIT-FIX: EVT-F04 — Removed dead whatsapp.message.received` | Deleted |
| apps/api/src/routes/whatsapp-webhook.ts | 451 | `// AUDIT-FIX: EVT-F04 — Removed dead whatsapp.message.sent` | Deleted |
| apps/api/src/routes/whatsapp-webhook.ts | 475 | `// AUDIT-FIX: WA-M03 — Outer catch` | Deleted |
| apps/api/src/routes/auth.ts | 59 | `// AUDIT-FIX: REDIS-M03 — EXPIRE unconditionally` | Deleted (pattern visible in code) |
| apps/api/src/routes/auth.ts | 68 | `// AUDIT-FIX: REDIS-M03 — EXPIRE unconditionally` | Deleted |
| apps/api/src/routes/auth.ts | 131 | `// AUDIT-FIX: SEC-F06 — Reduced from 24h to 4h` | Deleted (TODO kept) |
| apps/api/src/routes/auth.ts | 316 | `// AUDIT-FIX: SEC-F07 — secure always` | Deleted |
| apps/api/src/routes/chat.ts | 13 | `// AUDIT-FIX: SEC-F14 — Redis client for session ownership` | Deleted (import is self-explanatory) |
| apps/api/src/whatsapp/client.ts | 8 | `// AUDIT-FIX: WA-L08 — Import hashPhone from session.ts` | Deleted |
| apps/api/src/__tests__/health.test.ts | 3 | `// AUDIT-FIX: INFRA-01 — Updated tests` | Deleted |
| apps/api/src/__tests__/whatsapp-session.test.ts | 16 | `// AUDIT-FIX: WA-M04 — needed for customer creation rate limit` | Deleted |
| apps/api/src/__tests__/whatsapp-session.test.ts | 54 | `// AUDIT-FIX: WA-M04 — Default incr return value` | Deleted |
| apps/api/src/__tests__/whatsapp-session.test.ts | 208 | `// AUDIT-FIX: WA-M04 — Test customer creation rate limit` | Deleted |
| apps/api/src/__tests__/cart-routes.test.ts | 28 | `// AUDIT-FIX: TST-C03 — mock uses return before done()` | Deleted |
| apps/api/src/__tests__/cart-routes.test.ts | 72 | `// AUDIT-FIX: REDIS-M04 — active:carts changed` | Deleted |
| apps/api/src/__tests__/cart-routes.test.ts | 434 | `// AUDIT-FIX: Phase 3 — IDOR tests` | Deleted |
| apps/api/src/__tests__/cart-intelligence.test.ts | 58 | `// AUDIT-FIX: REDIS-C01/C02 — pipeline now uses expire()` | Deleted |
| apps/api/src/__tests__/review-prompt.test.ts | 30 | `// AUDIT-FIX: REDIS-C01 — pipeline now uses expire()` | Deleted |
| apps/api/src/__tests__/analytics.test.ts | 3 | `// AUDIT-FIX: EVT-F04 — NATS publish removed` | Deleted |
| apps/api/src/__tests__/analytics.test.ts | 38 | `// AUDIT-FIX: EVT-F04 — NATS publish removed; route now just validates` | Deleted |
| apps/api/src/__tests__/analytics.test.ts | 51 | `// AUDIT-FIX: EVT-F04 — No NATS publish happens anymore` | Deleted |
| apps/api/src/__tests__/abandoned-cart-checker.test.ts | 4-5 | `// AUDIT-FIX: REDIS-M04 — Tests updated for Hash-based active:carts` | Deleted |
| apps/api/src/jobs/no-show-checker.ts | 15 | `// AUDIT-FIX: EVT-F02 — Overlap guard` | Deleted |
| apps/api/src/jobs/review-prompt-poller.ts | 16 | `// AUDIT-FIX: EVT-F02 — Overlap guard` | Deleted |
| apps/web/src/app/[locale]/loja/error.tsx | 7 | `// AUDIT-FIX: FE-L1 — Use useTranslations` | Deleted |
| apps/web/src/components/molecules/index.ts | 16 | `// AUDIT-FIX: FE-M4 — AdminSidebar removed` | Deleted |
| apps/commerce/src/subscribers/variant-updated.ts | 74 | `// AUDIT-FIX: EVT-F04 — Removed dead product.indexed` | Deleted |
| apps/commerce/src/subscribers/product-deleted.ts | 34 | `// AUDIT-FIX: EVT-F04 — Removed dead product.indexed` | Deleted |
| apps/commerce/src/subscribers/price-updated.ts | 102 | `// AUDIT-FIX: EVT-F04 — Removed dead product.indexed` | Deleted |
| apps/commerce/src/subscribers/_product-indexing.ts | 67 | `// AUDIT-FIX: EVT-F11 — Retry Typesense indexing` | Deleted |
| apps/commerce/src/subscribers/_product-indexing.ts | 74 | `// AUDIT-FIX: EVT-F04 — Removed dead product.indexed` | Deleted |
| apps/commerce/__tests__/indexing.test.ts | 137,201,275 | `// AUDIT-FIX: EVT-F04 — product.indexed NATS event removed` | Deleted (x3) |
| packages/llm-provider/src/agent.ts | 17 | `// AUDIT-FIX: AI-F03 — Per-session token budget` | Deleted (import self-explanatory) |
| packages/llm-provider/src/__tests__/tool-registry.test.ts | 150,176,196,208 | AUDIT-FIX test labels | Deleted (x4) |
| packages/nats-client/src/__tests__/nats-client.test.ts | 24 | `// AUDIT-FIX: INFRA-06 — closeNatsConnection now uses drain()` | Deleted |
| packages/domain/src/services/__tests__/reservation.test.ts | 1 | `// AUDIT-FIX: Phase 3 — Reservation service concurrency tests` | Deleted |
| packages/tools/src/cart/__tests__/*.test.ts | various | `// AUDIT-FIX: TOOL-C02 — mock assertCartOwnership` | Deleted (x6 files) |
| packages/tools/src/cart/__tests__/reorder.test.ts | 40 | `// AUDIT-FIX: TOOL-H01 — order fixture` | Deleted |
| packages/tools/src/cart/__tests__/create-checkout.test.ts | various | Inline `AUDIT-FIX: TOOL-H02` and `AUDIT-FIX: EVT-F08` | Deleted (x9) |
| packages/tools/src/intelligence/__tests__/get-recommendations.test.ts | 109,299 | `// AUDIT-FIX: TOOL-L03` | Deleted (x2) |
| packages/tools/src/search/__tests__/search-products.test.ts | 760 | `// AUDIT-FIX: EVT-F10` | Deleted |
| packages/tools/src/intelligence/get-recommendations.ts | 119 | `// AUDIT-FIX: TOOL-L03 — use "status:=published"` | Deleted |
| packages/tools/src/cart/remove-from-cart.ts | 5,12 | `// AUDIT-FIX: TOOL-C02` import + inline | Deleted |
| packages/tools/src/cart/update-cart.ts | 5,12 | `// AUDIT-FIX: TOOL-C02` import + inline | Deleted |
| packages/tools/src/cart/add-to-cart.ts | 6,14 | `// AUDIT-FIX: TOOL-C02` import + inline | Deleted |
| packages/tools/src/cart/apply-coupon.ts | 5,12 | `// AUDIT-FIX: TOOL-C02` import + inline | Deleted |
| packages/tools/src/cart/get-cart.ts | 5,12 | `// AUDIT-FIX: TOOL-C02` import + inline | Deleted |

## Converted (109)
| File | Line | Original | Rewritten |
|------|------|----------|-----------|
| apps/api/src/index.ts | 45-46 | `AUDIT-FIX: INFRA-05 — Graceful shutdown: close all connections in correct order` | `Graceful shutdown: stop jobs, drain NATS, close Fastify, close Redis, disconnect Prisma` |
| apps/api/src/index.ts | 69 | `AUDIT-FIX: EVT-F01 — Inject Redis client as outbox writer` | `Inject Redis client as outbox writer for critical NATS events` |
| apps/api/src/index.ts | 77-78 | `AUDIT-FIX: EVT-F07 — Register subscribers BEFORE starting jobs` | `Register subscribers BEFORE starting jobs to prevent race condition` |
| apps/api/src/routes/whatsapp-webhook.ts | 165 | `AUDIT-FIX: REDIS-M03 — EXPIRE unconditionally` | `EXPIRE unconditionally on every INCR to prevent immortal keys after crash` |
| apps/api/src/routes/whatsapp-webhook.ts | 207-209 | `AUDIT-FIX: WA-M06 — Scope form-urlencoded content type parser` | `Scope form-urlencoded parser to this route only (Fastify encapsulated plugin)` |
| apps/api/src/routes/whatsapp-webhook.ts | 342-344 | `AUDIT-FIX: WA-M03 — Outer try/catch wraps entire function body` | `Outer try/catch: early-stage crashes still send a fallback error message to the user` |
| apps/api/src/routes/whatsapp-webhook.ts | 376-385 | `AUDIT-FIX: WA-L09 — Debounce boundary edge case documentation` | Rewritten without audit refs, kept architectural context |
| apps/api/src/routes/whatsapp-webhook.ts | 396 | `AUDIT-FIX: REDIS-H03/WA-H01 — lock keyed by phoneHash` | Merged into section header |
| apps/api/src/routes/whatsapp-webhook.ts | 465 | `AUDIT-FIX: REDIS-H03/WA-H01 — release lock by phoneHash` | Deleted (code self-explanatory) |
| apps/api/src/routes/whatsapp-webhook.ts | 468 | `AUDIT-FIX: WA-H02 — re-check for unprocessed messages` | `Re-check for unprocessed messages after lock release` |
| apps/api/src/routes/stripe-webhook.ts | 85-86 | `AUDIT-FIX: EVT-F04` + `TODO: [AUDIT-REVIEW]` | `TODO: Add subscriber for order.refunded...` |
| apps/api/src/routes/stripe-webhook.ts | 114-115 | `AUDIT-FIX: EVT-F04` + `TODO: [AUDIT-REVIEW]` | `TODO: Add subscriber for order.disputed...` |
| apps/api/src/routes/stripe-webhook.ts | 149-150 | `AUDIT-FIX: EVT-F04` + `TODO: [AUDIT-REVIEW]` | `TODO: Add subscriber for order.canceled...` |
| apps/api/src/routes/stripe-webhook.ts | 165-167 | `AUDIT-FIX: WA-M05 — Scope raw body content type parser` | `Scope raw body parser to this route only (Fastify encapsulated plugin)` |
| apps/api/src/routes/stripe-webhook.ts | 268-275 | `AUDIT-FIX: SEC-F12 — Idempotency key deletion edge case` | Rewritten: kept idempotency edge case docs without audit ref |
| apps/api/src/routes/auth.ts | 234 | `AUDIT-FIX: SEC-F05 — IP rate limit` | `IP rate limit on verify-otp to prevent phone-spray attacks` |
| apps/api/src/routes/auth.ts | 320 | `AUDIT-FIX: SEC-F06 — 4h to match JWT expiry` | `4h -- matches JWT expiry` |
| apps/api/src/routes/chat.ts | 88 | `AUDIT-FIX: SEC-F14 — Track session ownership` | `Track session ownership in Redis so SSE endpoint can verify` |
| apps/api/src/routes/chat.ts | 147 | `AUDIT-FIX: SEC-F14 — Verify session ownership` | `Verify session ownership before allowing SSE connection` |
| apps/api/src/routes/cart.ts | 28 | `AUDIT-FIX: REDIS-C01` | `TTL on active:carts hash (48h = guest session max, prevents unbounded growth)` |
| apps/api/src/routes/cart.ts | 33-34 | `AUDIT-FIX: REDIS-M04` | `Store {sessionType, lastActivity} so abandoned-cart-checker uses correct idle threshold` |
| apps/api/src/routes/health.ts | 1-3 | `AUDIT-FIX: INFRA-01 — Deep health check` | `Deep health check that pings...` |
| apps/api/src/routes/health.ts | 111 | `AUDIT-FIX: INFRA-01 — Return 503` | `Return 503 if critical dependency fails` |
| apps/api/src/routes/analytics.ts | 70 | `AUDIT-FIX: REDIS-M03` | `EXPIRE unconditionally on every INCR to prevent immortal keys after crash` |
| apps/api/src/routes/analytics.ts | 79-81 | `AUDIT-FIX: EVT-F04 — Removed dead web.* NATS publishes` | `NATS publishing disabled (no subscriber). Re-enable when a subscriber is added` |
| apps/api/src/routes/admin/index.ts | 26-27 | `AUDIT-FIX: SEC-F10 — Support comma-separated` | `Support comma-separated list of valid API keys for rotation` |
| apps/api/src/routes/admin/index.ts | 42 | `AUDIT-FIX: SEC-F10 — Check incoming key` | `Timing-safe comparison against all valid keys` |
| apps/api/src/middleware/auth.ts | 44 | `AUDIT-FIX: SEC-F03` | `Return before done() on 401 to prevent route handler from executing` |
| apps/api/src/plugins/rate-limit.ts | 8 | `AUDIT-FIX: SEC-F04` | `Use IP alone as rate limit key to prevent bypass via sessionId rotation` |
| apps/api/src/server.ts | 17-18 | `AUDIT-FIX: INFRA-14` + `AUDIT-FIX: SEC-F13` | `Request/connection timeouts prevent slowloris; trustProxy for reverse proxy` |
| apps/api/src/config.ts | 43 | `AUDIT-FIX: INFRA-10` | `Critical infrastructure env vars -- fail-fast if missing` |
| apps/api/src/streaming/emitter.ts | 23 | `AUDIT-FIX: AI-F04` | `Cap concurrent streams to prevent memory exhaustion` |
| apps/api/src/streaming/emitter.ts | 33 | `AUDIT-FIX: AI-F04` | `Reject new streams when at capacity` |
| apps/api/src/whatsapp/session.ts | 17 | `AUDIT-FIX: WA-M04 — Global rate limit` | `Global rate limit on customer auto-creation to prevent DB write amplification` |
| apps/api/src/whatsapp/session.ts | 34-39 | `AUDIT-FIX: WA-L07 — Truncation to 12 hex chars` | Rewritten: kept collision space analysis without audit ref |
| apps/api/src/whatsapp/session.ts | 79-81 | `AUDIT-FIX: WA-M04 — Rate limit customer creation` | Rewritten without audit refs |
| apps/api/src/whatsapp/session.ts | 84 | `AUDIT-FIX: REDIS-M03 pattern — unconditional EXPIRE` | `unconditional EXPIRE` |
| apps/api/src/whatsapp/session.ts | 140-141 | `AUDIT-FIX: REDIS-H03/WA-H01 — lock keyed by phoneHash` | `Lock keyed by phoneHash (not sessionId) to prevent concurrent agent runs` |
| apps/api/src/whatsapp/session.ts | 166 | `AUDIT-FIX: REDIS-H03/WA-H01` | `Lock keyed by phoneHash (not sessionId).` |
| apps/api/src/whatsapp/client.ts | 31 | `AUDIT-FIX: INFRA-09 — Add 10s timeout` | `10s timeout prevents indefinite hangs during Twilio API outages` |
| apps/api/src/whatsapp/client.ts | 43 | `AUDIT-FIX: WA-L08 — Re-export hashPhone` | `Re-export hashPhone as phoneHash for backward compatibility` |
| apps/api/src/whatsapp/client.ts | 142 | `AUDIT-FIX: WA-L10 — Respect Twilio 429` | `Respect Twilio 429 Retry-After header` |
| apps/api/src/whatsapp/formatter.ts | 15 | `AUDIT-FIX: WA-L12 — Timeout constant` | `Timeout for agent response collection` |
| apps/api/src/whatsapp/formatter.ts | 22-24 | `AUDIT-FIX: WA-L12 — Enforces a 60-second timeout` | `Enforces a 60-second timeout so a hung LLM provider cannot block processing` |
| apps/api/src/whatsapp/formatter.ts | 35-36 | `AUDIT-FIX: WA-L12 — AbortSignal-based timeout guard` | `AbortSignal-based timeout guard: break out after 60s if the LLM provider hangs` |
| apps/api/src/whatsapp/state-machine.ts | 17-25 | `AUDIT-FIX: WA-L11 — Timeout/reset behavior documentation` | Rewritten: 3-line summary without audit ref |
| apps/api/src/subscribers/cart-intelligence.ts | 38 | `AUDIT-FIX: REDIS-C01` | `30-day TTL on copurchase sorted sets to prevent unbounded growth` |
| apps/api/src/subscribers/cart-intelligence.ts | 55 | `AUDIT-FIX: REDIS-C01` | `30-day TTL on global score to prevent unbounded growth` |
| apps/api/src/subscribers/cart-intelligence.ts | 205 | `AUDIT-FIX: REDIS-C02` | `7-day TTL on recentlyViewed to prevent unbounded growth` |
| apps/api/src/subscribers/cart-intelligence.ts | 216 | `AUDIT-FIX: EVT-F10` | `Batch event from search_products (single event instead of O(n) product.viewed)` |
| apps/api/src/jobs/outbox-retry.ts | 1-2 | `AUDIT-FIX: EVT-F01 — Outbox retry job` | `Outbox retry job -- polls Redis outbox lists every 60s...` |
| apps/api/src/jobs/outbox-retry.ts | 18 | `AUDIT-FIX: EVT-F01 — Overlap guard` | `Overlap guard (prevents concurrent runs)` |
| apps/api/src/jobs/abandoned-cart-checker.ts | 5-7 | `AUDIT-FIX: REDIS-M04 — active:carts is now a Hash` | `active:carts is a Hash: each field stores {cartId, sessionType, lastActivity}...` |
| apps/api/src/jobs/abandoned-cart-checker.ts | 26 | `AUDIT-FIX: EVT-F02 — Overlap guard` | `Overlap guard prevents concurrent job runs` |
| apps/api/src/jobs/abandoned-cart-checker.ts | 86 | `AUDIT-FIX: EVT-F02 — Skip if previous run` | Deleted (code is clear) |
| apps/api/src/jobs/review-prompt.ts | 23 | `AUDIT-FIX: REDIS-C01` | `1-day TTL on sorted set to prevent unbounded growth if poller fails` |
| apps/api/src/jobs/no-show-checker.ts | 37 | `AUDIT-FIX: EVT-F02` | `Skip if previous run still in progress` |
| apps/api/src/jobs/review-prompt-poller.ts | 20 | `AUDIT-FIX: EVT-F02` | `Skip if previous run still in progress` |
| apps/api/src/__tests__/auth-middleware.test.ts | 1 | `AUDIT-FIX: Phase 3 — Direct unit tests` | `Unit tests for requireAuth / optionalAuth middleware` |
| apps/api/src/__tests__/helpers/auth-mock.ts | 2 | `[AUDIT FIX TST-M01] Shared auth mock factory` | `Shared auth mock factory for route tests.` |
| apps/web/src/middleware.ts | 21-23 | `AUDIT-REVIEWED: FE-M1 — Intentional` | `Intentional: Edge Runtime cannot verify JWT signatures...` |
| apps/web/src/lib/posthog.ts | 35 | `AUDIT-FIX: FE-H1` | `Cookie persistence instead of localStorage to prevent XSS data exposure` |
| apps/web/src/lib/api.ts | 68 | `AUDIT-FIX: FE-M2` | `Accept optional AbortSignal to allow cancellation on unmount` |
| apps/web/src/app/error.tsx | 5 | `AUDIT-FIX: FE-H2` | `Never expose raw error.message to users; log for Sentry capture instead` |
| apps/web/src/app/[locale]/error.tsx | 6 | `AUDIT-FIX: FE-H2` | `Never expose raw error.message to users; log for Sentry capture instead` |
| apps/web/src/app/[locale]/loja/error.tsx | 6 | `AUDIT-FIX: FE-H2` | `Never expose raw error.message to users; log for Sentry capture instead` |
| apps/web/next.config.mjs | 10 | `AUDIT-FIX: INFRA-04` | `Required for Docker multi-stage build` |
| apps/web/next.config.mjs | 43 | `AUDIT-FIX: FE-C2` | `unsafe-eval only needed in dev for Next.js hot-reload` |
| apps/web/src/domains/session/session.store.ts | 116-117 | `AUDIT-FIX: FE-M3 — customerId removed` | `customerId excluded from persistence to avoid localStorage exposure.` |
| apps/web/src/domains/analytics/track.ts | 16-20 | `AUDIT-FIX: FE-L3 — Design rationale for dual session IDs` | `Dual session IDs by design:` (shortened) |
| apps/web/src/domains/chat/chat.store.ts | 3-4 | `AUDIT-FIX: FE-L2 — Cap individual message content` | `Cap individual message content to prevent unbounded memory growth from long SSE streams` |
| apps/web/src/domains/chat/chat.store.ts | 40 | `AUDIT-FIX: FE-L2` | `Truncate if message exceeds MAX_MESSAGE_LENGTH` |
| apps/admin/src/lib/api.ts | 10 | `AUDIT-FIX: SEC-F01/FE-H3` | `Include x-admin-key header in all admin API calls` |
| apps/admin/src/middleware.ts | 1-4 | `AUDIT-FIX: FE-C1 — server-side auth middleware` | `Server-side auth middleware for admin panel.` |
| apps/admin/next.config.mjs | 6 | `AUDIT-FIX: INFRA-04` | `Required for Docker multi-stage build` |
| apps/admin/next.config.mjs | 32 | `AUDIT-FIX: FE-C2` | `unsafe-eval only needed in dev for Next.js hot-reload` |
| apps/commerce/src/subscribers/variant-updated.ts | 59-60 | `AUDIT-FIX: EVT-F11` | `Re-index to Typesense with retry (upsert is idempotent)` |
| apps/commerce/src/subscribers/product-deleted.ts | 19-20 | `AUDIT-FIX: EVT-F11` | `Remove from search index with retry (idempotent -- ignores 404)` |
| apps/commerce/src/subscribers/price-updated.ts | 87-88 | `AUDIT-FIX: EVT-F11` | `Re-index to Typesense with retry (upsert is idempotent)` |
| apps/commerce/src/subscribers/_product-indexing.ts | 18 | `AUDIT-FIX: EVT-F11` | `Max retry attempts for Typesense indexing failures` |
| apps/commerce/src/subscribers/_product-indexing.ts | 26-27 | `AUDIT-FIX: EVT-F11` | `Retry wrapper with exponential backoff for Typesense operations.` |
| packages/llm-provider/src/agent.ts | 23 | `AUDIT-FIX: AI-F05` | `Per-conversation retry budget to prevent runaway cost` |
| packages/llm-provider/src/agent.ts | 26 | `AUDIT-FIX: AI-F03` | `Daily token budget per session (default 100K tokens)` |
| packages/llm-provider/src/agent.ts | 35 | `AUDIT-FIX: INFRA-02` | `60s timeout prevents indefinite hangs during API outages` |
| packages/llm-provider/src/agent.ts | 50-51 | `AUDIT-FIX: AI-F05` | `Accepts a shared conversationRetries counter...` |
| packages/llm-provider/src/agent.ts | 70 | `AUDIT-FIX: AI-F05` | `Track retries against conversation budget` |
| packages/llm-provider/src/agent.ts | 138 | `AUDIT-FIX: AI-F03` section header | `Per-session token budget helpers` |
| packages/llm-provider/src/agent.ts | 150 | `AUDIT-FIX: AI-F03` | `Fail-open: if Redis is down, allow the request` |
| packages/llm-provider/src/agent.ts | 187 | `AUDIT-FIX: AI-F03` | `Check per-session token budget before processing` |
| packages/llm-provider/src/agent.ts | 206 | `AUDIT-FIX: AI-F05` | `Per-conversation retry budget shared across all tool calls` |
| packages/llm-provider/src/agent.ts | 238 | `AUDIT-FIX: AI-F03` | `Track token usage after each turn` |
| packages/llm-provider/src/agent.ts | 252 | `AUDIT-FIX: AI-F07` | `When response is truncated by max_tokens, signal to the client` |
| packages/llm-provider/src/__tests__/agent-edge-cases.test.ts | 81 | `AUDIT-FIX: AI-F07` | `max_tokens emits an extra text_delta with truncation indicator` |
| packages/llm-provider/src/tool-registry.ts | 138 | `AUDIT-FIX: AI-F01/TOOL-C01` | `Always override customerId from ctx; never trust LLM input` |
| packages/llm-provider/src/tool-registry.ts | 205-207 | `AUDIT-FIX: AI-F02/TOOL-H03` | `Centralized Zod validation before tool dispatch.` |
| packages/llm-provider/src/tool-registry.ts | 253 | `AUDIT-FIX: AI-F02/TOOL-H03` | `Validate input with Zod before calling handler` |
| packages/nats-client/src/index.ts | 5 | `AUDIT-FIX: EVT-F01` + `TODO: [AUDIT-REVIEW]` | `TODO: Full JetStream migration needed for production reliability` |
| packages/nats-client/src/index.ts | 72-75 | `AUDIT-FIX: INFRA-07 — Removed finally block` | Rewritten: explains race condition without audit ref |
| packages/nats-client/src/index.ts | 78 | `AUDIT-FIX: EVT-F01` | `Critical events that require outbox durability` |
| packages/nats-client/src/index.ts | 81 | `AUDIT-FIX: EVT-F01` | `Optional Redis outbox writer (injected by apps/api at startup)` |
| packages/nats-client/src/index.ts | 110-111 | `AUDIT-FIX: EVT-F01` | `For critical events (order.placed, reservation.created), writes to Redis outbox...` |
| packages/nats-client/src/index.ts | 118 | `AUDIT-FIX: EVT-F01` | `Write to outbox BEFORE NATS publish for critical events` |
| packages/nats-client/src/index.ts | 134 | `AUDIT-FIX: EVT-F01` | `Remove from outbox after successful NATS publish` |
| packages/nats-client/src/index.ts | 146 | `AUDIT-FIX: EVT-F01` | `If NATS publish fails, event stays in outbox for retry` |
| packages/nats-client/src/index.ts | 187 | `AUDIT-FIX: INFRA-06` | `Use drain() instead of close() to flush pending publishes before closing` |
| packages/domain/src/client.ts | 4 | `AUDIT-FIX: INFRA-13` | `Connection pool configuration via DATABASE_URL query parameters:` |
| packages/domain/src/services/reservation.service.ts | 18 | `AUDIT-FIX: DL-F01` | `Transaction client type for interactive transactions` |
| packages/domain/src/services/reservation.service.ts | 73 | `AUDIT-FIX: DL-F01/DL-F11` | `Accepts optional tx client so it can run inside a transaction.` |
| packages/domain/src/services/reservation.service.ts | 112-113 | `AUDIT-FIX: DL-F05` | `Bulk queries instead of N+1 per-slot: 3 queries total` |
| packages/domain/src/services/reservation.service.ts | 240-243 | `AUDIT-FIX: DL-F01` + `AUDIT-FIX: DL-F11` | `Availability check, assignTables, reservation creation... ALL happen inside a single Prisma interactive transaction` |
| packages/tools/src/redis/key.ts | 9 | `AUDIT-FIX: REDIS-M01` | `Fail-fast if APP_ENV is missing in production...` |
| packages/tools/src/redis/client.ts | 8 | `AUDIT-FIX: REDIS-H01` | `Promise-based mutex prevents TOCTOU race on concurrent getRedisClient() calls` |
| packages/tools/src/redis/client.ts | 23 | `AUDIT-FIX: REDIS-H02` | `Only log on transient errors; do NOT nullify singleton (fights auto-reconnect)` |
| packages/tools/src/embeddings/client.ts | 18 | `AUDIT-FIX: INFRA-03` | `10s timeout prevents indefinite hangs during OpenAI API outages` |
| packages/tools/src/cache/embedding-cache.ts | 16 | `AUDIT-FIX: REDIS-C01` | `30-day TTL on cache:stats counters to prevent unbounded growth` |
| packages/tools/src/cache/query-cache.ts | 288 | `AUDIT-FIX: REDIS-C01` | `30-day TTL on cache:stats counters to prevent unbounded growth` |
| packages/tools/src/cart/assert-cart-ownership.ts | 1-2 | `AUDIT-FIX: TOOL-C02` | `Shared cart ownership verification helper.` |
| packages/tools/src/cart/create-checkout.ts | 82 | `AUDIT-FIX: TOOL-H02` | `Verify cart total > 0 before proceeding with checkout` |
| packages/tools/src/cart/create-checkout.ts | 111-112 | `AUDIT-FIX: EVT-F08` | `Fetch cart items BEFORE completing so we can include them in order.placed event` |
| packages/tools/src/cart/create-checkout.ts | 143 | `AUDIT-FIX: EVT-F08` | `Include items array to match Stripe webhook order.placed schema` |
| packages/tools/src/cart/create-checkout.test.ts | 130 | `AUDIT-FIX: EVT-F08` | `Cash checkout fetches cart items before completing` |
| packages/tools/src/cart/reorder.ts | 24 | `AUDIT-FIX: TOOL-H01` | `Verify order belongs to the authenticated customer` |
| packages/tools/src/cart/reorder.ts | 59-60 | `AUDIT-FIX: EVT-F04` + `TODO: [AUDIT-REVIEW]` | `TODO: Add subscriber for cart.item_added...` |
| packages/tools/src/cart/add-to-cart.ts | 28-29 | `AUDIT-FIX: EVT-F04` + `TODO: [AUDIT-REVIEW]` | `TODO: Add subscriber for cart.item_added...` |
| packages/tools/src/intelligence/submit-review.ts | 43-44 | `AUDIT-FIX: EVT-F04` + `TODO: [AUDIT-REVIEW]` | `TODO: Add subscriber for review.submitted...` |
| packages/tools/src/intelligence/get-recommendations.ts | 34 | `AUDIT-FIX: TOOL-L03` | `"status:=published" matches the Typesense schema field (not "published:=true")` |
| packages/tools/src/search/search-products.ts | 413 | `AUDIT-FIX: TOOL-M02` | `Surface Typesense error instead of silently returning empty results` |
| packages/tools/src/search/search-products.ts | 470 | `AUDIT-FIX: TOOL-M02` | `Return structured error when Typesense is down instead of empty results` |
| packages/tools/src/search/search-products.ts | 514-516 | `AUDIT-FIX: EVT-F10` | `Publish a single batch search.results_viewed event (instead of O(n) individual events).` |
| packages/tools/src/search/search-products.ts | 528 | `AUDIT-FIX: EVT-F10` | `Single batch event instead of N individual events` |
| packages/tools/src/search/search-products.ts | 677 | `AUDIT-FIX: EVT-F10` | `Single batch event instead of O(n) individual events` |
| packages/tools/src/catalog/__tests__/estimate-delivery.test.ts | 1 | `AUDIT-FIX: Phase 3 / TOOL-M03` | `Tests for estimate_delivery tool` |

## Kept (0)
No comments were kept as-is. All legitimate "audit" references (e.g., "Audit logging" in admin/index.ts line 54) were not tagged with `AUDIT-FIX` and were never matched.

## Escalated (8)
| File | Line | Comment | Why |
|------|------|---------|-----|
| apps/api/src/routes/stripe-webhook.ts | 86 | `TODO: Add subscriber for order.refunded` | Missing subscriber (cleaned to plain TODO) |
| apps/api/src/routes/stripe-webhook.ts | 115 | `TODO: Add subscriber for order.disputed` | Missing subscriber (cleaned to plain TODO) |
| apps/api/src/routes/stripe-webhook.ts | 150 | `TODO: Add subscriber for order.canceled` | Missing subscriber (cleaned to plain TODO) |
| packages/nats-client/src/index.ts | 6 | `TODO: Full JetStream migration needed` | Core NATS lacks persistence/durability (cleaned to plain TODO) |
| packages/tools/src/cart/add-to-cart.ts | 29 | `TODO: Add subscriber for cart.item_added` | Missing subscriber (cleaned to plain TODO) |
| packages/tools/src/cart/reorder.ts | 60 | `TODO: Add subscriber for cart.item_added` | Missing subscriber (cleaned to plain TODO) |
| packages/tools/src/intelligence/submit-review.ts | 44 | `TODO: Add subscriber for review.submitted` | Missing subscriber (cleaned to plain TODO) |
| apps/api/src/routes/auth.ts | 132 | `TODO: Implement refresh token flow` | 4h JWT expiry without refresh hurts UX (cleaned to plain TODO) |
