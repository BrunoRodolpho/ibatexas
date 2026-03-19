# 00 — MASTER AUDIT REPORT

**System:** IbateXas — AI-Powered Brazilian Smoked House Platform
**Date:** 2026-03-18
**Auditors:** 10-agent parallel team (Claude Opus 4.6)
**Scope:** Full-system production readiness audit
**Total Findings:** 115 (17 Critical, 27 High, 36 Medium, 35 Low)

---

## 1. Executive Summary

IbateXas is a TypeScript monorepo comprising a Next.js storefront, Fastify API, Medusa v2 commerce backend, Claude AI agent with 26 tools, WhatsApp integration (Twilio), and a standalone admin panel. The architecture is ambitious and well-designed — domain-driven structure, Zod validation everywhere, proper event-driven patterns via NATS, and a comprehensive CLI toolchain.

**However, the system is NOT production-ready.** The audit found 17 critical-severity issues spanning security (cross-user impersonation, auth bypass), data integrity (overbooking race condition, cascade deletes), infrastructure (no deployment config, fake health check, no timeouts on LLM calls), and quality assurance (tests that encode bugs, coverage metrics that exclude 80% of code).

**Production Readiness Score: 28/100**
**Health Score: 3/10**

### Verdict: ❌ NOT PRODUCTION-READY

The system has strong foundations but critical gaps in authorization, data safety, and operational infrastructure that would cause real-world failures within hours of launch.

---

## 2. Launch Decision (Kill Switch)

### Would you ship this today? **NO**

### Minimum fixes required before launch:

1. **Fix `withCustomerId` to always use session context** — 1-line change, prevents cross-user impersonation (Tools + AI Agent)
2. **Fix `requireAuth` to return before `done()`** — prevents unauthenticated side effects (Security)
3. **Add cart ownership validation** — bind cartId to session, prevent IDOR (Tools)
4. **Move reservation availability check inside transaction** — prevent overbooking (Data Layer)
5. **Change TimeSlot→Reservation cascade to Restrict** — prevent silent reservation deletion (Data Layer)
6. **Add `x-admin-key` header to admin `apiFetch()`** — make admin panel functional (Frontend + Security)
7. **Add Anthropic/OpenAI timeout + AbortSignal** — prevent infinite hangs (Infrastructure)
8. **Implement real health check** — check Redis, Postgres, NATS, Medusa (Infrastructure)
9. **Create Dockerfile + basic deployment config** — currently cannot deploy (Infrastructure)
10. **Add TTL to 6 unbounded Redis key patterns** — prevent memory exhaustion (Redis)

**Estimated effort for minimum-viable launch:** 2-3 weeks with a senior engineer.

---

## 3. Top 3 Architectural Risks

### Risk 1: Systemic IDOR — No Object-Level Authorization
The system lacks a consistent authorization layer. Cart tools accept any cartId without ownership checks. Reservation tools trust LLM-supplied customerIds. The `requireAuth` middleware doesn't actually stop execution. There is no shared authorization utility — each tool implements (or doesn't implement) its own checks.
- **Impact:** Any user can read/modify any other user's cart or reservations
- **Likelihood:** HIGH — exploitable today via prompt injection or direct API calls
- **Mitigation:** Implement a shared `assertOwnership(objectId, userId)` utility used by all tools and routes

### Risk 2: Redis as Unprotected Single Point of Failure
Redis handles sessions, rate limiting, caching, WhatsApp state, agent locks, and abandoned cart tracking — but has no circuit breaker, no fallback, and 6 key patterns with no TTL. The client singleton has a TOCTOU race and fights its own reconnection logic. Redis failure = complete system outage (not graceful degradation).
- **Impact:** Redis down → no auth, no chat, no WhatsApp, no rate limiting
- **Likelihood:** MEDIUM — Redis is reliable but any network blip triggers the broken error handler
- **Mitigation:** Circuit breaker pattern, graceful degradation for non-critical paths, fix client singleton

### Risk 3: AI Agent with Insufficient Hard Guards
The AI agent can invoke 26 tools with no runtime input validation (Zod schemas are sent to Claude but not enforced server-side). The `withCustomerId` wrapper trusts LLM input. There are no per-user cost limits. The system prompt has no anti-injection guardrails. The only thing preventing abuse is Claude's training — no programmatic safety net.
- **Impact:** Prompt injection → cross-user data access, unbounded API spend
- **Likelihood:** HIGH — prompt injection is a known attack vector with no mitigation
- **Mitigation:** Always override LLM-supplied IDs with session context, add Zod runtime validation in `executeTool`, add per-session spend caps

---

## 4. Scorecard

| Area | Score (1-10) | Notes |
|------|-------------|-------|
| Architecture | 7 | Clean monorepo structure, good domain separation, well-designed event system |
| Code Quality | 6 | Strong typing, Zod validation, consistent patterns. Marred by auth bypass bugs |
| Security | 3 | IDOR on carts + reservations, auth bypass, no CSP, rate limit bypass |
| Performance | 5 | N+1 queries, no caching strategy for hot paths, TOCTOU race conditions |
| Observability | 4 | Sentry exists but health check is fake, no distributed tracing, partial logging |
| AI Safety | 3 | No runtime validation, LLM-controllable customerIds, no cost controls, no prompt guardrails |
| Data Model | 5 | Good schema design, but cascade deletes dangerous, dual-field migration incomplete |
| Documentation | 5 | CLAUDE.md is good, design docs exist but drift from implementation |
| Developer Experience | 7 | Excellent CLI (`ibx`), good test count, Turbo orchestration, Docker Compose |

---

## 5. Top 10 Critical Issues

| # | Finding | Source | Blast Radius | Time to Failure |
|---|---------|--------|-------------|-----------------|
| 1 | **Cross-user impersonation via withCustomerId** — LLM can operate on any customer's reservations | AI Agent F-01, Tools C-01 | All reservation customers | Immediate (prompt injection) |
| 2 | **Cart IDOR — any session can read/modify any cart** — Medusa publishable key has no session binding | Tools C-02 | All shopping customers | Immediate (direct API call) |
| 3 | **TOCTOU overbooking race** — availability check outside transaction | Data Layer F-01 | Restaurant operations | First busy night |
| 4 | **No deployment infrastructure** — zero Dockerfiles, empty Terraform, no CD pipeline | Infra INFRA-04 | Entire system | Launch blocker |
| 5 | **Health check is a lie** — returns 200 without checking any dependency | Infra INFRA-01 | All users (orchestrator routes to dead instances) | First dependency failure |
| 6 | **Admin panel non-functional** — missing x-admin-key header + no server-side auth | Security F-01, Frontend C1/H3 | All admin operations | Immediate |
| 7 | **Cascade delete destroys reservations** — deleting a TimeSlot silently removes all confirmed reservations | Data Layer F-02 | Reservation customers | First admin slot edit |
| 8 | **6 Redis key patterns with no TTL** — unbounded memory growth (copurchase O(n²) per order) | Redis C-01 | Infrastructure (Redis OOM) | Days to weeks |
| 9 | **Anthropic API has no timeout** — stalled LLM call hangs SSE stream forever | Infra INFRA-02 | Chat users + server memory | First API stall |
| 10 | **NATS Core fire-and-forget** — events permanently lost during deploys | Events F-01 | Intelligence pipeline, review prompts, cart nudges | Every deploy |

---

## 6. Violated System Invariants (Collected Across All Agents)

| Invariant | Status | Agent |
|-----------|--------|-------|
| Authenticated users cannot access other users' data | ❌ VIOLATED | Security, AI Agent, Tools |
| AI agent cannot access other customers' data | ❌ VIOLATED | AI Agent, Tools |
| No tool can create a $0 order | ⚠️ UNGUARDED | Tools |
| Background jobs never overlap | ❌ VIOLATED | Events |
| Events during deployment are not lost | ❌ VIOLATED | Events |
| Health check reflects actual system health | ❌ VIOLATED | Infra |
| Every external call has a timeout | ❌ VIOLATED | Infra |
| Graceful shutdown never loses in-flight requests | ❌ VIOLATED | Infra |
| Coverage numbers reflect actual quality | ❌ VIOLATED | Testing |
| All critical paths have test coverage | ❌ VIOLATED | Testing |
| Prices are always integer centavos | ✅ HOLDS | Data Layer, Tools |
| Allergens are always explicit arrays | ✅ HOLDS | Data Layer, Tools |
| All Redis keys use rk() | ✅ HOLDS | Redis |
| Tests never hit real services | ✅ HOLDS | Testing |
| Stripe payments are never double-processed | ✅ HOLDS | WhatsApp |
| Duplicate webhooks never cause duplicate processing | ✅ HOLDS | WhatsApp |

---

## 7. Quick Wins (High ROI)

| Fix | Effort | Impact | Files |
|-----|--------|--------|-------|
| Fix `withCustomerId` to use `ctx.customerId` | 30 min | Eliminates cross-user impersonation | `packages/llm-provider/src/tool-registry.ts:112-125` |
| Change TimeSlot→Reservation to `onDelete: Restrict` | 10 min | Prevents silent reservation deletion | `packages/domain/prisma/schema.prisma:97` |
| Add `x-admin-key` to admin `apiFetch()` | 15 min | Makes admin panel functional | `apps/admin/src/lib/api.ts` |
| Fix `requireAuth` to `return` before `done()` | 15 min | Stops unauthenticated side effects | `apps/api/src/middleware/auth.ts:44-51` |
| Add `AbortSignal.timeout(30000)` to Anthropic client | 15 min | Prevents infinite SSE hangs | `packages/llm-provider/src/agent.ts:147` |
| Add TTL to copurchase sorted sets | 20 min | Prevents O(n²) memory growth | `packages/tools/src/intelligence/` |
| Add `isRunning` guard to setInterval jobs | 20 min | Prevents duplicate job runs | `apps/api/src/jobs/*.ts` |
| Fix debounce/lock key mismatch | 15 min | Prevents concurrent agent runs | `apps/api/src/whatsapp/session.ts` |

---

## 8. Full Issue List

### Critical (17)
| ID | Finding | Agent |
|----|---------|-------|
| SEC-F01 | Admin frontend never sends x-admin-key header | Security |
| SEC-XF04 | withCustomerId allows cross-user impersonation | Security (cross-agent) |
| AI-F01 | withCustomerId passes LLM-supplied customerId unchecked | AI Agent |
| DL-F01 | TOCTOU race condition in reservation creation | Data Layer |
| DL-F02 | Cascade delete from TimeSlot destroys reservations | Data Layer |
| RED-C01 | 6 key patterns have no TTL (unbounded growth) | Redis |
| TOOL-C01 | withCustomerId bypass confirmed across 5 reservation tools | Tools |
| TOOL-C02 | Cart tools have no ownership verification (IDOR) | Tools |
| FE-C1 | Admin panel has zero server-side auth | Frontend |
| FE-C2 | CSP allows unsafe-eval in both apps | Frontend |
| EVT-F01 | NATS Core fire-and-forget — events lost on deploy | Events |
| TST-C01 | SonarCloud exclusions hide ~80% of codebase | Testing |
| TST-C02 | Tests explicitly validate impersonation as correct | Testing |
| TST-C03 | requireAuth mock replicates production auth bypass | Testing |
| INF-01 | Health check returns 200 without checking dependencies | Infra |
| INF-02 | Anthropic Claude API has no timeout | Infra |
| INF-04 | No Dockerfile, no container orchestration, empty Terraform | Infra |

### High (27)
Security: requireAuth doesn't stop execution (F-03), rate limit bypass via sessionId (F-04), admin panel client-side auth only (F-02)
AI Agent: No LLM cost controls (F-03), unbounded SSE streams Map (F-04), 2 tools lack Zod validation (F-02)
WhatsApp: Lock/debounce key mismatch (H-01), silent message loss (H-02)
Data Layer: Review dual-field inconsistency (F-03), reservedCovers no CHECK constraint (F-04)
Redis: Client singleton TOCTOU race (H-01/H-02), lock/debounce mismatch confirmed (H-03)
Tools: reorder leaks cross-user data via admin API (H-01), no $0 order guard (H-02)
Frontend: PostHog localStorage (H1), error boundaries leak raw errors (H2), admin apiFetch missing header (H3)
Events: No job overlap guard (F-02), abandoned cart false positives (F-03), 9+ dead events (F-04)
Testing: No security scanning (H-01), zero tests for admin/domain (H-02), no integration/E2E tests (H-03)
Infra: OpenAI embeddings no timeout (INFRA-03), graceful shutdown incomplete (INFRA-05), Sentry misses background job errors (INFRA-07)

### Medium (36) and Low (35)
See individual audit reports (01-10) for full details.

---

## 9. Failure Mode Analysis

| Failure | Impact | Current Handling | Missing Safeguards |
|---------|--------|-----------------|-------------------|
| **API server down** | All frontend + WhatsApp dead | None — no health check, no multi-instance | Real health check, deployment config, auto-restart |
| **Redis down** | Auth broken, chat broken, WhatsApp broken, rate limits gone | Error handler nulls client (makes it worse) | Circuit breaker, graceful degradation, fix error handler |
| **Medusa down** | No cart/checkout/orders | 10s timeout, MedusaRequestError thrown | Circuit breaker, cached product data fallback |
| **NATS down** | Events lost, intelligence pipeline dead | Fire-and-forget (events silently dropped) | Upgrade to JetStream, retry queue, alerting |
| **Typesense down** | Search broken | 10s timeout, error swallowed in some tools | Fallback to Medusa product list, alert |
| **Anthropic API down** | Chat hangs forever | No timeout, no circuit breaker | AbortSignal timeout, fallback message, cost cap |
| **Stripe webhook fails** | Payment not processed | Idempotency key allows retry | Dead-letter queue, alerting on failed webhooks |
| **WhatsApp handler crash** | User gets no response | Partial try/catch (inner only) | Full try/catch with fallback message, alerting |
| **Deploy/restart** | Events lost, jobs interrupted | NATS close() (not drain), no job completion wait | Graceful drain, job completion signal, JetStream |

---

## 10. Golden Paths vs Edge Cases

### Golden Paths (must be flawless)
| Flow | Status | Blockers |
|------|--------|----------|
| Browse → Cart → Checkout → Payment | ⚠️ RISKY | Cart IDOR, no $0 order guard |
| WhatsApp → AI Agent → Order | ⚠️ RISKY | withCustomerId bypass, silent message loss |
| Reservation booking | ❌ BROKEN | TOCTOU overbooking, cascade delete, cross-user impersonation |
| Admin → Manage orders/products | ❌ BROKEN | Missing x-admin-key header, no server-side auth |
| Customer login (OTP) | ✅ WORKS | Solid Twilio integration, proper rate limiting |

### Edge Cases (must not break system)
| Scenario | Status |
|----------|--------|
| Concurrent reservation for last slot | ❌ Overbooking |
| Redis restart mid-session | ❌ Complete outage |
| Anthropic API timeout | ❌ Infinite hang |
| User sends 5 WhatsApp messages in 3s | ⚠️ Messages 2-5 may be lost |
| Admin deletes a time slot | ❌ All reservations silently destroyed |
| Deploy during peak hours | ❌ Events lost, jobs interrupted |

---

## 11. Prioritized 4-Week Action Plan

### Week 1: Stabilization (Critical Security + Data)
- [ ] Fix `withCustomerId` — always use `ctx.customerId`
- [ ] Fix `requireAuth` — return before `done()`
- [ ] Add cart ownership validation (bind cartId to session)
- [ ] Move reservation check inside transaction (fix TOCTOU)
- [ ] Change TimeSlot cascade to Restrict
- [ ] Add `x-admin-key` to admin apiFetch
- [ ] Remove SonarCloud blanket exclusions
- [ ] Add `pnpm audit` to CI

### Week 2: Infrastructure Hardening
- [ ] Create Dockerfile for API + Web + Admin
- [ ] Implement real health check (ping all dependencies)
- [ ] Add Anthropic/OpenAI/Twilio timeouts
- [ ] Fix Redis client singleton (TOCTOU + error handler)
- [ ] Add TTL to all 6 unbounded Redis key patterns
- [ ] Fix graceful shutdown (drain NATS, close Redis/Prisma)
- [ ] Add `isRunning` guard to all background jobs
- [ ] Fix debounce/lock key mismatch (use phoneHash for both)

### Week 3: Operational Readiness
- [ ] Upgrade NATS Core to JetStream for durable events
- [ ] Add server-side auth to admin panel (middleware.ts)
- [ ] Fix CSP (remove unsafe-eval)
- [ ] Add WhatsApp fallback message on async handler crash
- [ ] Add unprocessed message check after agent lock release
- [ ] Create basic CD pipeline (GitHub Actions → staging → production)
- [ ] Implement per-session LLM cost cap
- [ ] Add Zod runtime validation to executeTool

### Week 4: Quality & Monitoring
- [ ] Add authorization tests for all IDOR findings
- [ ] Add concurrency tests for reservation creation
- [ ] Add integration test for admin→API→Medusa flow
- [ ] Add abandoned cart TTL fix (check auth session vs guest)
- [ ] Add circuit breaker for Redis + Medusa
- [ ] Set up alerting for job failures, webhook errors, NATS disconnects
- [ ] Backfill Review.productId from productIds[0]
- [ ] Clean up dead NATS events (9+ with no subscriber)

---

## 12. Rewrite vs Refactor Decisions

| Component | Decision | Rationale |
|-----------|----------|-----------|
| `withCustomerId` wrapper | **Patch** (1-line) | Just override input with ctx.customerId |
| `requireAuth` middleware | **Patch** (5 lines) | Add return before done() |
| Admin panel auth | **Refactor** | Add server-side middleware.ts + proper OTP flow for staff |
| Redis client singleton | **Refactor** | Fix TOCTOU, fix error handler, add circuit breaker |
| NATS client | **Refactor** | Upgrade to JetStream, add retry queue |
| Health check | **Rewrite** | Current is 6 lines returning static 200; need dependency checks |
| SSE streaming emitter | **Refactor** | Add Map size limit, eviction, proper cleanup |
| Reservation service | **Refactor** | Move check+increment inside transaction, add DB-level CHECK |
| Background jobs | **Refactor** | Add isRunning guard, use proper job scheduler (BullMQ) |
| Test suite | **Refactor** | Fix broken mocks, add auth/IDOR/concurrency tests |
| Deployment | **Build from scratch** | No existing deployment infrastructure at all |

---

## 13. "If I Were CTO"

### Fix First (Week 1 — before ANY launch)
1. **withCustomerId bypass** — this is an active security vulnerability. 1-line fix.
2. **Cart IDOR** — anyone can modify anyone's cart. Must bind cartId to session.
3. **TOCTOU overbooking** — the first busy Friday night will double-book tables.
4. **Admin panel** — add the x-admin-key header so admins can actually manage the restaurant.

### Fix Before Scaling
5. **Deployment infrastructure** — you literally cannot deploy this to production today.
6. **Health checks** — without real health checks, every dependency failure cascades.
7. **LLM timeouts** — one Anthropic stall and your server runs out of memory.
8. **Redis hardening** — circuit breaker + TTLs + fix the singleton race.

### Ignore (For Now)
- CSP unsafe-eval — low exploitability given the attack surface
- Review dual-field migration — cosmetic impact on ratings, not blocking
- Dead NATS events — no subscribers means no side effects, just wasted publishes
- Turbo cache staleness — low probability, easy to force-rebuild

### Redesign (Next Quarter)
- **NATS → JetStream** — fire-and-forget is fundamentally wrong for order intelligence
- **Background jobs → BullMQ** — setInterval is not a job scheduler
- **Admin auth → proper Twilio OTP** — the dev stub needs to become real auth
- **Authorization layer** — extract a shared `assertOwnership()` used by all tools and routes
- **SonarCloud config** — remove blanket exclusions, accept lower numbers, set package-level thresholds

### The Bottom Line

This codebase has **excellent bones** — the architecture is clean, the domain model is well-designed, the AI tool system is thoughtful, and the developer experience (ibx CLI, Turbo, Docker Compose) is impressive. The problems are almost entirely in the **production-hardening layer**: authorization, deployment, observability, and edge case handling.

With 2-3 weeks of focused work on the Week 1+2 items above, this system could safely handle a soft launch. The AI agent architecture is genuinely innovative — the tool registry pattern, streaming SSE, and WhatsApp integration show strong technical vision.

The risk is not the code quality — it's the gap between "works in development" and "survives in production." Close that gap, and you have a compelling product.

---

## Appendix: Individual Audit Reports

| Report | File | Findings |
|--------|------|----------|
| 01 Security & Auth | [01-security-auth.md](01-security-auth.md) | 15 (1C, 3H, 5M, 6L) |
| 02 AI Agent & LLM | [02-ai-agent-llm.md](02-ai-agent-llm.md) | 10 (1C, 3H, 4M, 2L) |
| 03 WhatsApp & Webhooks | [03-whatsapp-webhooks.md](03-whatsapp-webhooks.md) | 12 (0C, 2H, 4M, 6L) |
| 04 Data Layer & Schema | [04-data-layer-schema.md](04-data-layer-schema.md) | 10 (2C, 2H, 3M, 3L) |
| 05 Redis & State | [05-redis-state-management.md](05-redis-state-management.md) | 9 (1C, 3H, 3M, 2L) |
| 06 Tool Implementations | [06-tool-implementations.md](06-tool-implementations.md) | 10 (2C, 3H, 3M, 2L) |
| 07 Frontend Architecture | [07-frontend-architecture.md](07-frontend-architecture.md) | 12 (2C, 3H, 3M, 4L) |
| 08 NATS Events & Jobs | [08-nats-events-jobs.md](08-nats-events-jobs.md) | 10 (1C, 3H, 4M, 2L) |
| 09 Testing & CI/CD | [09-testing-ci-cd.md](09-testing-ci-cd.md) | 10 (3C, 4H, 2M, 1L) |
| 10 Infrastructure & Ops | [10-infrastructure-ops.md](10-infrastructure-ops.md) | 17 (4C, 5H, 5M, 3L) |

---

*Audit conducted by a 10-agent parallel team using Claude Opus 4.6 (1M context). All findings are evidence-based with exact file paths and line numbers. No code was modified during this audit.*
