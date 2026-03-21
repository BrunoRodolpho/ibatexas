# Architecture Decisions

> Load-bearing decisions that must not be reverted without understanding why they exist.

---

## Decisions

### 1. Redis Roles + Circuit Breaker

Redis serves seven roles: sessions, rate limiting, query/embedding cache,
WhatsApp state, abandoned cart tracking, intelligence sorted sets, and
review-prompt scheduling.

**Mitigated:** Circuit breaker (`packages/tools/src/redis/circuit-breaker.ts`)
trips after N consecutive failures. `safeRedis` wrapper: critical ops throw
`CircuitOpenError`, non-critical return null. Configurable via
`REDIS_CB_FAILURE_THRESHOLD` and `REDIS_CB_RESET_TIMEOUT_MS` env vars.

### 2. NATS Core vs JetStream

Docker Compose enables JetStream but application uses Core NATS (fire-and-forget).
Redis-backed outbox covers `order.placed` and `reservation.created` only.
Full JetStream migration is a post-launch item (EVT-001).

### 3. Cascade-to-Restrict on TimeSlot Relations

`TimeSlot -> Reservation` and `TimeSlot -> Waitlist` use `onDelete: Restrict`.
Deleting a time slot requires explicitly handling active reservations first.
**This is a load-bearing schema decision that must not be reverted.**

### 4. Three-Layer customerId Defense Model

1. **Auth middleware** (`requireAuth`) — validates JWT, sets `request.customerId`
2. **Tool registry** (`withCustomerId`) — injects `ctx.customerId`, always overriding LLM-supplied values
3. **Domain service** (`assertOwnership`) — verifies entity ownership matches caller

### 5. Reservation TOCTOU Fix

Availability check runs inside `$transaction` with `SELECT FOR UPDATE` on TimeSlot.
DB constraints: `CHECK (reserved_covers >= 0)` and `CHECK (reserved_covers <= max_covers)`.

### 6. Startup Ordering

NATS subscribers MUST register before background jobs start. Sequence:
`startCartIntelligenceSubscribers()` → then all BullMQ workers.

---

## Cross-Cutting Concerns

### Authorization

- **Customers:** Twilio Verify WhatsApp OTP → JWT (httpOnly cookie, 4h expiry) + refresh token (30-day, single-use rotation)
- **Staff:** Same OTP flow, differentiated by role (OWNER/MANAGER/ATTENDANT), 8h JWT, no refresh token
- **Admin:** `x-admin-key` header (timing-safe comparison) + server-side Next.js middleware
- **Guests:** Anonymous sessions in Redis (48h TTL), promoted to customer at checkout
- **JWT revocation:** Redis-based `jwt:revoked:{jti}` with TTL = remaining lifetime, checked in `extractAuth`

### Rate Limiting

All rate limiters use atomic `atomicIncr()` Lua script (`packages/tools/src/redis/atomic-rate-limit.ts`).
Prevents TTL-less keys if process crashes between INCR and EXPIRE.

### Content Type Parsers

Stripe and WhatsApp webhook routes use scoped content type parsers via
`fastify.register()` with prefix encapsulation. They do NOT replace global parsers.

