# Architecture Notes -- Extracted from Audit
> These notes capture architectural knowledge discovered during the full-system
> audit (2026-03-18) that is not documented elsewhere in the codebase.
> Generated: 2026-03-19

---

## Architecture Decisions Discovered

### 1. Redis as Single Point of Failure
Redis serves seven distinct roles: sessions, rate limiting, query/embedding cache,
WhatsApp state (session, debounce, agent lock), abandoned cart tracking,
intelligence sorted sets (co-purchase, global scores, recently-viewed), and
review-prompt scheduling. There is no circuit breaker or graceful degradation on
the critical paths (session store, WhatsApp session resolution, OTP rate limiting).
Redis failure = total system outage for auth, chat, and WhatsApp channels.

Non-critical paths (query cache, embedding cache, analytics rate limit) do
degrade gracefully via try/catch fallback.

### 2. NATS Core vs JetStream Gap
Docker Compose enables JetStream (`--jetstream --store_dir /data`) with a
persistent `nats_data` volume, but application code explicitly uses Core NATS
(fire-and-forget). This means the JetStream infrastructure cost (disk, memory)
is paid but never used. Events published during deploys, restarts, or subscriber
crashes are permanently lost. A Redis-backed outbox was added post-audit for
`order.placed` and `reservation.created` only; all other events remain lossy.

### 3. Cascade-to-Restrict Change on TimeSlot Relations
The audit discovered that `TimeSlot -> Reservation` and `TimeSlot -> Waitlist`
used `onDelete: Cascade`, meaning deleting a time slot silently destroyed all
confirmed reservations. This was changed to `onDelete: Restrict` so that the
application must explicitly handle slot deletion (check for active reservations
first). This is a load-bearing schema decision that must not be reverted.

### 4. Three-Layer customerId Defense Model
Authorization for customer-scoped operations flows through three layers, all of
which must be correct:
1. **Auth middleware** (`requireAuth`) -- validates JWT, sets `request.customerId`
2. **Tool registry** (`withCustomerId`) -- injects `ctx.customerId` into tool input,
   always overriding any LLM-supplied value (post-audit fix)
3. **Domain service** (`assertOwnership`) -- verifies the customerId on the
   entity matches the caller

The audit found all three layers were broken pre-remediation. Post-fix, the
tool registry always overrides with `ctx.customerId`, and `requireAuth` returns
before `done()` on 401.

### 5. Cart Ownership via `assertCartOwnership`
Cart tools now use `assertCartOwnership()` on all five guest cart operations
(get, add, update, remove, apply_coupon). This was added post-audit because
Medusa Store API authenticates only via publishable API key (no session cookie),
meaning any cartId was accessible without ownership verification.

### 6. Reservation TOCTOU Fix: SELECT FOR UPDATE
The reservation creation race condition (check availability outside transaction,
increment inside) was fixed by moving the availability check inside the
`$transaction` block with `SELECT FOR UPDATE` on the TimeSlot row. This ensures
serialized access to the counter. A `CHECK (reserved_covers >= 0)` and
`CHECK (reserved_covers <= max_covers)` DB constraint migration was also created
(pending manual execution in staging).

---

## Pattern Recommendations

### Shared `assertOwnership` Utility
The codebase uses ownership checks in multiple places (reservation service,
order service, cart tools) with slightly different patterns. A shared utility
`assertOwnership(entityOwnerId, callerId, entityLabel)` exists in the domain
service but should be promoted to a cross-cutting concern importable by tools
and routes directly.

### Circuit Breaker for Redis
Redis failure handling is inconsistent: cache modules degrade gracefully, but
session store and WhatsApp session crash the request. Recommended pattern:
circuit breaker that trips after N consecutive failures, returns fallback for
non-critical paths, and fast-fails for critical paths with a user-facing error
instead of a hung request.

### BullMQ Instead of setInterval for Background Jobs
All four background jobs (abandoned-cart-checker, no-show-checker,
review-prompt-poller, reservation-reminder) use `setInterval`. Post-audit, an
`isRunning` guard was added, but `setInterval` still lacks: distributed locking
(unsafe with horizontal scaling), persistent job state, retry with backoff,
dead-letter handling, and observability. BullMQ (Redis-backed) would address all
of these and integrates naturally with the existing Redis infrastructure.

### Rate Limiter Atomicity
Hand-rolled rate limiters in auth.ts, whatsapp-webhook.ts, and analytics.ts use
a non-atomic `INCR` + conditional `EXPIRE` pattern. If the process crashes
between the two commands, the key persists forever without TTL. Recommended
pattern: Lua script or `SET key 1 EX ttl NX` + `INCR` to ensure TTL is always
set atomically. The `@fastify/rate-limit` plugin is NOT affected (uses its own
internal store).

### Content Type Parser Scoping
Stripe and WhatsApp webhook routes replace Fastify's global content type parsers
(`application/json` and `application/x-www-form-urlencoded` respectively).
Post-audit, these were scoped to webhook routes only via `fastify.register()`
with prefix encapsulation.

---

## Cross-Cutting Concerns

### Authorization Model
- **Customers:** Twilio Verify WhatsApp OTP -> JWT (httpOnly cookie, 4h expiry post-audit)
- **Admin:** `x-admin-key` header (timing-safe comparison) + server-side Next.js middleware (post-audit)
- **Guests:** Anonymous sessions in Redis (48h TTL), promoted to customer at checkout
- **Staff:** Same OTP flow as customers; differentiated by role, not auth provider
- JWT has no revocation mechanism; stolen tokens valid until expiry. Redis-based
  revocation list recommended before handling sensitive operations (refunds, account changes).

### Observability Gaps
- **Health check** was a static 200 OK; post-audit it pings Redis, Postgres, NATS,
  and Typesense with individual timeouts
- **Sentry DSN** is optional; if unset, all errors are silently dropped with no
  external alerting. A startup warning was added post-audit.
- **No distributed tracing** -- request flow across API -> Medusa -> Typesense ->
  Redis is not correlated
- **Background job errors** were swallowed by `.catch()` and not reported to Sentry;
  post-audit they are logged but still not Sentry-captured
- **NATS subscriber errors** are logged but have no alerting surface

### Deployment Architecture (Post-Audit State)
- Dockerfiles created for API, Web, and Admin (multi-stage builds)
- `docker-compose.prod.yml` created with Redis auth, `trustProxy` config
- No CD pipeline -- deployment is manual with no audit trail or rollback
- Terraform defines only AWS provider (24 lines); zero resources (VPC, RDS,
  ElastiCache, ECS, ALB all undefined)
- Admin API key supports rotation (array of valid keys, zero-downtime swap)

### Startup Ordering Constraint
NATS subscribers MUST be registered before background jobs start. Post-audit, the
startup sequence was fixed: `startCartIntelligenceSubscribers()` now runs before
`startNoShowChecker()`, `startReviewPromptPoller()`, and `startAbandonedCartChecker()`.
The original order caused events published by initial job checks (on server restart)
to be lost because subscribers were not yet listening.

---

## Scorecard Context

Scores from the audit, for future reference on areas of relative strength/weakness:

| Area | Score (1-10) | Key Driver |
|------|-------------|------------|
| Architecture | 7 | Clean monorepo, good domain separation, well-designed event system |
| Code Quality | 6 | Strong typing, Zod validation; marred by auth bypass bugs (now fixed) |
| Security | 3 | IDOR on carts + reservations, auth bypass, no CSP, rate limit bypass (mostly fixed) |
| Performance | 5 | N+1 queries in availability check, no caching strategy for hot paths |
| Observability | 4 | Sentry exists but health check was fake, no distributed tracing |
| AI Safety | 3 | No runtime validation, LLM-controllable IDs, no cost controls (mostly fixed) |
| Data Model | 5 | Good schema design; cascade deletes dangerous (fixed), dual-field migration incomplete |
| Documentation | 5 | CLAUDE.md and design docs good but drifted from implementation (updated post-audit) |
| Developer Experience | 7 | Excellent CLI (`ibx`), Turbo orchestration, Docker Compose |

**Post-remediation score: 62/100** (up from 28/100). Suitable for controlled
soft launch; deployment infra and event durability need further work before
high-traffic production use.

---

## Event Inventory (Dead Events)

These NATS events are published but have zero subscribers. They exist as
`[AUDIT-REVIEW]` markers in code for future subscriber implementation:

| Dead Event | Publisher | Future Purpose |
|------------|----------|----------------|
| `cart.item_added` | `add-to-cart.ts`, `reorder.ts` | Cart analytics pipeline |
| `order.refunded` | `stripe-webhook.ts` | Refund intelligence, profile updates |
| `order.disputed` | `stripe-webhook.ts` | Dispute alerts, profile updates |
| `order.canceled` | `stripe-webhook.ts` | Cancellation profile updates |
| `review.submitted` | `submit-review.ts` | Review analytics pipeline |
| `whatsapp.message.received` | `whatsapp-webhook.ts` | WhatsApp channel analytics |
| `whatsapp.message.sent` | `whatsapp-webhook.ts` | WhatsApp channel analytics |
| `product.indexed` | Commerce subscribers | Informational (no consumer needed) |
| `web.*` (33 event types) | `analytics.ts` | ClickHouse consumer (Phase 3) |

The `order.refunded`, `order.disputed`, and `order.canceled` events are the
highest priority for subscriber implementation -- they represent financial
operations with no intelligence capture.

---

## Service Communication Flow

```
                                 +------------------+
                                 |   PostHog Cloud  |
                                 | (client-side JS) |
                                 +--------+---------+
                                          ^
                                          | posthog.capture()
+-----------+     +-----------+     +-----+------+     +-------------+
| WhatsApp  |     | Browser   |     |  Next.js   |     |  Admin      |
| (Twilio)  |     | (Web)     |     |  Web App   |     |  Next.js    |
+-----+-----+     +-----+-----+     |  :3000     |     |  :3002      |
      |                 |           +-----+------+     +------+------+
      | webhook         | API            | SSR/API          | API
      v                 v                v                  v
+-----+-----+     +----+---------+-+----+------+-+---------+----+
|            |     |                                             |
|  Fastify API  (:9000)                                         |
|  - Chat/SSE routes                                            |
|  - Cart/Checkout routes                                       |
|  - Reservation routes                                         |
|  - Webhook handlers (Stripe, Twilio)                          |
|  - Admin API routes (x-admin-key)                             |
|  - Background jobs (setInterval)                              |
|                                                               |
+---+------+------+------+------+------+------+------+---------+
    |      |      |      |      |      |      |      |
    v      v      v      v      v      v      v      v
  Redis  Postgres NATS  Medusa Typesense Anthropic OpenAI Twilio
  :6379  :5433   :4222  :9000  :8108    (cloud)  (cloud) (cloud)
                        (Medusa
                         port
                         :9000)
```

Key notes:
- Medusa runs on the same port (:9000) as the API in Docker Compose but as a
  separate container; the API proxies to it via `MEDUSA_URL`
- Redis serves seven roles (see "Redis as SPOF" above)
- NATS has JetStream enabled in Docker but unused by application code
- Typesense is the sole search backend; no fallback to Medusa product list
- Anthropic (Claude) is the sole LLM provider; 60s timeout post-audit
- OpenAI is used only for embeddings; falls back to deterministic hash vectors

---

## Already Documented Elsewhere (Skipped)

The following knowledge is already well-covered in existing docs and was NOT
duplicated here:

- **Bounded contexts and entity definitions** -- `docs/design/bounded-contexts.md`
- **Domain model and Prisma schema** -- `docs/design/domain-model.md`
- **Agent tool registry and tool specs** -- `docs/design/agent-tools.md`
- **Use cases by channel** -- `docs/design/use-cases.md`
- **Customer intelligence and recommendation rules** -- `docs/design/customer-intelligence.md`
- **Redis key patterns and TTLs** -- `docs/ops/redis-memory.md` (updated post-audit)
- **Analytics event taxonomy and dashboards** -- `docs/analytics-dashboards.md`
- **NATS event catalogue with subscriber mapping** -- `docs/design/domain-model.md`
- **CLI commands** -- `docs/ibx-cli.md`
- **Hard rules (allergens, prices, config, text)** -- `CLAUDE.md`
