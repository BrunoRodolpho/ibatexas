# Phase 3 Summary — Tests & Remaining Medium Fixes

**Date:** 2026-03-18
**Status:** Complete
**Test Results:** 1,521 tests passing across 111 test files

---

## PART 1: New Tests (validating Phase 1-2 fixes)

### 1. tool-registry.test.ts — withCustomerId & Zod validation

**File:** `packages/llm-provider/src/__tests__/tool-registry.test.ts`
**Tests added:**
- `always uses ctx.customerId regardless of LLM-supplied customerId for all reservation tools` — iterates create_reservation, cancel_reservation, get_my_reservations with attacker-supplied customerId; asserts all use ctx.customerId
- `throws when ctx.customerId is missing for auth-required tools` — guest context throws "Autenticacao necessaria"
- `rejects get_product_details with missing productId` — Zod validation catches missing field
- `rejects estimate_delivery with missing cep` — Zod validation catches missing field
- `rejects create_reservation with missing required fields` — Zod validation catches empty input
- `accepts valid get_product_details input` — positive path
- `accepts valid estimate_delivery input` — positive path
**Total new tests:** 7

### 2. auth-middleware.test.ts (NEW FILE)

**File:** `apps/api/src/__tests__/auth-middleware.test.ts`
**Tests added:**
- `returns 401 AND handler side-effects do NOT execute when JWT is missing` — critical: asserts sideEffects array is empty
- `returns 401 when JWT is invalid (jwtVerify resolves but no sub)` — edge case
- `allows request and sets customerId when JWT is valid`
- `allows unauthenticated requests and does not set customerId` (optionalAuth)
- `sets customerId when JWT is valid` (optionalAuth)
**Total new tests:** 5
**Design:** Uses real middleware imported dynamically; decorates Fastify request with mock jwtVerify; tracks route handler execution via sideEffects array.

### 3. health.test.ts — Already Complete

**File:** `apps/api/src/__tests__/health.test.ts`
**Status:** Phase 2 already added all three scenarios: healthy (200), degraded (200 with Typesense fail), unhealthy (503 with Redis fail). Verified passing.

### 4. cart-routes.test.ts — IDOR checks

**File:** `apps/api/src/__tests__/cart-routes.test.ts`
**Tests added:**
- `returns 403/404 when order belongs to a different customer` — order.customer_id !== request.customerId returns 404
- `returns order when customer_id matches` — happy path
- `returns 401 when not authenticated` — requireAuth blocks access
**Fixes to existing test infrastructure:**
- Added `mockMedusaAdmin` hoisted mock (was missing, blocking admin endpoint tests)
- Added `estimateDelivery` and `createCheckout` to tools mock (needed by cart route imports)
**Total new tests:** 3

### 5. estimate-delivery.test.ts (NEW FILE — TOOL-M03)

**File:** `packages/tools/src/catalog/__tests__/estimate-delivery.test.ts`
**Tests added:**
- `returns delivery estimate for a valid CEP in a covered zone`
- `returns error for invalid CEP format (non-numeric)`
- `returns error for CEP with wrong number of digits`
- `returns error when ViaCEP says CEP does not exist (erro: true)`
- `gracefully degrades when ViaCEP times out — proceeds with zone matching`
- `returns out-of-area message when CEP is valid but not in any delivery zone`
- `strips non-numeric characters from CEP before processing`
**Total new tests:** 7

### 6. reservation.test.ts (NEW FILE — TOCTOU)

**File:** `packages/domain/src/services/__tests__/reservation.test.ts`
**Tests added:**
- `succeeds when there are enough covers available` — happy path with mocked transaction
- `rejects when last slot is taken by a concurrent request — TOCTOU prevented by FOR UPDATE lock`
- `handles two concurrent requests — second one fails when both race for last slot` — uses Promise.allSettled
- `rejects when slot does not exist`
- `rejects when reservedCovers exactly equals maxCovers (zero availability)`
**Total new tests:** 5

---

## PART 2: Code Fixes

### 7. SEC-F05 — IP rate limit on verify-otp [MEDIUM]

**File:** `apps/api/src/routes/auth.ts`
**Fix:** Added `checkIpRateLimit(ip)` call at the top of the verify-otp handler, before the per-phone brute-force check. Uses the same `checkIpRateLimit` function already protecting send-otp.
**Tag:** `// AUDIT-FIX: SEC-F05`

### 8. AI-F05 — Per-conversation retry budget [MEDIUM]

**File:** `packages/llm-provider/src/agent.ts`
**Fix:** Added `MAX_CONVERSATION_RETRIES` (default: 10) configuration. Created a shared `conversationRetries` counter object (`{ count: number }`) in `runAgent` that is passed through `processToolCalls` to `executeWithRetry`. Each failed retry increments the counter; when the budget is exhausted, returns an error to Claude instead of retrying further. `NonRetryableError` does not consume budget.
**Tag:** `// AUDIT-FIX: AI-F05`

### 9. AI-F07 — Handle max_tokens truncation [MEDIUM]

**File:** `packages/llm-provider/src/agent.ts`
**Fix:** Split the `stop_reason === "end_turn" || stop_reason === "max_tokens"` branch. On `max_tokens`, emits an extra `text_delta` chunk with `"[Resposta truncada — limite de tamanho atingido.]"` before the `done` chunk, so the client knows the response was cut off.
**Tag:** `// AUDIT-FIX: AI-F07`
**Test updated:** `agent-edge-cases.test.ts` — now expects 2 text_delta chunks and verifies truncation indicator.

### 10. TOOL-L03 — Wrong Typesense filter field name [LOW]

**File:** `packages/tools/src/intelligence/get-recommendations.ts`
**Fix:** Changed `"published:=true"` to `"status:=published"` in two locations: the `buildPersonalizedQuery` filters array (line 35) and the cold-start fallback filter_by string (line 119). This matches the actual Typesense schema field.
**Tag:** `// AUDIT-FIX: TOOL-L03`
**Tests updated:** `get-recommendations.test.ts` — assertions updated to expect `status:=published`.

### 11. TOOL-M02 — search_products swallows Typesense errors [MEDIUM]

**File:** `packages/tools/src/search/search-products.ts`
**Fix:** Added `searchError` boolean flag to `searchTypesense` return. When Typesense throws, returns `{ error: true, message: "Busca indisponível no momento." }` as a structured error instead of silently returning empty results.
**Tag:** `// AUDIT-FIX: TOOL-M02`

### 12. SEC-F14 — Chat SSE stream session ownership check [MEDIUM]

**File:** `apps/api/src/routes/chat.ts`
**Fix:**
- On POST `/api/chat/messages`: stores `session:owner:{sessionId} = customerId` in Redis with 24h TTL (fire-and-forget, non-blocking).
- On GET `/api/chat/stream/:sessionId`: reads the owner key from Redis; if owner exists and does not match `request.customerId`, sends SSE error `"Acesso negado."` and closes the connection. Fails open if Redis is unavailable.
**Tag:** `// AUDIT-FIX: SEC-F14`

### 13. TOOL-H02 — create_checkout minimum-total guard [MEDIUM]

**File:** `packages/tools/src/cart/create-checkout.ts`
**Fix:** Before processing checkout, fetches the cart via `medusaStoreFetch` and verifies `cart.total > 0`. If zero or negative, throws `NonRetryableError` with pt-BR message. Added `NonRetryableError` import from `@ibatexas/types`.
**Tag:** `// AUDIT-FIX: TOOL-H02`
**Tests updated:** All `create-checkout.test.ts` mock chains updated to include cart total response. Added 2 new tests for zero and negative total.

---

## Test Summary

| Suite | Tests | Status |
|-------|-------|--------|
| `packages/llm-provider/src/__tests__/` | 28 | PASS |
| `packages/tools/src/cart/__tests__/` | 108 | PASS |
| `packages/tools/src/catalog/__tests__/` | 13 | PASS |
| `packages/tools/src/intelligence/__tests__/` | 52 | PASS |
| `packages/domain/src/services/__tests__/` | 5 | PASS |
| `apps/api/src/__tests__/` | 389 | PASS |
| All other suites | ~926 | PASS |
| **Total** | **1,521** | **ALL PASS** |

---

## Files Modified

### New files:
- `apps/api/src/__tests__/auth-middleware.test.ts`
- `packages/tools/src/catalog/__tests__/estimate-delivery.test.ts`
- `packages/domain/src/services/__tests__/reservation.test.ts`
- `docs/audit/fix-log/phase-3-tests.md`

### Modified source files:
- `apps/api/src/routes/auth.ts` (SEC-F05)
- `apps/api/src/routes/chat.ts` (SEC-F14)
- `packages/llm-provider/src/agent.ts` (AI-F05, AI-F07)
- `packages/tools/src/intelligence/get-recommendations.ts` (TOOL-L03)
- `packages/tools/src/search/search-products.ts` (TOOL-M02)
- `packages/tools/src/cart/create-checkout.ts` (TOOL-H02)

### Modified test files:
- `packages/llm-provider/src/__tests__/tool-registry.test.ts` (7 new tests)
- `packages/llm-provider/src/__tests__/agent-edge-cases.test.ts` (AI-F07 assertion update)
- `apps/api/src/__tests__/cart-routes.test.ts` (3 new tests + mock fixes)
- `packages/tools/src/cart/__tests__/create-checkout.test.ts` (2 new tests + TOOL-H02 mock chains)
- `packages/tools/src/intelligence/__tests__/get-recommendations.test.ts` (TOOL-L03 assertion update)

---

## Totals

- **New tests added:** 27
- **Existing tests updated:** 22 (mock chain updates for TOOL-H02)
- **Findings fixed:** 7 (1 Low, 6 Medium)
- **New test files:** 3
- **Tests:** 1,521 passing / 0 failing
