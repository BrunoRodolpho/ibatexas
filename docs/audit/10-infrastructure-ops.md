# 10 Audit: Infrastructure, Config & Operational Readiness

## Executive Summary

The IbateXas API has solid foundations — Zod-based env validation at startup, 127.0.0.1-scoped Docker ports, structured Pino logging, and a Sentry integration. However, **the system is not production-ready**. There is no Dockerfile, no container orchestration (ECS/K8s), and Terraform only defines a provider with no resources. The health check is a static 200 OK that checks zero dependencies. Graceful shutdown skips Redis and Prisma, and the Anthropic Claude API — the most latency-sensitive call — has no timeout or circuit breaker. These gaps mean deployments will lose events, health probes will lie, and a single OpenAI/Anthropic outage will hang user requests indefinitely.

**Critical count:** 4 | **High count:** 5 | **Medium count:** 5 | **Low count:** 3

---

## Scope

- Docker Compose service topology and security
- API server startup sequence and graceful shutdown
- Environment variable validation
- Health check completeness
- Timeout audit across all external service clients
- Single points of failure and dependency mapping
- Sentry/observability integration
- Production deployment readiness (Terraform, Dockerfiles, CI/CD)
- Connection pooling and resource management
- Structured logging
- Background job lifecycle

---

## System Invariants (Must Always Be True)

| # | Invariant | Status |
|---|-----------|--------|
| 1 | Server starts only when all required env vars are set | PASS — Zod schema in `config.ts` exits on failure |
| 2 | Graceful shutdown never loses in-flight requests | FAIL — Redis, Prisma not closed; in-flight NATS handlers not drained |
| 3 | Every external call has a timeout | FAIL — Anthropic, OpenAI embeddings, Twilio have no timeout |
| 4 | Single service failure degrades but doesn't crash | PARTIAL — Redis error handler nulls the client (see redis-auditor) |
| 5 | Health check reflects actual system health | FAIL — Returns static `{ status: "ok" }` |

---

## Assumptions That May Be False

| # | Assumption | Reality | Evidence | Impact |
|---|-----------|---------|----------|--------|
| 1 | "Health check tells orchestrator the truth" | `/health` returns 200 OK even when Postgres, Redis, NATS, Typesense, or Medusa are down | `apps/api/src/routes/health.ts:8-14` — no dependency checks | Load balancer routes traffic to a broken instance; cascading failures |
| 2 | "Graceful shutdown closes all connections" | Shutdown only stops jobs + closes NATS + Fastify. Redis and Prisma connections are leaked. | `apps/api/src/index.ts:34-41` — no `closeRedisClient()`, no `prisma.$disconnect()` | Connection pool exhaustion on frequent deploys; dangling connections to Postgres |
| 3 | "JetStream is enabled for NATS" | Docker runs `--jetstream` flag but application code explicitly uses Core NATS (fire-and-forget) | `packages/nats-client/src/index.ts:4` comment: "Uses Core NATS, not JetStream" | Every event published during a restart window is permanently lost |
| 4 | "All external calls have timeouts" | Medusa has 10s, Typesense has 10s, estimate-delivery has 5s. Anthropic, OpenAI embeddings, and Twilio have zero timeout. | See Timeout Audit below | Anthropic API stall → SSE stream hangs forever → memory leak + user sees spinner |
| 5 | "Terraform is ready for production" | Terraform defines only provider + region. Zero resources (no VPC, RDS, ElastiCache, ECS, ALB) | `infra/terraform/environments/dev/main.tf` — 24 lines, provider only | Production deployment is entirely undefined |
| 6 | "Reservation reminders are being sent" | `startReservationReminder()` is defined but NEVER called in `index.ts` | `apps/api/src/index.ts` — only imports no-show, review-prompt, abandoned-cart | Customers never receive day-of reservation reminders |
| 7 | "Redis reconnects after errors" | Error handler sets `redis = null`, but this fights the library's built-in reconnect logic | `packages/tools/src/redis/client.ts:16-18` | Transient network blip → client nulled → next call creates new connection → old connection reconnects in background → resource leak |

---

## Dependency Map

| Service | Required? | Failure Impact | Timeout | Circuit Breaker | Fallback |
|---------|-----------|---------------|---------|----------------|----------|
| PostgreSQL (Prisma) | Yes | Total outage — auth, reservations, intelligence all fail | None (Prisma default) | No | None |
| Redis | Yes | Cart sessions, agent memory, query cache, embeddings cache — all fail | None (node-redis default) | No | None |
| Medusa (Commerce) | Yes | Cart, checkout, product catalog — all fail | 10s (`AbortSignal.timeout`) | No | None |
| Typesense (Search) | Yes for search | Product search fails | 10s (`connectionTimeoutSeconds`) | No | None — search returns error |
| NATS | Soft | Events lost but no crash (publish catches errors) | Default | No | `console.error` + continue |
| Anthropic (Claude) | Yes for agent | Agent chat hangs indefinitely | **NONE** | No | Error message after stream failure |
| OpenAI (Embeddings) | Soft | Falls back to deterministic hash embedding | **NONE** | No | `generateDeterministicEmbedding()` — semantically meaningless vectors |
| Twilio (WhatsApp) | Soft | Notifications fail silently | **NONE** (Twilio SDK default) | No | Console stub if `TWILIO_WHATSAPP_NUMBER` not set |
| Sentry | No | Errors not reported | N/A | N/A | `console.error` fallback |
| PostHog | No (client-side) | Analytics not collected | N/A | N/A | None needed |

---

## Findings

### INFRA-01 [C] — Health Check Is a Lie: Returns 200 OK Without Checking Any Dependency

**Evidence:** `apps/api/src/routes/health.ts:8-14`
```typescript
server.get("/health", ..., async () => {
  return {
    status: "ok",
    version,
    timestamp: new Date().toISOString(),
  };
});
```

Zero dependency checks. No Redis ping, no Postgres query, no NATS connection status, no Medusa reachability, no Typesense health.

**Blast Radius:** Any orchestrator (ECS, K8s, or even a simple load balancer) that uses this endpoint will route traffic to an instance that cannot serve requests. Users get 500 errors despite the health check saying "ok".

**Time to Failure:** Immediate on any dependency outage. Postgres connection drops → health still says OK → traffic continues to broken instance.

**Production Simulation:** Kill Redis container → `curl /health` → still returns `200 { "status": "ok" }` → all cart, session, and cache operations fail with 500.

**Recommendation:** Implement deep health check that pings all critical dependencies with individual timeouts:
```typescript
// Redis: redis.ping()
// Postgres: prisma.$queryRaw`SELECT 1`
// NATS: check natsConn !== null && !natsConn.isClosed()
// Typesense: client.health.retrieve()
// Medusa: fetch(MEDUSA_URL + "/health", { signal: AbortSignal.timeout(3000) })
```

---

### INFRA-02 [C] — No Timeout on Anthropic Claude API — Agent Chat Can Hang Indefinitely

**Evidence:** `packages/llm-provider/src/agent.ts:147-153`
```typescript
stream = client.messages.stream({
  model,
  system: systemPrompt,
  messages,
  tools: TOOL_DEFINITIONS,
  max_tokens: AGENT_MAX_TOKENS,
  // ← No timeout, no AbortSignal
})
```

The Anthropic SDK's `messages.stream()` call has no timeout configured. The Anthropic SDK does have a `timeout` option, but it's not set here.

**Blast Radius:** Each agent chat uses an SSE connection. If Anthropic is slow or stalls, the SSE stream stays open indefinitely. Combined with the unbounded `Map` for SSE streams (from ai-agent-auditor findings), this leads to memory exhaustion under load or during Anthropic incidents.

**Time to Failure:** Next Anthropic API degradation event. Anthropic has had multiple incidents in 2024-2025 where streaming responses stalled for 30+ seconds.

**Production Simulation:** Anthropic returns first text chunk, then stalls → SSE stream stays open → user sees loading spinner forever → Fastify never sends response → connection leaked.

**Recommendation:** Set explicit timeout on the Anthropic client:
```typescript
_client ??= new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 60_000, // 60s max per request
})
```

---

### INFRA-03 [C] — No Timeout on OpenAI Embeddings API Call

**Evidence:** `packages/tools/src/embeddings/client.ts:18-25`
```typescript
const response = await fetch(`${baseUrl}/embeddings`, {
  method: "POST",
  headers: { ... },
  body: JSON.stringify({ model, input: text }),
  // ← No AbortSignal.timeout(), no signal at all
})
```

The `fetch()` call to OpenAI has no timeout. This is a synchronous dependency for product indexing and semantic search.

**Blast Radius:** If OpenAI API stalls, every search query that triggers an embedding generation hangs. Product reindexing (`ibx db reindex`) hangs. The deterministic fallback is only used when the API call *fails*, not when it hangs.

**Time to Failure:** Next OpenAI API degradation.

**Recommendation:** Add `signal: AbortSignal.timeout(10_000)` to the fetch call.

---

### INFRA-04 [C] — No Dockerfile, No Container Orchestration — Production Deployment Undefined

**Evidence:**
- `find . -name "Dockerfile*"` → no results
- No Kubernetes manifests, no ECS task definitions
- `infra/terraform/environments/dev/main.tf` defines only the AWS provider (24 lines, zero resources)
- Terraform remote state backend is commented out
- `docs/next-steps.md` does not mention deployment infrastructure

The entire production deployment pipeline is missing. There is no way to build or deploy this application to any environment.

**Blast Radius:** The application cannot be deployed. This is a total blocker for production launch.

**Recommendation:** At minimum:
1. Create multi-stage Dockerfile for API (`apps/api`) and Web (`apps/web`)
2. Define Terraform modules for VPC, RDS (Postgres), ElastiCache (Redis), ECS/Fargate tasks
3. Set up CI/CD pipeline for automated deployment
4. Configure managed NATS (or switch to SNS/SQS for AWS-native)
5. Configure Typesense Cloud or self-hosted on ECS

---

### INFRA-05 [H] — Graceful Shutdown Leaks Redis and Prisma Connections

**Evidence:** `apps/api/src/index.ts:34-41`
```typescript
const shutdown = async (): Promise<void> => {
  stopNoShowChecker();
  stopReviewPromptPoller();
  stopAbandonedCartChecker();
  await closeNatsConnection();
  await server.close();
  process.exit(0);
  // ← No closeRedisClient()
  // ← No prisma.$disconnect()
};
```

The shutdown handler stops background jobs and closes NATS, but never closes Redis or Prisma connections.

**Blast Radius:** On every deployment/restart, stale connections accumulate on Postgres and Redis. With frequent deploys, this can exhaust connection pools.

**Time to Failure:** After ~50-100 deploys without connection pool limits. In development, masked by Docker container restarts.

**Recommendation:**
```typescript
const shutdown = async (): Promise<void> => {
  stopNoShowChecker();
  stopReviewPromptPoller();
  stopAbandonedCartChecker();
  await closeNatsConnection();
  await server.close();
  await closeRedisClient();  // Add
  await prisma.$disconnect(); // Add
  process.exit(0);
};
```

---

### INFRA-06 [H] — NATS Shutdown Uses close() Instead of drain() — In-Flight Messages Lost

**Evidence:** `packages/nats-client/src/index.ts:129-135`
```typescript
export async function closeNatsConnection(): Promise<void> {
  if (natsConn) {
    await natsConn.close()  // ← Should be drain()
    natsConn = null
    pendingConnection = null
  }
}
```

`close()` immediately terminates the connection. `drain()` waits for in-flight subscriptions to process their pending messages before closing. With 10+ active subscribers (cart-intelligence alone has 10 subscriptions), any messages being processed at shutdown time are silently dropped.

**Blast Radius:** During deployment, any NATS messages in-flight (order.placed processing, review.prompt scheduling, etc.) are lost. Combined with Core NATS (no persistence), these events are gone forever.

**Time to Failure:** Every deployment. If an `order.placed` event is being processed (copurchase scores, profile updates), the operation is interrupted mid-way — potentially leaving partial data.

**Recommendation:** Replace `close()` with `drain()`:
```typescript
await natsConn.drain() // Waits for subscriptions to finish, then closes
```

---

### INFRA-07 [H] — NATS pendingConnection Reset in finally Block Creates Race Condition

**Evidence:** `packages/nats-client/src/index.ts:65-71`
```typescript
try {
  natsConn = await pendingConnection
  // ...
  return natsConn
} catch (error) {
  pendingConnection = null
  throw error
} finally {
  pendingConnection = null  // ← Runs on BOTH success and failure
}
```

The `finally` block sets `pendingConnection = null` even on success. If caller A's `await pendingConnection` resolves and sets `natsConn`, then the `finally` runs and clears `pendingConnection`. Meanwhile caller B arrives after `natsConn` is set but before `finally` runs — this is fine because `natsConn` check succeeds first. However, if caller B arrives between `pendingConnection` assignment (line 28) and `natsConn` assignment (line 35), and `pendingConnection` is cleared by caller A's `finally`, caller B will start a duplicate connection attempt.

**Blast Radius:** Duplicate NATS connections on cold start with concurrent requests. Each connection creates its own subscription set, leading to duplicate event processing.

**Time to Failure:** Server cold start under concurrent load (e.g., multiple health check probes + user requests arriving simultaneously).

**Recommendation:** Remove the `finally` block — the `catch` block already handles the error case:
```typescript
try {
  natsConn = await pendingConnection
  return natsConn
} catch (error) {
  pendingConnection = null
  throw error
}
// Don't clear pendingConnection on success — it's harmless and prevents races
```

---

### INFRA-08 [H] — Reservation Reminder Job Is Defined But Never Started

**Evidence:** `apps/api/src/index.ts:1-8` — imports only 3 jobs:
```typescript
import { startNoShowChecker, stopNoShowChecker } from "./jobs/no-show-checker.js";
import { startReviewPromptPoller, stopReviewPromptPoller } from "./jobs/review-prompt-poller.js";
import { startAbandonedCartChecker, stopAbandonedCartChecker } from "./jobs/abandoned-cart-checker.js";
// ← No import of startReservationReminder
```

The file `apps/api/src/jobs/reservation-reminder.ts` defines `startReservationReminder()` and `stopReservationReminder()`, but neither is imported nor called anywhere in the codebase.

**Blast Radius:** Customers with confirmed reservations never receive WhatsApp reminders on the day of their reservation. This is a user experience and business impact — no-shows may increase because customers forget.

**Time to Failure:** Already failing — has never worked.

**Recommendation:** Import and start in `index.ts`:
```typescript
import { startReservationReminder, stopReservationReminder } from "./jobs/reservation-reminder.js";
// In start():
startReservationReminder();
// In shutdown:
stopReservationReminder();
```

---

### INFRA-09 [H] — No Timeout on Twilio API Calls

**Evidence:** `apps/api/src/whatsapp/client.ts:121`
```typescript
await client.messages.create({ from, to, body });
// ← Twilio SDK uses default HTTP timeout (no explicit limit set)
```

The Twilio SDK's default timeout varies by version and can be very long (up to 120s). In the context of a NATS subscriber handler, a Twilio stall blocks the entire handler chain.

**Blast Radius:** If Twilio API is slow, reservation reminders, abandoned cart notifications, and review prompts all stall. Since NATS subscribers process messages serially, one slow Twilio call blocks all subsequent messages.

**Recommendation:** Configure Twilio client timeout:
```typescript
_client = twilio(sid, auth, { timeout: 10_000 });
```

---

### INFRA-10 [M] — Config Validation Missing Critical Env Vars

**Evidence:** `apps/api/src/config.ts:7-42` — The Zod schema validates:
- Server: NODE_ENV, PORT, LOG_LEVEL
- Medusa: MEDUSA_URL, MEDUSA_API_KEY, MEDUSA_PUBLISHABLE_KEY
- Admin: ADMIN_API_KEY
- Auth: JWT_SECRET, TWILIO_*
- Payments: STRIPE_*
- CORS: WEB_URL, CORS_ORIGIN
- Restaurant: RESTAURANT_TIMEZONE, NO_SHOW_GRACE_MINUTES

**Missing from validation:**
- `ANTHROPIC_API_KEY` — the primary AI API key (agent will fail on first chat)
- `DATABASE_URL` — Prisma connection string (server crashes on first DB query)
- `REDIS_URL` — Redis connection (all cache/session operations fail)
- `NATS_URL` — NATS connection (events silently fail)
- `TYPESENSE_HOST`, `TYPESENSE_API_KEY` — search client (search fails)
- `OPENAI_API_KEY` — embeddings (falls back to meaningless deterministic vectors)

**Blast Radius:** The server starts successfully but fails on first use of unchecked services. For `DATABASE_URL`, Prisma reads it at module import time from `process.env` — a missing value may cause a confusing error much later.

**Recommendation:** Add all required env vars to the Zod schema, or at minimum add `DATABASE_URL` and `ANTHROPIC_API_KEY`.

---

### INFRA-11 [M] — Sentry DSN Is Optional — Errors Silently Dropped in Production

**Evidence:** `apps/api/src/index.ts:11-16`
```typescript
if (process.env.SENTRY_DSN) {
  Sentry.init({ ... });
}
```

And in `apps/api/src/errors/handler.ts:25,44`:
```typescript
Sentry.captureException(error);
```

If `SENTRY_DSN` is not set, `Sentry.init()` is never called, but `Sentry.captureException()` is still called in the error handler — it's a no-op when not initialized. This means all 500 errors and MedusaRequestErrors are silently dropped with no external alerting.

**Blast Radius:** In production without Sentry configured, the only error visibility is server logs. No alerting, no error grouping, no stack traces.

**Recommendation:** Either make `SENTRY_DSN` required in production (add to Zod schema with production-only requirement) or add a startup warning.

---

### INFRA-12 [M] — Docker Redis Has No Authentication

**Evidence:** `docker-compose.yml:24-39` — Redis service has no `command` override to set a password, no `requirepass` configuration.

```yaml
redis:
  image: redis:7-alpine
  ports:
    - "127.0.0.1:6379:6379"
  # ← No --requirepass, no redis.conf
```

`REDIS_URL` in `.env.example` is `redis://localhost:6379` (no password).

**Blast Radius:** In development, mitigated by 127.0.0.1 binding. In production, if the same pattern is replicated, Redis is wide open. Given that Redis stores session tokens, customer profiles, and cart data, this is a data exposure risk.

**Recommendation:** Add `command: ["redis-server", "--requirepass", "${REDIS_PASSWORD}"]` and update `REDIS_URL` to include credentials.

---

### INFRA-13 [M] — Prisma Connection Pool Not Configured

**Evidence:** `packages/domain/src/client.ts:8-12`
```typescript
export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["warn", "error"],
    // ← No connection pool configuration
  })
```

Prisma defaults to a connection pool of `num_cpus * 2 + 1`. There's no `connection_limit` in `DATABASE_URL` and no `datasources` override.

**Blast Radius:** Under load, Prisma may open more connections than the Postgres instance can handle (especially on a small RDS instance). Each background job (no-show checker, review poller) also triggers Prisma queries, competing with API request handlers.

---

### INFRA-14 [M] — No Request Timeout on Fastify Server

**Evidence:** `apps/api/src/server.ts:17-25`
```typescript
const server = Fastify({
  logger: { ... },
  // ← No connectionTimeout, requestTimeout, or keepAliveTimeout
})
```

Fastify defaults: `connectionTimeout` = 0 (disabled), `requestTimeout` = 0 (disabled). A slow client can hold a connection open indefinitely.

**Blast Radius:** Under load or during a slowloris-style attack, connections accumulate until the server runs out of file descriptors.

**Recommendation:** Set explicit timeouts:
```typescript
const server = Fastify({
  connectionTimeout: 30_000,
  requestTimeout: 60_000,
  keepAliveTimeout: 72_000,
  ...
})
```

---

### INFRA-15 [L] — Docker Compose .env Values Hardcoded as Defaults in .env.example

**Evidence:** `.env.example:15-19`
```
POSTGRES_USER=ibatexas
POSTGRES_PASSWORD=ibatexas
POSTGRES_DB=ibatexas
DATABASE_URL=postgresql://ibatexas:ibatexas@localhost:5433/ibatexas
```

Default password is the app name. While `.env.example` is explicitly for local dev, developers who copy it verbatim to staging/production expose the database.

---

### INFRA-16 [L] — No Log Rotation or Size Limits for Pino Output

**Evidence:** `apps/api/src/server.ts:19-23` — In production, Pino writes JSON to stdout with no transport. There's no log rotation, size limit, or external log drain configured.

If deployed to a VM or container without log rotation, log files grow unbounded.

---

### INFRA-17 [L] — Terraform Remote State Backend Is Commented Out

**Evidence:** `infra/terraform/environments/dev/main.tf:11-18`
```hcl
# backend "s3" {
#   bucket         = "ibatexas-terraform-state"
#   key            = "dev/terraform.tfstate"
#   ...
# }
```

State is stored locally. If Terraform is ever used, state will be lost on machine change or by a different team member.

---

## Cross-Agent Findings

| Source | Finding | Reference |
|--------|---------|-----------|
| redis-auditor | Redis singleton TOCTOU race on cold start — two callers can create two clients | Confirmed: same pattern as NATS (INFRA-07) |
| redis-auditor | Error handler sets `client=null` on ANY error, fighting reconnection | Confirmed: `packages/tools/src/redis/client.ts:16-18` |
| redis-auditor | 6 Redis key patterns have no TTL — unbounded memory growth | Cross-referenced: affects infra capacity planning |
| events-auditor | NATS Core fire-and-forget — events lost on restart | Confirmed: docker enables JetStream but code uses Core (INFRA-06 related) |
| events-auditor | No job overlap guard on setInterval jobs | Confirmed: abandoned-cart-checker `setInterval` has no "isRunning" guard |
| events-auditor | Graceful shutdown calls close() instead of drain() | Confirmed as INFRA-06 |
| events-auditor | F-01: JetStream enabled in Docker but unused — wasted volume + memory overhead | Confirmed: `docker-compose.yml:64` uses `--jetstream --store_dir /data` with persistent `nats_data` volume, but `packages/nats-client/src/index.ts` uses only Core NATS. Either complete the JetStream migration or remove the flag + volume. |
| events-auditor | F-07: Startup ordering — jobs start before NATS subscribers are registered | Confirmed: `apps/api/src/index.ts:52-55` — `startNoShowChecker()` (line 52), `startReviewPromptPoller()` (line 53), `startAbandonedCartChecker()` (line 54) all run before `await startCartIntelligenceSubscribers()` (line 55). No-show checker and review-prompt poller both run an immediate initial check that publishes NATS events (`reservation.no_show`, `review.prompt`), but the subscribers for those events aren't registered yet. Events published during this window are lost (Core NATS, no persistence). |
| ai-agent-auditor | Unbounded SSE streams Map — memory exhaustion | Confirmed: no cap on concurrent streams, combined with no Anthropic timeout (INFRA-02) makes this worse |

---

## Summary of Findings by Severity

| Severity | Count | IDs |
|----------|-------|-----|
| Critical | 4 | INFRA-01, INFRA-02, INFRA-03, INFRA-04 |
| High | 5 | INFRA-05, INFRA-06, INFRA-07, INFRA-08, INFRA-09 |
| Medium | 5 | INFRA-10, INFRA-11, INFRA-12, INFRA-13, INFRA-14 |
| Low | 3 | INFRA-15, INFRA-16, INFRA-17 |
