# Audit Insights — Extracted Before Deletion

> Generated: 2026-03-19
> Source: 27 audit + fix-log files (to be deleted)
> Status: Pre-production system
> Original audit: 115 findings (17C, 27H, 36M, 35L) — 91 fixed, 12 documented, 12 deferred

---

## Deferred Work (Explicitly Postponed)

### NATS / Event Durability

- **EVT-F01 (partial)**: Full JetStream Migration
  - **Severity**: Critical (mitigated to High by Redis outbox)
  - **Original finding**: `08-nats-events-jobs.md` F-01
  - **Why deferred**: Redis-backed outbox covers `order.placed` and `reservation.created` only. All other events (`cart.abandoned`, `product.viewed`, `reservation.modified/cancelled/no_show`, `review.prompt`, `review.prompt.schedule`, `notification.send`) still use NATS Core fire-and-forget. Events lost during deploys.
  - **Pre-launch?**: NO (outbox covers the two most critical events; acceptable for soft launch)
  - **Estimated effort**: L (2-3 weeks)

### Testing

- **TST-H03**: End-to-End Test Suite (Playwright/Cypress)
  - **Severity**: High
  - **Original finding**: `09-testing-ci-cd.md` F-09-06
  - **Why deferred**: Requires browser test framework setup, test infrastructure, and stable deployment target. 1,521 unit tests exist but zero E2E.
  - **Pre-launch?**: DECIDE (golden-path E2E for Browse->Cart->Checkout and WhatsApp->Agent->Order would catch integration bugs like the missing x-admin-key header)
  - **Estimated effort**: L (2-3 weeks for core flows)

### CI/CD

- **TST-M08 / INFRA-04 (partial)**: Full CD Pipeline
  - **Severity**: High
  - **Original finding**: `09-testing-ci-cd.md` F-09-08, `10-infrastructure-ops.md` INFRA-04
  - **Why deferred**: Dockerfiles created (Phase 4), but no GitHub Actions deploy workflow. Manual deploys with no audit trail.
  - **Pre-launch?**: YES (blocker) — cannot deploy without some form of CD
  - **Estimated effort**: M (1-2 weeks)

### Infrastructure as Code

- **INFRA-04 (partial)**: Terraform Infrastructure
  - **Severity**: Critical (mitigated by Dockerfiles)
  - **Original finding**: `10-infrastructure-ops.md` INFRA-04
  - **Why deferred**: Terraform file defines only AWS provider (24 lines). Zero resources: no VPC, RDS, ElastiCache, ECS, ALB.
  - **Pre-launch?**: DECIDE (depends on deployment target — if using a PaaS like Railway/Render, Terraform may not be needed)
  - **Estimated effort**: XL (3-4 weeks for full AWS setup)

### Domain Model

- **Staff Model**: Staff Entity Not Implemented
  - **Severity**: Medium
  - **Original finding**: `04-data-layer-schema.md` F-06, `docs/design/bounded-contexts.md` section 5
  - **Why deferred**: Admin auth currently uses API key only. Staff model is defined in design docs but has no Prisma schema, no OTP auth flow, no role differentiation.
  - **Pre-launch?**: NO (API key auth is sufficient for initial admin access)
  - **Estimated effort**: M (1 week)

### Observability

- **INFRA-16**: Log Rotation
  - **Severity**: Low
  - **Original finding**: `10-infrastructure-ops.md` INFRA-16
  - **Why deferred**: Container orchestrators handle log rotation. Only relevant for VM deployments.
  - **Pre-launch?**: NO (handled by infrastructure)
  - **Estimated effort**: S

### Security Scanning

- **TST-H01**: SAST / Secret Scanning in CI
  - **Severity**: High
  - **Original finding**: `09-testing-ci-cd.md` F-09-07
  - **Why deferred**: `pnpm audit` added (non-blocking). No CodeQL, Semgrep, or Gitleaks yet.
  - **Pre-launch?**: DECIDE (pnpm audit covers dependency vulns; SAST is defense-in-depth)
  - **Estimated effort**: S (1-2 days to add CodeQL action)

---

## Unclear Status (Verify These)

- **SEC-F09**: Guest Checkout Without Identity Verification
  - **Original finding**: `01-security-auth.md` F-09
  - **What was reported**: `POST /api/cart/checkout` uses `optionalAuth` — guest users can complete checkout without phone verification. Card payments validated by Stripe; cash/PIX may have less validation.
  - **Why unclear**: No fix-log entry. Audit flagged it but said "verify this is intentional business logic." No explicit confirmation found.
  - **Action needed**: Confirm whether guest checkout for cash orders is intended. If yes, document. If no, add `requireAuth` to cash checkout path.

- **REDIS-L01**: Query Cache Hit Count Read-Modify-Write Race
  - **Original finding**: `05-redis-state-management.md` L-01
  - **What was reported**: `incrementQueryCacheHits` uses GET + modify + SET pattern. Concurrent cache hits lose counts.
  - **Why unclear**: Phase 2 fix-log explicitly defers this as "Low severity, analytics-only impact" but it was not formally documented as a conscious deferral.
  - **Action needed**: Grep for `hitCount++` in `query-cache.ts` — confirm it's analytics-only and acceptable.

- **REDIS-L02**: SCAN Accumulates All Keys in Memory
  - **Original finding**: `05-redis-state-management.md` L-02
  - **What was reported**: Cache invalidation SCAN loads all matching keys into an array before batch delete. Could be problematic at >10k cache keys.
  - **Why unclear**: Deferred with note "Acceptable at current scale (<200 products)" but no formal tracking.
  - **Action needed**: Monitor cache key count post-launch. If >5k keys, refactor to delete-during-scan.

- **SEC-XF01**: No Global Rate Limit on WhatsApp Customer Auto-Creation
  - **Original finding**: `01-security-auth.md` XF-01
  - **What was reported**: No global cap on unique-phone customer creation. A marketing broadcast reply storm could create thousands of DB rows/minute.
  - **Why unclear**: Phase 3 fix-log (WA-M04) added a 100/min rate limit on customer creation, which addresses this. But the cross-agent finding in `01-security-auth.md` is not explicitly cross-referenced.
  - **Action needed**: Verify `rk('ratelimit:customer:create')` exists in `whatsapp/session.ts` — if so, this is FIXED.

- **DL-F09**: Transition from `prisma db push` to `prisma migrate`
  - **Original finding**: `04-data-layer-schema.md` F-09
  - **What was reported**: No migration history, no audit trail, no rollback. Phase 4 documented a transition plan but it requires team coordination.
  - **Why unclear**: Process change documented but not yet executed. Current state is still `prisma db push`.
  - **Action needed**: Before production, run `prisma migrate dev --name baseline` on a fresh dev database and switch workflow.

---

## Pending DB Migrations

These 3 migrations were created during remediation but require **manual execution** after review:

1. **`packages/domain/prisma/migrations/20260318_audit_fix_check_constraints/migration.sql`**
   - Adds `CHECK (reserved_covers >= 0)` on `ibx_domain.time_slots`
   - Adds `CHECK (reserved_covers <= max_covers)` on `ibx_domain.time_slots`
   - **Risk**: Will fail if any existing row has `reserved_covers > max_covers` or `reserved_covers < 0`
   - **Pre-check**: `SELECT * FROM ibx_domain.time_slots WHERE reserved_covers < 0 OR reserved_covers > max_covers;`

2. **`packages/domain/prisma/migrations/20260318_audit_fix_review_product_id_backfill/migration.sql`**
   - Backfills `product_id` from `product_ids[1]` where `product_id IS NULL`
   - **Risk**: Low (non-destructive read-only backfill)
   - **After**: Plan deprecation of `productIds` array field

3. **Schema change: `startTime @db.VarChar(5)`**
   - Requires `prisma db push` or new migration to apply the VarChar constraint
   - **Risk**: Will fail if any existing `startTime` value exceeds 5 characters
   - **Pre-check**: `SELECT * FROM ibx_domain.time_slots WHERE length(start_time) > 5;`

---

## Strategic Insights Worth Preserving

### Architecture

- The codebase has strong domain-driven foundations. The `ibx` CLI, Turbo orchestration, Zod-everywhere validation pattern, and tool-registry design are genuinely well-engineered. The problems were almost entirely in the **production-hardening layer** (auth, deployment, observability, edge cases), not in architecture or code quality.

- The AI agent's 26-tool registry is the most innovative part of the system. The `withCustomerId` pattern (now fixed) and inline `ctx.customerId` checks form a dual-layer auth model at the tool boundary. Future tools MUST follow the `ctx.customerId` pattern — never trust LLM-supplied identity parameters.

### Event System Strategy

- The Redis-backed outbox is a pragmatic interim solution for NATS Core's fire-and-forget limitation. It covers `order.placed` and `reservation.created` — the two events where data loss has business impact. For full production reliability, JetStream migration is the right long-term path (the `--jetstream` flag is already enabled in Docker).

- 33+ web analytics NATS events were removed because they had zero subscribers. The analytics pipeline was a complete no-op (events published but never consumed). PostHog handles client-side analytics; if server-side analytics is needed, build the subscriber first, then re-add events.

- 5 events were kept with `[AUDIT-REVIEW]` tags as placeholders for future subscriber work: `cart.item_added`, `order.refunded`, `order.disputed`, `order.canceled`, `review.submitted`. These represent real business intelligence opportunities.

### Security Hardening Ideas

- **Authorization layer extraction**: The audit revealed auth checks scattered across middleware, tool wrappers, and domain services — with different patterns in each. A shared `assertOwnership(resourceId, userId, resourceType)` utility used consistently would prevent future IDOR regressions.

- **Prompt injection defense**: The system prompt has zero anti-injection guardrails. While `withCustomerId` no longer trusts LLM input for identity, there are no hard guards against prompt injection influencing tool parameters like `cartId`, `orderId`, or `reservationId`. Consider adding server-side guardrails that validate tool parameter ownership before execution.

- **Circuit breakers**: Redis, Medusa, and Typesense are all single-point dependencies with no circuit breaker. The health check now detects their failure, but the system doesn't gracefully degrade — it just returns errors. Adding circuit breakers (especially for Redis, which is the most critical) would improve resilience.

### Performance Considerations

- The N+1 query in `checkAvailability` was fixed (now 3 queries instead of 1 + 2*slots). But Prisma has no explicit connection pool config — it defaults to `num_cpus * 2 + 1`. Under load, background jobs compete with API handlers for connections. Add `connection_limit` and `pool_timeout` to `DATABASE_URL` before scaling.

- Co-purchase sorted sets grow O(n^2) per order (10 items = 90 ZINCRBY). Now have 30-day TTL, but at high order volume, consider periodic pruning with `ZREMRANGEBYRANK` to keep only top-50 co-purchased items per product.

### Test Strategy

- Coverage gap analysis (in `phase-1-coverage-gaps.md`) estimates 35-56 hours to reach meaningful coverage. Priority order: (1) auth middleware, (2) cart ownership, (3) reservation concurrency, (4) domain services, (5) commerce subscribers, (6) admin panel, (7) UI components. Items 1-3 were completed in Phase 3. Items 4-7 remain.

- The `pnpm audit` step in CI is currently non-blocking (`|| true`). Make it blocking once existing advisories are resolved.

---

## Handoff Notes

### For codebase verification (Agent 2B)

Items to verify exist in actual code:
- `assertCartOwnership()` in `packages/tools/src/cart/assert-cart-ownership.ts`
- `withCustomerId` always overrides with `ctx.customerId` in `packages/llm-provider/src/tool-registry.ts`
- `SELECT FOR UPDATE` in `packages/domain/src/services/reservation.service.ts` create()
- Deep health check pinging Redis, Postgres, NATS, Typesense in `apps/api/src/routes/health.ts`
- `isRunning` guard in all 3 job files: `no-show-checker.ts`, `review-prompt-poller.ts`, `abandoned-cart-checker.ts`
- Agent lock keyed by `phoneHash` (not `sessionId`) in `apps/api/src/whatsapp/session.ts`
- Redis client using promise-based mutex (not TOCTOU pattern) in `packages/tools/src/redis/client.ts`
- `onDelete: Restrict` on TimeSlot relations in `packages/domain/prisma/schema.prisma`
- Dockerfiles in `apps/api/Dockerfile`, `apps/web/Dockerfile`, `apps/admin/Dockerfile`
- `ANTHROPIC_API_KEY`, `DATABASE_URL`, `REDIS_URL`, `NATS_URL` in Zod config schema at `apps/api/src/config.ts`

### For spot-checks (Agent 2C)

Quick grep patterns to verify fix presence:
- `grep -r "AUDIT-FIX" apps/ packages/ --include="*.ts" | wc -l` — should return 40+ tagged fixes
- `grep -r "AUDIT-REVIEW" apps/ packages/ --include="*.ts"` — should return exactly 8 deferred items
- `grep -r "unsafe-eval" apps/web/next.config.mjs apps/admin/next.config.mjs` — should be conditional on NODE_ENV
- `grep "onDelete: Cascade" packages/domain/prisma/schema.prisma` — TimeSlot relations should NOT appear
- `grep "drain()" packages/nats-client/src/index.ts` — should find drain, NOT close()
- `grep "EXPIRE" apps/api/src/routes/auth.ts` — EXPIRE should be unconditional (not inside `if (count === 1)`)
