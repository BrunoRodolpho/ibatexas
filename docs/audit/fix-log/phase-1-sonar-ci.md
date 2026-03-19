# Phase 1 Fix Log: SonarCloud & CI/CD

Date: 2026-03-18
Audit source: [docs/audit/09-testing-ci-cd.md](../09-testing-ci-cd.md)

---

## TST-C01 [CRITICAL] — SonarCloud exclusions hid ~80% of codebase

**File:** `sonar-project.properties`

**Problem:** The `sonar.coverage.exclusions` list had grown to exclude almost every package and app directory. The coverage metric only measured a small subset of `packages/tools/src/` and `apps/api/src/` (middleware + config). The exclusion list grew incrementally via commits like "fix: exclude low-coverage infrastructure files from SonarCloud metric" — the pattern was: quality gate fails, exclude more code.

**Fix:** Replaced the blanket exclusions with a minimal set:
- Test files: `**/*.test.ts`, `**/*.test.tsx`, `**/*.spec.ts`, `**/*.spec.tsx`, `**/__tests__/**`
- Generated code: `**/generated/**`, `**/node_modules/**`
- Type-only: `packages/types/**`
- Config files: `**/*.config.ts`, `**/*.config.mjs`, `**/*.config.js`, `**/next.config.*`
- Type declarations: `**/*.d.ts`

**Removed exclusions (now counted toward coverage):**
- `apps/web/src/**` (entire web frontend)
- `apps/admin/src/**` (entire admin panel)
- `apps/commerce/src/**` (entire commerce backend)
- `apps/api/src/routes/**`, `apps/api/src/jobs/**`, `apps/api/src/subscribers/**`, `apps/api/src/whatsapp/**`, `apps/api/src/session/**`, `apps/api/src/errors/**`, `apps/api/src/streaming/**`
- `packages/domain/src/**`, `packages/ui/src/**`, `packages/cli/src/**`, `packages/llm-provider/src/**`, `packages/nats-client/src/**`
- Multiple individual files in `packages/tools/src/`

**Expected impact:** SonarCloud quality gate WILL fail on the next run. This is intentional. The previous passing gate was meaningless because it excluded all the important code. Real coverage must be added over time (see phase-1-coverage-gaps.md).

---

## TST-F07 [HIGH] — No security scanning in CI

**File:** `.github/workflows/ci.yml`

**Problem:** CI pipeline had zero security scanning: no SAST, no dependency audit, no secret scanning.

**Fix:** Added a `pnpm audit --audit-level=high || true` step after the test step. It is non-blocking (`|| true`) initially to avoid breaking CI on existing advisories.

**Tagged with:** `# [AUDIT FIX TST-F07]` and `# TODO: Make blocking once existing advisories are resolved`

**Future work:** Add CodeQL or Semgrep for SAST, and Gitleaks for secret scanning.

---

## TST-M01 [MEDIUM] — Test mocks inconsistent across files

**File created:** `apps/api/src/__tests__/helpers/auth-mock.ts`

**Problem:** The `requireAuth` middleware was mocked differently in three test files:
1. `cart-routes.test.ts` — callback style, `done()` always called (buggy, matches production auth bypass)
2. `reservations.test.ts` — async style, `return reply.code(401)` (correct)
3. `admin-auth.test.ts` — tests real middleware via dynamic import (best)

The cart-routes mock replicated the production SEC-F03 bug: after sending 401, it still called `done()`, causing the route handler to execute with `customerId` undefined.

**Fix:** Created a shared auth mock factory with two exports:
- `createRequireAuthMock(customerId)` — async preHandler that returns after 401 (correct short-circuit)
- `createOptionalAuthMock(customerId?)` — async preHandler that optionally sets customerId

Both support static string or function-returning-string for the customerId parameter (useful when tests mutate the value between cases).

**Key design:** Uses `return reply.code(401).send(...)` on the 401 path, which correctly prevents the route handler from executing. The JSDoc explains why `return` is critical and references SEC-F03.

**Future work:** Migrate existing test files to use these factories instead of inline mocks.

---

## TST-L01 [LOW] — Turbo cache may mask stale test results

**File:** `turbo.json`

**Problem:** `globalDependencies` only included `.env`. Changes to `packages/domain/prisma/schema.prisma` would not invalidate the Turbo test cache, potentially serving stale test results after schema changes.

**Fix:** Added `"packages/domain/prisma/schema.prisma"` to the `globalDependencies` array.

**Tagged with:** `// [AUDIT FIX TST-L01]` comment in turbo.json (JSONC supported by Turbo 2.x).

---

## Coverage Gap Analysis

**File created:** `docs/audit/fix-log/phase-1-coverage-gaps.md`

Documented which packages have tests, which have zero tests, and identified critical paths needing coverage. Key findings:

- **Zero tests:** `apps/admin` (23 source files), `packages/domain` (12 source files), `packages/ui` (20 source files)
- **Security-critical gaps:** auth middleware direct test, cart IDOR/ownership, withCustomerId rejection, reservation concurrency
- **Estimated total effort:** 35-56 hours to reach meaningful coverage across all gaps

---

## Files Changed

| File | Change |
|---|---|
| `sonar-project.properties` | Replaced blanket coverage exclusions with minimal set |
| `.github/workflows/ci.yml` | Added `pnpm audit --audit-level=high` step |
| `apps/api/src/__tests__/helpers/auth-mock.ts` | NEW — shared auth mock factory |
| `turbo.json` | Added `schema.prisma` to globalDependencies |
| `docs/audit/fix-log/phase-1-sonar-ci.md` | NEW — this fix log |
| `docs/audit/fix-log/phase-1-coverage-gaps.md` | NEW — coverage gap analysis |
