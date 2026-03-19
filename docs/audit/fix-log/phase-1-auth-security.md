# Phase 1: Auth & Security Audit Fixes

**Date:** 2026-03-18
**Findings addressed:** 10 (4 Critical, 4 High, 2 Critical test fixes)

---

## 1. [CRITICAL] AI-F01/TOOL-C01 -- withCustomerId allows LLM-supplied customerId

**File:** `packages/llm-provider/src/tool-registry.ts`
**Fix:** Rewrote `withCustomerId` HOF to ALWAYS override `input.customerId` with `ctx.customerId`. Removed the branch that passed LLM-supplied customerId through unchecked. The session context is now the only source of truth for customer identity.
**Tag:** `// AUDIT-FIX: AI-F01/TOOL-C01`

## 2. [CRITICAL] TOOL-C02 -- Cart IDOR, no ownership verification

**Files:**
- `packages/tools/src/cart/assert-cart-ownership.ts` (new)
- `packages/tools/src/cart/get-cart.ts`
- `packages/tools/src/cart/add-to-cart.ts`
- `packages/tools/src/cart/update-cart.ts`
- `packages/tools/src/cart/remove-from-cart.ts`
- `packages/tools/src/cart/apply-coupon.ts`
- `packages/tools/src/index.ts`

**Fix:** Created `assertCartOwnership()` helper that fetches the cart from Medusa and verifies `cart.customer_id` matches the session's `customerId` (or is null for guest carts). All five guest cart tools now call this check before performing any operation. The helper throws `NonRetryableError` on mismatch.
**Tag:** `// AUDIT-FIX: TOOL-C02`

## 3. [CRITICAL] SEC-F01/FE-H3 -- Admin frontend missing x-admin-key header

**Files:**
- `apps/admin/src/lib/api.ts`
- `.env.example`

**Fix:** Added `'x-admin-key': process.env.NEXT_PUBLIC_ADMIN_API_KEY` to the default headers in `apiFetch()`. Added `NEXT_PUBLIC_ADMIN_API_KEY` to `.env.example` with a descriptive comment.
**Tag:** `// AUDIT-FIX: SEC-F01/FE-H3`

## 4. [CRITICAL] FE-C1 -- Admin panel zero server-side auth

**File:** `apps/admin/src/middleware.ts` (new)

**Fix:** Created Next.js Edge Runtime middleware that protects all `/admin/*` routes. Validates presence of `admin-session` cookie or `x-admin-key` header. In production, unauthenticated requests are redirected to the root page with `?auth=required`. Development mode allows bypass for existing dev workflow.
**Tag:** `// AUDIT-FIX: FE-C1`

## 5. [HIGH] SEC-F03 -- requireAuth calls done() after sending 401

**File:** `apps/api/src/middleware/auth.ts`

**Fix:** Added `return` before `done()` in the 401 branch. This prevents the route handler from continuing to execute with `undefined` customerId after a 401 response has been sent.
**Tag:** `// AUDIT-FIX: SEC-F03`

## 6. [HIGH] SEC-F04 -- Rate limit key includes sessionId

**File:** `apps/api/src/plugins/rate-limit.ts`

**Fix:** Removed `sessionId` from the `keyGenerator` function. Rate limiting now uses `request.ip` alone as the key, preventing bypass via sessionId rotation.
**Tag:** `// AUDIT-FIX: SEC-F04`

## 7. [HIGH] AI-F02/TOOL-H03 -- No runtime Zod validation in tool-registry dispatch

**File:** `packages/llm-provider/src/tool-registry.ts`

**Fix:** Added a `toolInputSchemas` map that maps every tool name to its corresponding Zod schema. The `executeTool` function now calls `schema.parse(input)` before dispatching to the handler. Tools wrapped by `withCustomerId` use `.partial({ customerId: true })` since customerId is injected from context after validation. Tools without a dedicated schema (`get_product_details`, `estimate_delivery`) get inline Zod schemas.
**Tag:** `// AUDIT-FIX: AI-F02/TOOL-H03`
**Dependency added:** `zod` to `@ibatexas/llm-provider` package.json

## 8. [HIGH] TOOL-H01 -- reorder fetches any order without ownership check

**File:** `packages/tools/src/cart/reorder.ts`

**Fix:** After fetching the order from admin API, added check that `data.order.customer_id === ctx.customerId`. Throws `NonRetryableError` on mismatch.
**Tag:** `// AUDIT-FIX: TOOL-H01`

## 9. [CRITICAL] TST-C02 -- Test validates impersonation as correct behavior

**File:** `packages/llm-provider/src/__tests__/tool-registry.test.ts`

**Fix:** Changed the test from asserting `customerId: "other_cust"` (the LLM-supplied value) to asserting `customerId: "cust_01"` (the session context value). The test now verifies that LLM-supplied customerId is always overridden.
**Tag:** `// AUDIT-FIX: TST-C02`

## 10. [CRITICAL] TST-C03 -- requireAuth mock replicates production auth bypass

**File:** `apps/api/src/__tests__/cart-routes.test.ts`

**Fix:** Updated the `requireAuth` mock to use `return` before `done()` on the 401 path, matching the production fix from item 5. The mock now correctly short-circuits on auth failure.
**Tag:** `// AUDIT-FIX: TST-C03`

---

## Test Updates

Several existing test files were updated to accommodate the new security checks:

- `packages/tools/src/cart/__tests__/get-cart.test.ts` -- mock `assertCartOwnership`
- `packages/tools/src/cart/__tests__/add-to-cart.test.ts` -- mock `assertCartOwnership`
- `packages/tools/src/cart/__tests__/update-cart.test.ts` -- mock `assertCartOwnership`
- `packages/tools/src/cart/__tests__/remove-from-cart.test.ts` -- mock `assertCartOwnership`
- `packages/tools/src/cart/__tests__/apply-coupon.test.ts` -- mock `assertCartOwnership`
- `packages/tools/src/cart/__tests__/reorder.test.ts` -- added `customer_id` to order fixtures

---

## Test Results

| Suite | Tests | Status |
|-------|-------|--------|
| `packages/llm-provider/src/__tests__/` | 27 | PASS |
| `packages/tools/src/cart/__tests__/` | 106 | PASS |
| `apps/api/src/__tests__/` | 384 | PASS |
| **Total** | **517** | **ALL PASS** |
