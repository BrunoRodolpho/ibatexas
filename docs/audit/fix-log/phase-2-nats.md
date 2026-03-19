# Phase 2 Fix Log: NATS Events, Jobs & LLM Cost Controls

**Date:** 2026-03-18
**Audit reports:** `08-nats-events-jobs.md`, `02-ai-agent-llm.md`

---

## EVT-F01 [CRITICAL] — NATS Core fire-and-forget: Redis-backed outbox

**Files changed:**
- `packages/nats-client/src/index.ts` — Added outbox write before NATS publish, remove after success for critical events (`order.placed`, `reservation.created`)
- `apps/api/src/jobs/outbox-retry.ts` — New polling job (60s interval) re-publishes undelivered events from Redis outbox
- `apps/api/src/index.ts` — Wired outbox writer injection and outbox-retry job into startup/shutdown

**Design:**
- Critical events are written to `rk('outbox:{eventName}')` Redis list BEFORE NATS publish
- On successful NATS publish, the entry is removed via LREM
- If NATS publish fails (deploy, crash), the entry stays in Redis
- The outbox-retry job polls every 60s, reads pending entries, and re-publishes
- Subscriber-side idempotency guard (`isNewEvent`) prevents duplicate processing
- Overlap guard prevents concurrent outbox-retry runs

**TODO:** Full JetStream migration needed for production reliability

---

## EVT-F04 [HIGH] — Dead events audit

**Events REMOVED (no subscriber, noise/redundant):**
| Event | File | Reason |
|-------|------|--------|
| `product.indexed` | `_product-indexing.ts`, `product-deleted.ts`, `price-updated.ts`, `variant-updated.ts` | Informational only, no consumer, wastes NATS bandwidth |
| `whatsapp.message.received` | `whatsapp-webhook.ts:296` | Observability intent but no consumer; structured logs already capture this |
| `whatsapp.message.sent` | `whatsapp-webhook.ts:396` | Same as above |
| `web.*` (33 types) | `analytics.ts:83` | Entire frontend analytics NATS pipeline was a no-op; route still validates/rate-limits |

**Events KEPT with [AUDIT-REVIEW] comment (useful for future features):**
| Event | File | Future use |
|-------|------|------------|
| `cart.item_added` | `add-to-cart.ts`, `reorder.ts` | Cart analytics pipeline |
| `order.refunded` | `stripe-webhook.ts` | Refund intelligence, profile updates |
| `order.disputed` | `stripe-webhook.ts` | Dispute alerting |
| `order.canceled` | `stripe-webhook.ts` | Cancellation analytics |
| `review.submitted` | `submit-review.ts` | Review analytics pipeline |

---

## EVT-F07 [MEDIUM] — Startup subscriber registration race

**File:** `apps/api/src/index.ts`

**Fix:** Moved `await startCartIntelligenceSubscribers(server.log)` BEFORE all `start*Checker/Poller` calls. Previously, jobs were started before subscribers were registered, creating a race window where events fired by the initial job run had no listener.

---

## EVT-F08 [MEDIUM] — order.placed schema mismatch (cash checkout)

**File:** `packages/tools/src/cart/create-checkout.ts`

**Fix:** Before completing the cart for cash payment, fetch cart items via `GET /store/carts/{cartId}` and include the `items` array in the `order.placed` NATS event payload. This matches the Stripe webhook version's schema, preventing `items.map()` TypeError in the subscriber.

---

## EVT-F10 [MEDIUM] — O(n) product.viewed replaced with batch event

**Files changed:**
- `packages/tools/src/search/search-products.ts` — Replaced N individual `publishNatsEvent("product.viewed", ...)` calls with a single `publishNatsEvent("search.results_viewed", { productIds: [...], ... })`
- `apps/api/src/subscribers/cart-intelligence.ts` — Added `search.results_viewed` subscriber that batch-updates `recentlyViewed` in a single Redis pipeline

**Note:** The individual `product.viewed` event is still published by `get-product-details.ts` for single-product detail views. The existing subscriber handles that.

---

## AI-F03 [HIGH] — Per-session LLM token cost controls

**File:** `packages/llm-provider/src/agent.ts`

**Fix:**
- Before each `runAgent` call, check `rk('llm:tokens:{sessionId}')` against daily budget (default 100,000 tokens, configurable via `AGENT_SESSION_TOKEN_BUDGET`)
- After each Claude response, `INCRBY` the counter with actual token usage (`input_tokens + output_tokens`)
- Key has 24h TTL (auto-expires, self-cleaning)
- Over-budget returns pt-BR message: "Limite de uso atingido. Tente novamente amanha."
- Fail-open: if Redis is unavailable, the request proceeds (availability over strictness)

---

## INFRA-10 [MEDIUM] — Config validation for critical env vars

**File:** `apps/api/src/config.ts`

**Fix:** Added required Zod validators for: `ANTHROPIC_API_KEY`, `DATABASE_URL`, `REDIS_URL`, `NATS_URL`. Server now fails fast on startup if any critical infrastructure env var is missing.

---

## Summary

| Finding | Severity | Status |
|---------|----------|--------|
| EVT-F01 | Critical | Fixed (outbox pattern) |
| EVT-F04 | High | Fixed (5 removed, 5 annotated) |
| EVT-F07 | Medium | Fixed |
| EVT-F08 | Medium | Fixed |
| EVT-F10 | Medium | Fixed |
| AI-F03 | High | Fixed |
| INFRA-10 | Medium | Fixed |
