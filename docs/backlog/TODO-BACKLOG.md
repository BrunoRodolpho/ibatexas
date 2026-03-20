# 📋 IbateXas Pre-Launch Backlog

> Single source of truth for all remaining work
> Generated: 2026-03-19
> Sources: Codebase TODOs, audit deferred items, CLAUDE.md fixes, architecture notes

## Summary

- Total items: 33
- P0 (launch blockers): 5
- P1 (pre-launch): 10
- P2 (post-launch): 13
- P3 (nice to have): 5

---

## 🔴 P0 — Launch Blockers

### Infrastructure

- **INF-001** CD Pipeline — Deploy Workflow
  - Source: Audit deferred item EVT-F01 / INFRA-04
  - Description: Dockerfiles exist for API, Web, Admin but no GitHub Actions deploy workflow. Cannot deploy without some form of CD. Create a deploy workflow that builds images and deploys to target environment with rollback capability.
  - Effort: M (1-2 weeks)
  - Type: Infrastructure

### Data

- **DAT-001** Apply Pending DB Migration — CHECK Constraints on TimeSlots
  - Source: Audit deferred — `packages/domain/prisma/migrations/20260318_audit_fix_check_constraints/migration.sql`
  - Description: Adds `CHECK (reserved_covers >= 0)` and `CHECK (reserved_covers <= max_covers)` on `ibx_domain.time_slots`. Run pre-check first: `SELECT * FROM ibx_domain.time_slots WHERE reserved_covers < 0 OR reserved_covers > max_covers;`
  - Effort: XS (< 1hr)
  - Type: Infrastructure

- **DAT-002** Apply Pending DB Migration — Review productId Backfill
  - Source: Audit deferred — `packages/domain/prisma/migrations/20260318_audit_fix_review_product_id_backfill/migration.sql`
  - Description: Backfills `product_id` from `product_ids[1]` where `product_id IS NULL`. Non-destructive. After applying, plan deprecation of `productIds` array field.
  - Effort: XS (< 1hr)
  - Type: Infrastructure

- **DAT-003** Apply Pending DB Migration — startTime VarChar(5) Constraint
  - Source: Audit deferred
  - Description: Requires `prisma db push` or new migration to apply the VarChar constraint. Pre-check: `SELECT * FROM ibx_domain.time_slots WHERE length(start_time) > 5;`
  - Effort: XS (< 1hr)
  - Type: Infrastructure

- **DAT-004** Transition from `prisma db push` to `prisma migrate`
  - Source: Audit unclear item DL-F09
  - Description: No migration history, no audit trail, no rollback currently. Run `prisma migrate dev --name baseline` on a fresh dev database and switch workflow before production. This is a process change requiring team coordination.
  - Effort: S (1-4hr)
  - Type: Infrastructure

---

## 🟠 P1 — Pre-Launch (Should Fix)

### Security

- **SEC-001** Verify Guest Checkout for Cash Orders
  - Source: Audit unclear item SEC-F09 — `apps/api/src/routes/` checkout paths
  - Description: `POST /api/cart/checkout` uses `optionalAuth`. Guest users can checkout without phone verification. Card payments are validated by Stripe; cash/PIX orders may have less validation. Confirm if this is intentional business logic. If yes, document. If no, add `requireAuth` to cash checkout path.
  - Effort: S (1-4hr)
  - Type: Bug

- **SEC-002** Prompt Injection Defense for Tool Parameters
  - Source: Audit strategic insight — `packages/llm-provider/src/tool-registry.ts`
  - Description: `withCustomerId` protects identity but there are no guards against prompt injection influencing tool parameters like `cartId`, `orderId`, or `reservationId`. Add server-side guardrails that validate tool parameter ownership before execution.
  - Effort: M (1-2 days)
  - Type: Security

- **SEC-003** Rate Limiter Atomicity Fix
  - Source: Audit strategic insight — `apps/api/src/routes/auth.ts`, `whatsapp-webhook.ts`, `analytics.ts`
  - Description: Hand-rolled rate limiters use non-atomic `INCR` + conditional `EXPIRE` pattern. If process crashes between commands, key persists forever without TTL. Fix: use Lua script or `SET key 1 EX ttl NX` + `INCR` to ensure TTL is always set atomically. `@fastify/rate-limit` plugin is NOT affected.
  - Effort: S (1-4hr)
  - Type: Bug

- **SEC-004** JWT Revocation Mechanism
  - Source: Audit strategic insight — `apps/api/src/routes/auth.ts`
  - Description: JWT has no revocation mechanism; stolen tokens are valid until 4h expiry. Add Redis-based revocation list before handling sensitive operations (refunds, account changes).
  - Effort: M (1-2 days)
  - Type: Security

### Testing

- **TST-001** E2E Test Suite — Golden Path
  - Source: Audit deferred item TST-H03
  - Description: Zero Playwright/Cypress E2E tests. At minimum, create golden-path E2E for: Browse → Cart → Checkout and WhatsApp → Agent → Order. Would catch integration bugs like the missing x-admin-key header.
  - Effort: L (3-5 days)
  - Type: Test

- **TST-002** Make `pnpm audit` Blocking in CI
  - Source: Audit strategic insight — CI config
  - Description: `pnpm audit` step in CI currently uses `|| true` (non-blocking). Make it blocking once existing advisories are resolved.
  - Effort: XS (< 1hr)
  - Type: Infrastructure

### Infrastructure

- **INF-002** SAST / Secret Scanning in CI
  - Source: Audit deferred item TST-H01
  - Description: Only `pnpm audit` exists (non-blocking). No CodeQL, Semgrep, or Gitleaks. Add at least CodeQL GitHub Action for static analysis.
  - Effort: S (1-2 days)
  - Type: Infrastructure

- **INF-003** Prisma Connection Pool Config
  - Source: Audit strategic insight
  - Description: Prisma defaults to `num_cpus * 2 + 1` connections. Background jobs compete with API handlers. Add `connection_limit` and `pool_timeout` to `DATABASE_URL` before scaling.
  - Effort: XS (< 1hr)
  - Type: Infrastructure

### Authentication

- **AUTH-001** Refresh Token Flow
  - Source: `apps/api/src/routes/auth.ts:132`
  - Description: `// TODO: Implement refresh token flow for better UX` — currently JWT expires after 4h with no silent refresh. Users must re-authenticate via OTP.
  - Effort: M (1-2 days)
  - Type: Feature

### Documentation

- **DOC-001** ~~Fix CLAUDE.md Inaccuracies~~ ✅ DONE
  - Source: CLAUDE-MD-DELTA.md
  - Description: Applied during post-audit cleanup: fixed 4 inaccuracies (commerce CJS claim, eslint-config exception, CLI command list, Where Things Live table), added 4 missing sections (workspace packages, Medusa v2, service ports, backlog reference), removed `docs/audit/` reference.
  - Effort: XS (< 1hr)
  - Type: Documentation

---

## 🟡 P2 — Post-Launch

### NATS / Events

- **EVT-001** Full JetStream Migration
  - Source: Audit deferred EVT-F01, `packages/nats-client/src/index.ts:6`
  - Description: Redis outbox covers `order.placed` and `reservation.created` only. All other events use NATS Core fire-and-forget. Events lost during deploys. Docker already enables JetStream; code needs to use it.
  - Effort: L (2-3 weeks)
  - Type: Refactor

- **EVT-002** Add Subscriber for `order.refunded`
  - Source: `apps/api/src/routes/stripe-webhook.ts:86`
  - Description: `// TODO: [AUDIT-REVIEW]` — Update customer profile and analytics when order is refunded. Highest priority dead event (financial).
  - Effort: S (1-4hr)
  - Type: Feature

- **EVT-003** Add Subscriber for `order.disputed`
  - Source: `apps/api/src/routes/stripe-webhook.ts:115`
  - Description: `// TODO: [AUDIT-REVIEW]` — Trigger alerts and update customer profile on dispute. Financial event with no intelligence capture.
  - Effort: S (1-4hr)
  - Type: Feature

- **EVT-004** Add Subscriber for `order.canceled`
  - Source: `apps/api/src/routes/stripe-webhook.ts:150`
  - Description: `// TODO: [AUDIT-REVIEW]` — Update customer profile on cancellation.
  - Effort: S (1-4hr)
  - Type: Feature

- **EVT-005** Add Subscriber for `review.submitted`
  - Source: `packages/tools/src/intelligence/submit-review.ts:44`
  - Description: `// TODO: [AUDIT-REVIEW]` — Review analytics pipeline consumer.
  - Effort: S (1-4hr)
  - Type: Feature

- **EVT-006** Add Subscriber for `cart.item_added`
  - Source: `packages/tools/src/cart/add-to-cart.ts:29`, `packages/tools/src/cart/reorder.ts:60`
  - Description: `// TODO: [AUDIT-REVIEW]` — Cart analytics pipeline consumer. Same event published from two sources.
  - Effort: S (1-4hr)
  - Type: Feature

### Resilience

- **RES-001** Circuit Breaker for Redis
  - Source: Audit strategic insight — `packages/tools/src/redis/client.ts`
  - Description: Redis serves 7 roles with no circuit breaker. Session store and WhatsApp session crash on failure. Add circuit breaker that trips after N failures, returns fallback for non-critical paths, fast-fails for critical paths.
  - Effort: M (1-2 days)
  - Type: Refactor

- **RES-002** BullMQ Migration from setInterval
  - Source: Audit strategic insight — `apps/api/src/` job files
  - Description: All 4 background jobs use `setInterval` with `isRunning` guard. Lacks distributed locking (unsafe with horizontal scaling), persistent state, retry, dead-letter. BullMQ integrates with existing Redis.
  - Effort: L (3-5 days)
  - Type: Refactor

### Domain

- **DOM-001** Staff Model Implementation
  - Source: Audit deferred — `docs/design/bounded-contexts.md` section 5
  - Description: Staff entity defined in design docs but has no Prisma schema, no OTP auth flow, no role differentiation. Admin currently uses API key only.
  - Effort: M (1 week)
  - Type: Feature

### Architecture

- **ARCH-001** Authorization Layer Extraction
  - Source: Audit strategic insight
  - Description: Auth checks scattered across middleware, tool wrappers, and domain services with different patterns. Extract shared `assertOwnership(entityOwnerId, callerId, entityLabel)` as cross-cutting concern.
  - Effort: M (1-2 days)
  - Type: Refactor

### Observability

- **OBS-001** Distributed Tracing
  - Source: Audit strategic insight
  - Description: Request flow across API → Medusa → Typesense → Redis is not correlated. No tracing headers, no request IDs across service boundaries.
  - Effort: M (1-2 days)
  - Type: Feature

- **OBS-002** Background Job Sentry Integration
  - Source: Audit strategic insight — `apps/api/src/` job files
  - Description: Background job errors are logged but not captured by Sentry. Add Sentry capture for job failures.
  - Effort: S (1-4hr)
  - Type: Bug

### Performance

- **PERF-001** Co-Purchase Sorted Set Pruning
  - Source: Audit strategic insight
  - Description: Co-purchase sorted sets grow O(n²) per order. Have 30-day TTL but at high volume, add periodic `ZREMRANGEBYRANK` to keep only top-50 per product.
  - Effort: S (1-4hr)
  - Type: Refactor

---

## 🟢 P3 — Nice to Have

### Infrastructure

- **INF-004** Terraform Infrastructure as Code
  - Source: Audit deferred INFRA-04
  - Description: Terraform defines only AWS provider (24 lines). Zero resources. Depends on deployment target — if using PaaS (Railway/Render), Terraform may not be needed.
  - Effort: XL (1+ week)
  - Type: Infrastructure

- **INF-005** Log Rotation
  - Source: Audit deferred INFRA-16
  - Description: Only relevant for VM deployments. Container orchestrators handle this.
  - Effort: S (1-4hr)
  - Type: Infrastructure

### Data

- **DAT-005** Query Cache Hit Count Race Condition
  - Source: Audit unclear item REDIS-L01 — `query-cache.ts`
  - Description: `incrementQueryCacheHits` uses GET + modify + SET (non-atomic). Analytics-only impact. Acceptable at current scale.
  - Effort: XS (< 1hr)
  - Type: Bug

- **DAT-006** SCAN Memory Accumulation Optimization
  - Source: Audit unclear item REDIS-L02
  - Description: Cache invalidation SCAN loads all keys into array before batch delete. Monitor post-launch; if >5k cache keys, refactor to delete-during-scan.
  - Effort: S (1-4hr)
  - Type: Refactor

### Frontend

- **FE-001** Wishlist Feature Integration
  - Source: `apps/web/src/components/molecules/WishlistButton.tsx:1`
  - Description: `// TODO: Wire into ProductCard and PDP when wishlist feature ships` — WishlistButton component exists but is not integrated.
  - Effort: S (1-4hr)
  - Type: Feature

---

## By Category

| Category | P0 | P1 | P2 | P3 | Total |
|----------|----|----|----|----|-------|
| Infrastructure | 1 | 3 | 0 | 2 | 6 |
| Data | 3 | 0 | 0 | 2 | 5 |
| Security | 0 | 4 | 0 | 0 | 4 |
| Testing | 0 | 2 | 0 | 0 | 2 |
| NATS/Events | 0 | 0 | 6 | 0 | 6 |
| Resilience | 0 | 0 | 2 | 0 | 2 |
| Domain | 0 | 0 | 1 | 0 | 1 |
| Architecture | 0 | 0 | 1 | 0 | 1 |
| Observability | 0 | 0 | 2 | 0 | 2 |
| Performance | 0 | 0 | 1 | 0 | 1 |
| Authentication | 0 | 1 | 0 | 0 | 1 |
| Documentation | 0 | 1 | 0 | 0 | 1 |
| Frontend | 0 | 0 | 0 | 1 | 1 |
| **Total** | **5** | **10** | **13** | **5** | **33** |

## Effort Estimation

| Priority | XS | S | M | L | XL | Total |
|----------|----|----|---|---|------|-------|
| P0 | 3 | 1 | 1 | 0 | 0 | 5 |
| P1 | 3 | 3 | 3 | 1 | 0 | 10 |
| P2 | 0 | 6 | 4 | 2 | 0 | 12+1 |
| P3 | 1 | 2 | 0 | 0 | 1 | 4+1 |

**Estimated total effort for P0 + P1:** ~3-5 weeks (1 engineer)
**Estimated total effort for P2:** ~6-8 weeks (1 engineer)
