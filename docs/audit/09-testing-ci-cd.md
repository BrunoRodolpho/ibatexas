---
# 09 Audit: Testing & CI/CD Pipeline

## Executive Summary

The test suite is **unit-test-only** with good mock compliance — no test makes real network calls. However, **SonarCloud coverage exclusions hide ~80% of the codebase from the coverage metric**, making the quality gate meaningless. There are **zero E2E tests, zero integration tests, zero security scans, and no CD pipeline**. Critically, existing tests actively encode security bugs: the `withCustomerId` test validates that the LLM can impersonate any customer, and the `requireAuth` mock in cart-routes replicates the production bug where route handlers execute after 401. None of the 8 critical findings from prior audit waves would be caught by the current test suite.

**Invariant violations:**
- *"Coverage numbers reflect actual quality"* — **BROKEN** (exclusions hide ~80%)
- *"All critical paths have test coverage"* — **BROKEN** (auth middleware, reservation ownership, cart IDOR, race conditions all untested)

---

## Scope
- Vitest test suites across all packages and apps
- GitHub Actions CI/CD workflows
- SonarCloud configuration and coverage exclusions
- Turbo build orchestration
- Test quality and mock compliance

## System Invariants (Must Always Be True)
1. All critical paths have test coverage
2. Tests never hit real external services
3. CI catches type errors, lint issues, and test failures before merge
4. Coverage numbers reflect actual code quality (not gamed by exclusions)

---

## Assumptions That May Be False

| Assumption | Evidence For | Evidence Against | Risk |
|-----------|-------------|-----------------|------|
| SonarCloud quality gate ensures coverage is adequate | SonarCloud step in CI | ~80% of source excluded from coverage metric | **C** |
| requireAuth stops route handler on 401 | admin-auth test correctly returns 401 | cart-routes mock calls `done()` after 401, matching prod bug (auth.ts:49) | **C** |
| withCustomerId prevents impersonation | Guest ctx throws when no customerId | Test explicitly validates LLM-supplied customerId is preserved (tool-registry.test.ts:150) | **C** |
| Cart operations are scoped to the session owner | Cart routes exist and test for 201 | No ownership check — any cart ID accepted, no session-to-cart binding tested | **H** |
| Race conditions are prevented by application logic | Reservation tools have business rules | Zero concurrency tests; no TOCTOU test for overbooking | **H** |
| CI catches security issues before merge | CI runs lint + test + build | No SAST, no dependency audit, no CodeQL/Semgrep | **H** |

---

## Test Coverage Map

| Area | Test Files | Approx Tests | Coverage Notes |
|------|-----------|-------------|---------------|
| `apps/api/src/__tests__/` | 30 | ~180 | Good functional coverage; auth, routes, webhooks, jobs. **Excluded from SonarCloud**: routes, jobs, subscribers, whatsapp, session, errors, streaming dirs |
| `packages/tools/src/cart/__tests__/` | 12 | ~70 | All cart tools tested. Mock-based, good error paths. No IDOR/ownership tests |
| `packages/tools/src/reservation/__tests__/` | 7 | ~45 | Happy paths + edge cases. No cross-user, no race condition tests |
| `packages/tools/src/intelligence/__tests__/` | 7 | ~50 | Profile, recommendations, reviews. TTL tested. |
| `packages/tools/src/catalog/__tests__/` | 1 | ~6 | Only get-product-details |
| `packages/tools/src/search/__tests__/` | 1 | ~5 | search-products only |
| `packages/tools/src/cache/__tests__/` | 1 | ~10 | query-cache with TTL tests |
| `packages/tools/src/typesense/__tests__/` | 1 | ~5 | index-product with embedding fallback |
| `packages/llm-provider/src/__tests__/` | 4 | ~20 | Agent streaming, tool registry, edge cases. Contains impersonation-preserving test |
| `packages/nats-client/src/__tests__/` | 2 | ~10 | Publish/subscribe, error swallowing |
| `packages/cli/src/__tests__/` | 16 | ~80 | Simulation, scenarios, pipeline, matrix |
| `packages/types/src/__tests__/` | 3 | ~15 | Schema validation, constants |
| `apps/web/src/domains/*/__tests__/` | 12 | ~65 | Cart logic, stores, format, analytics, search. **Entirely excluded from SonarCloud** |
| `apps/commerce/__tests__/` | 1 | ~5 | Indexing subscriber. **Entirely excluded from SonarCloud** |
| **Total** | **~98** | **~566** | |

---

## SonarCloud Coverage Exclusion Analysis

### F-09-01: Coverage exclusions hide ~80% of source code [C]

**Full list of `sonar.coverage.exclusions`:**

```
**/index.ts                              # barrel exports
**/*.d.ts                                # type declarations
**/*.test.ts, **/*.test.tsx, **/*.spec.ts, **/__tests__/**  # test files (correct)
apps/web/src/**                          # ENTIRE web frontend
apps/admin/src/**                        # ENTIRE admin panel
apps/commerce/src/**                     # ENTIRE commerce backend
apps/api/src/routes/**                   # ALL API routes
apps/api/src/jobs/**                     # ALL background jobs
apps/api/src/subscribers/**              # ALL event subscribers
apps/api/src/whatsapp/**                 # ALL WhatsApp integration
apps/api/src/session/**                  # Session management
apps/api/src/errors/**                   # Error handling
apps/api/src/streaming/**                # SSE streaming
packages/domain/src/**                   # ENTIRE domain package
packages/types/src/**                    # ENTIRE types package
packages/ui/src/**                       # ENTIRE UI package
packages/cli/src/**                      # ENTIRE CLI package
packages/llm-provider/src/**             # ENTIRE LLM provider
packages/nats-client/src/**              # ENTIRE NATS client
packages/tools/src/typesense/client.ts   # Typesense client
packages/tools/src/mappers/**            # All mappers
packages/tools/src/intelligence/types.ts # Intelligence types
packages/tools/src/medusa/client.ts      # Medusa client
packages/tools/src/embeddings/client.ts  # Embeddings client
packages/tools/src/cache/embedding-cache.ts
packages/tools/src/cache/query-cache.ts
packages/tools/src/catalog/estimate-delivery.ts
packages/tools/src/redis/client.ts
packages/tools/src/reservation/notifications.ts
packages/tools/src/whatsapp/**
packages/tools/src/api/**
```

**Impact:** After these exclusions, the only files counted toward coverage are a subset of `packages/tools/src/` (cart tools, reservation tools, intelligence tools, search, config) and `apps/api/src/` (middleware, config — but not routes, jobs, or subscribers). The SonarCloud coverage percentage is meaningless — it measures perhaps 20% of the actual codebase.

**Evidence:** The exclusion list grew incrementally via commits like `fix: exclude low-coverage infrastructure files from SonarCloud metric` and `fix: expand coverage exclusions for infra and DI-wiring code`, suggesting the pattern was: coverage gate fails → exclude more code.

---

## Findings

### F-09-02: requireAuth mock replicates production auth bypass bug [C]

**File:** `apps/api/src/__tests__/cart-routes.test.ts:24-35`

The mock for `requireAuth` calls `done()` unconditionally after sending 401:
```typescript
requireAuth: (request, reply, done) => {
  if (!customerId) {
    void reply.code(401).send(...)  // sends 401
  } else {
    request.customerId = customerId
  }
  done()  // always called — route handler executes after 401
}
```

This mirrors the real bug in `apps/api/src/middleware/auth.ts:44-51` where `done()` is called after `reply.code(401)`, allowing the route handler to execute with `request.customerId` being `undefined`. The test is broken in the same way as production — it would pass even if the auth middleware is completely bypassed.

**Contrast:** The `apps/api/src/__tests__/reservations.test.ts:33-43` mock uses `return reply.code(401)` (async style) which correctly short-circuits. The two mocks are inconsistent.

---

### F-09-03: withCustomerId allows LLM-driven impersonation [C]

**File:** `packages/llm-provider/src/tool-registry.ts:112-125`

The `withCustomerId` helper has this logic:
```
if input has customerId → use it (LLM controls)
if input has no customerId → inject from context
```

**Test (tool-registry.test.ts:150-158):** Explicitly validates that passing `customerId: "other_cust"` in input overrides the session's `customerId`. This means if the LLM is prompt-injected to pass a different `customerId`, it will operate on another customer's reservations.

No test exists to verify that explicit customerId is **rejected** or **must match** the session.

---

### F-09-04: Cart routes have no ownership validation (IDOR) [H]

**File:** `apps/api/src/__tests__/cart-routes.test.ts`

All cart route tests use arbitrary cart IDs (`cart_01`, `cart_xyz`) without any session binding. There is no test that verifies:
- A session can only access its own cart
- Cart ID is validated against the session's Redis-tracked cart

The `GET /api/cart/:id` route does not even require authentication — any client can read any cart.

---

### F-09-05: Zero concurrency / race condition tests [H]

No test in the entire repository exercises concurrent access patterns. Specifically missing:
- **TOCTOU overbooking:** Two concurrent `createReservation` calls for the last slot
- **Double-add:** Two concurrent `addToCart` calls for the same item
- **TTL races:** Session expiring mid-operation

All tests run sequentially with mocked async calls that resolve immediately.

---

### F-09-06: No E2E tests, no integration tests [H]

- **E2E:** No Playwright, Cypress, or any browser-based test framework found
- **Integration:** All tests mock external dependencies (Medusa, Redis, Typesense, NATS, Twilio). No test exercises the real dependency chain.
- **Impact:** Bugs at the integration boundary (e.g., admin panel can't call API because `x-admin-key` header is missing from the frontend fetch client) will never be caught in CI.

---

### F-09-07: No security scanning in CI [H]

**File:** `.github/workflows/ci.yml`

CI pipeline steps: `checkout → install → db:generate → lint → test → build → SonarCloud`

Missing:
- **SAST:** No CodeQL, Semgrep, or ESLint security plugin
- **Dependency audit:** No `npm audit`, Snyk, or Dependabot
- **Secret scanning:** No Gitleaks or truffleHog
- **Container scanning:** No Trivy (assuming Docker deploy)

Only GitHub workflows found: `ci.yml`, `branch-naming.yml`, `cleanup-branches.yml`. No CD pipeline at all.

---

### F-09-08: No CD pipeline — deployment process is invisible [M]

There is no deploy workflow in `.github/workflows/`. How code reaches production is unknown:
- Manual deploy risk: no audit trail, no rollback automation
- No staging environment validation
- No canary/blue-green deployment
- NATS events lost during deploys (from Wave 2 findings) can't be mitigated without a CD pipeline with graceful drain

---

### F-09-09: Test mocks are inconsistent across files [M]

The `requireAuth` middleware is mocked differently in three test files:
1. **cart-routes.test.ts** — callback style with `done()` always called (buggy, matches production bug)
2. **reservations.test.ts** — async style with `return reply.code(401)` (correct short-circuit)
3. **admin-auth.test.ts** — tests the real middleware via dynamic import (best approach)

No shared mock factory exists. Each test file independently re-implements auth mocking, leading to inconsistency and bugs.

---

### F-09-10: Turbo caching may mask stale test results [L]

**File:** `turbo.json:23-26`

```json
"test": {
  "dependsOn": ["^build"],
  "outputs": ["coverage/**"],
  "cache": true
}
```

Test tasks are cached by Turbo based on file hash. If a test depends on environment variables or time-based logic, cached results may be stale. The `globalDependencies` only includes `.env`, so changes to non-env external state (e.g., schema files, test fixtures in other packages) may not invalidate the cache.

---

## Cross-Reference: Would Prior Audit Findings Be Caught?

| Prior Finding | Would Tests Catch It? | Why Not |
|---|---|---|
| Cross-user impersonation via withCustomerId | **NO** | Test explicitly validates impersonation works (F-09-03) |
| Cart IDOR (any session modifies any cart) | **NO** | No ownership validation in tests (F-09-04) |
| TOCTOU overbooking race condition | **NO** | Zero concurrency tests (F-09-05) |
| Admin panel can't call API (missing x-admin-key) | **NO** | No integration/E2E tests (F-09-06) |
| requireAuth doesn't stop route handler after 401 | **NO** | Mock replicates the bug (F-09-02) |
| 6 Redis key patterns with no TTL | **Partial** | Some TTL tests exist (abandoned-cart, session) but not for all 6 patterns |
| NATS events lost during deploys | **NO** | No CD pipeline, no graceful drain tests (F-09-08) |

---

## Recommendations (Priority Order)

1. **[C] Fix withCustomerId to reject LLM-supplied customerId** — always use session context, never trust input
2. **[C] Fix requireAuth to return/throw before done()** — and update all test mocks to match
3. **[C] Remove bulk SonarCloud exclusions** — bring routes, middleware, and tool clients back into coverage metrics; accept lower numbers temporarily
4. **[H] Add cart ownership validation** — bind cart ID to session in Redis, verify on every operation
5. **[H] Add concurrency tests** — at minimum for reservation creation
6. **[H] Add security scanning** — CodeQL + npm audit in CI
7. **[H] Add integration tests** — at least admin→API→Medusa happy path
8. **[M] Standardize auth mocking** — shared test utility with correct behavior
9. **[M] Create CD pipeline** — with graceful NATS drain and rollback
10. **[L] Review Turbo cache invalidation** — ensure schema changes invalidate test cache

---
