# Phase 2 Fix Log: Timeouts, Shutdown & Infrastructure Resilience

**Date:** 2026-03-18
**Scope:** Findings from audits 02 (AI Agent), 08 (NATS Events & Jobs), 10 (Infrastructure Ops)

---

## Fixes Applied

### INFRA-01 [CRITICAL] — Deep Health Check
**File:** `apps/api/src/routes/health.ts`
**Before:** Static `{ status: "ok" }` — no dependency checks.
**After:** Pings Redis, Postgres (Prisma), NATS, and Typesense with 3-second individual timeouts. Returns JSON with per-dependency status. HTTP 503 if critical dependencies (Redis, Postgres) fail; 200 with `"degraded"` if non-critical (NATS, Typesense) fail; 200 with `"healthy"` when all pass.

### INFRA-02 [CRITICAL] — Anthropic Client Timeout
**File:** `packages/llm-provider/src/agent.ts`
**Before:** No timeout on Anthropic SDK client — agent chat could hang indefinitely.
**After:** Added `timeout: 60_000` (60s) to the Anthropic client constructor options.

### INFRA-03 [CRITICAL] — OpenAI Embeddings Timeout
**File:** `packages/tools/src/embeddings/client.ts`
**Before:** No timeout on `fetch()` call to OpenAI embeddings API.
**After:** Added `signal: AbortSignal.timeout(10_000)` (10s) to the fetch call.

### INFRA-05 [HIGH] — Graceful Shutdown Connection Cleanup
**File:** `apps/api/src/index.ts`
**Before:** Shutdown handler only stopped jobs, closed NATS, and closed Fastify. Redis and Prisma connections leaked.
**After:** Shutdown order: (1) stop all background jobs, (2) drain NATS, (3) close Fastify, (4) close Redis via `closeRedisClient()`, (5) disconnect Prisma via `prisma.$disconnect()`.

### INFRA-06 [HIGH] — NATS drain() Instead of close()
**File:** `packages/nats-client/src/index.ts`
**Before:** `closeNatsConnection()` called `natsConn.close()` — drops in-flight messages.
**After:** Changed to `natsConn.drain()` — flushes pending publishes and drains subscriptions before closing.

### INFRA-07 [HIGH] — NATS pendingConnection Race Condition
**File:** `packages/nats-client/src/index.ts`
**Before:** `finally` block reset `pendingConnection = null` on both success and failure, creating a race window for concurrent callers during cold start.
**After:** Removed the `finally` block. The `catch` block handles the error case. On success, `pendingConnection` is harmless since `natsConn` is checked first.

### INFRA-08 [HIGH] — Reservation Reminder Job Started
**File:** `apps/api/src/index.ts`
**Before:** `startReservationReminder()` and `stopReservationReminder()` were defined in `apps/api/src/jobs/reservation-reminder.ts` but never imported or called.
**After:** Imported and wired into server startup and shutdown lifecycle.

### INFRA-09 [HIGH] — Twilio Client Timeout
**File:** `apps/api/src/whatsapp/client.ts`
**Before:** Twilio SDK created with default (potentially 120s) timeout.
**After:** Added `{ timeout: 10_000 }` (10s) to Twilio client constructor options.

### EVT-F02 [HIGH] — Job Overlap Guards
**Files:**
- `apps/api/src/jobs/no-show-checker.ts`
- `apps/api/src/jobs/review-prompt-poller.ts`
- `apps/api/src/jobs/abandoned-cart-checker.ts`

**Before:** `setInterval` jobs had no check for whether the previous invocation was still running. Under slow Redis/DB conditions, concurrent runs could cause duplicate NATS events and duplicate WhatsApp messages.
**After:** Added `let isRunning = false` guard to each job function. The function returns early if `isRunning === true`. The flag is reset in a `finally` block.

### AI-F04 [HIGH] — SSE Streams Map Size Limit
**File:** `apps/api/src/streaming/emitter.ts`
**Before:** `streams` Map grew unbounded — no maximum size limit.
**After:** Added `MAX_STREAMS = 1000` constant. `createStream()` throws an error (which surfaces as HTTP 503) if the limit is reached.

### INFRA-14 [MEDIUM] — Fastify Server Timeouts
**File:** `apps/api/src/server.ts`
**Before:** No `connectionTimeout`, `requestTimeout`, or `keepAliveTimeout` — defaults to 0 (disabled).
**After:** Added `connectionTimeout: 30_000`, `requestTimeout: 60_000`, `keepAliveTimeout: 72_000`.

---

## Summary

| Severity | Count | IDs |
|----------|-------|-----|
| Critical | 3 | INFRA-01, INFRA-02, INFRA-03 |
| High | 6 | INFRA-05, INFRA-06, INFRA-07, INFRA-08, INFRA-09, EVT-F02, AI-F04 |
| Medium | 1 | INFRA-14 |
| **Total** | **11** | |

## Not Addressed (Out of Scope)

- **INFRA-04 [C]** — Dockerfile / container orchestration / Terraform (deployment infrastructure)
- **INFRA-10 [M]** — Config validation for missing env vars
- **INFRA-11 [M]** — Sentry DSN optional in production
- **INFRA-12 [M]** — Docker Redis authentication
- **INFRA-13 [M]** — Prisma connection pool configuration
