# Coverage Gap Analysis

Generated: 2026-03-18
Context: After removing SonarCloud coverage exclusions (TST-C01), the quality gate will reflect real coverage. This document maps what is tested and what is not.

---

## Packages/Apps WITH Tests

| Package/App | Test Files | Approx Tests | Notes |
|---|---|---|---|
| `apps/api` | 31 | ~180 | Routes, middleware, jobs, webhooks, WhatsApp, streaming. Good breadth. |
| `apps/web` | 16 | ~65 | Domain logic (cart, search, session, analytics, experimentation). No component tests. |
| `apps/commerce` | 1 | ~5 | Only indexing subscriber. |
| `packages/tools` | 28 | ~120 | Cart tools, reservation tools, intelligence, search, cache, mappers, embeddings, typesense. |
| `packages/cli` | 16 | ~80 | Simulation, scenarios, pipeline, matrix, services, seed. |
| `packages/llm-provider` | 4 | ~20 | Agent streaming, tool registry, edge cases. |
| `packages/nats-client` | 2 | ~10 | Publish/subscribe, roundtrip. |
| `packages/types` | 3 | ~15 | Schema validation, constants. |

**Total: ~101 test files, ~495 tests**

---

## Packages/Apps WITHOUT Tests

| Package/App | Source Files | Risk | Notes |
|---|---|---|---|
| `apps/admin` | ~23 (8 TS + 15 TSX) | HIGH | Entire admin panel has zero tests. Contains admin dashboard, order management, reservation management, delivery zones. |
| `packages/domain` | ~12 (excl. generated) | MEDIUM | Prisma services (customer, order, reservation, review, table, delivery-zone). Core business logic with no test coverage. |
| `packages/ui` | ~20 (8 TS + 12 TSX) | LOW | Shared UI components (Button, DataTable, AdminSidebar, etc.). Mostly presentational. |

---

## Critical Paths Needing Coverage

### 1. Auth Middleware (`apps/api/src/middleware/auth.ts`)
- **Current state:** Tested indirectly via `admin-auth.test.ts` (dynamic import), but cart-routes and others use broken mocks.
- **Gap:** No direct unit test for requireAuth that validates it short-circuits on 401.
- **Effort:** Small (1-2 hours). Write a focused test that calls the middleware directly.

### 2. Cart Ownership / IDOR (`packages/tools/src/cart/assert-cart-ownership.ts`, `apps/api/src/routes/cart.ts`)
- **Current state:** `assert-cart-ownership.ts` exists but no test validates that cart operations reject cross-user access.
- **Gap:** No test that a session can only modify its own cart. IDOR vulnerability is untested.
- **Effort:** Medium (2-4 hours). Need to mock Redis session bindings and verify ownership checks.

### 3. Reservation Race Conditions (`packages/tools/src/reservation/create-reservation.ts`)
- **Current state:** Happy-path and edge-case tests exist. Zero concurrency tests.
- **Gap:** TOCTOU overbooking (two concurrent creates for last slot) completely untested.
- **Effort:** Medium (4-6 hours). Requires concurrent test harness with controlled timing.

### 4. AI Tool Registry / withCustomerId (`packages/llm-provider/src/tool-registry.ts`)
- **Current state:** Test at line 150 validates that LLM-supplied customerId overrides session customerId.
- **Gap:** Test encodes a security bug (impersonation). Need a test that REJECTS external customerId.
- **Effort:** Small (1-2 hours). Fix the tool + add rejection test.

### 5. Domain Services (`packages/domain/src/services/`)
- **Current state:** Zero tests. Services for customer, order, reservation, review, delivery-zone, table.
- **Gap:** Core business logic (order totals, reservation constraints, review validation) completely untested.
- **Effort:** Large (8-12 hours). Need Prisma mocking setup. Start with reservation.service.ts and order.service.ts.

### 6. Admin Panel (`apps/admin/`)
- **Current state:** Zero tests. Admin dashboard, CRUD for products, orders, reservations.
- **Gap:** Admin can manage critical business data with no test safety net.
- **Effort:** Large (10-16 hours). Start with admin API client and mappers, then page logic.

### 7. Commerce Subscribers (`apps/commerce/src/subscribers/`)
- **Current state:** 1 test for indexing. 7 subscriber files (product-created, product-updated, price-updated, variant-updated, product-deleted, order-delivered).
- **Gap:** Event-driven product sync and order lifecycle untested.
- **Effort:** Medium (4-6 hours). Subscribers are relatively straightforward to mock.

### 8. WhatsApp State Machine (`apps/api/src/whatsapp/state-machine.ts`)
- **Current state:** Has tests (`whatsapp-state-machine.test.ts`). Good.
- **Gap:** No test for session hijacking or auth bypass via WhatsApp flow.
- **Effort:** Small (2-3 hours). Add security-focused test cases.

---

## Effort Summary

| Priority | Area | Estimated Effort |
|---|---|---|
| P0 (security) | Auth middleware direct test | 1-2 hours |
| P0 (security) | Cart IDOR / ownership test | 2-4 hours |
| P0 (security) | withCustomerId rejection test | 1-2 hours |
| P1 (correctness) | Reservation concurrency tests | 4-6 hours |
| P1 (correctness) | Domain services (reservation, order) | 8-12 hours |
| P2 (coverage) | Commerce subscribers | 4-6 hours |
| P2 (coverage) | Admin panel tests | 10-16 hours |
| P3 (nice-to-have) | UI component tests | 4-8 hours |

**Total estimated effort: ~35-56 hours**

---

## Recommended Test Priority Order

1. Auth middleware + withCustomerId rejection (security, blocks impersonation)
2. Cart ownership validation (security, blocks IDOR)
3. Reservation concurrency (correctness, prevents overbooking)
4. Domain services for reservation and order (correctness, core business logic)
5. Commerce subscribers (coverage, event-driven logic)
6. Admin panel mappers and API client (coverage, admin tooling)
7. UI component smoke tests (coverage, presentational)
