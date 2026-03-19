# 03 Audit: WhatsApp Channel & Webhooks

**Auditor:** whatsapp-auditor
**Date:** 2026-03-18
**Status:** Complete

## Executive Summary

The WhatsApp webhook and Stripe webhook pipelines are **well-architected** with proper signature verification, idempotency, rate limiting, and a clean async processing model. Test coverage is thorough across all modules.

**Three critical/high findings require attention:**

1. **[H-01] Agent lock uses `sessionId` but debounce uses `phoneHash` — lock bypass on session rotation.** If a session expires mid-conversation and is re-created (new `sessionId`), the agent lock on the old `sessionId` is orphaned. A concurrent request on the new session acquires a fresh lock, enabling parallel agent runs for the same phone number.

2. **[H-02] Silent message loss when agent lock is held.** If a user sends a message while the agent is already running (lock held), the message is appended to session history but `acquireAgentLock` returns `false` and the handler silently returns. The running agent already loaded history BEFORE this message arrived (line 354). The user gets no response and no acknowledgment.

3. **[M-03] `handleMessageAsync` catch block can itself fail silently.** The outer `.catch()` on line 251-253 only logs. If `resolveWhatsAppSession` throws (e.g., Redis down), the user receives no response and no error message. The fallback `sendText` at line 408-415 only covers errors AFTER session resolution.

**Overall risk: MEDIUM.** The system is solid under normal load but has edge cases under concurrent messages and infrastructure failures that can cause silent message loss.

## Scope

| File | Purpose |
|------|---------|
| `apps/api/src/routes/whatsapp-webhook.ts` | Twilio incoming webhook, async dispatch |
| `apps/api/src/whatsapp/session.ts` | Session resolution, agent lock, debounce |
| `apps/api/src/whatsapp/state-machine.ts` | Deterministic conversation flows |
| `apps/api/src/whatsapp/client.ts` | Twilio message sending with retry |
| `apps/api/src/whatsapp/formatter.ts` | Agent response collection |
| `apps/api/src/whatsapp/shortcuts.ts` | Keyword command matching |
| `apps/api/src/whatsapp/interactive-builders.ts` | WhatsApp interactive message builders |
| `apps/api/src/whatsapp/init.ts` | Sender initialization |
| `apps/api/src/routes/stripe-webhook.ts` | Stripe payment webhook |
| `apps/api/src/__tests__/whatsapp-*.test.ts` | All WhatsApp test files (7 files) |
| `apps/api/src/__tests__/stripe-webhook-route.test.ts` | Stripe webhook tests |

## System Invariants (Must Always Be True)

| # | Invariant | Status | Evidence |
|---|-----------|--------|----------|
| I-1 | WhatsApp messages are never lost silently | **VIOLATED** | See H-02, M-03 |
| I-2 | Duplicate webhook deliveries never cause duplicate processing | **HOLDS** | `SET NX` on `MessageSid` with 24h TTL (line 116-118) |
| I-3 | Agent lock prevents concurrent runs for same user | **PARTIALLY VIOLATED** | See H-01 (session rotation bypass) |
| I-4 | Stripe payments are never double-processed | **HOLDS** | `SET NX` on `event.id` with 7d TTL + `capturePayment` idempotency check |
| I-5 | Phone number identity is unforgeable on WhatsApp channel | **HOLDS** | Twilio signature verification validates webhook origin; phone verified by Meta |

## Assumptions That May Be False

| # | Assumption | Evidence For | Evidence Against | Risk if False |
|---|-----------|-------------|-----------------|---------------|
| A-1 | TWILIO_WEBHOOK_URL matches actual public URL (no proxy rewrite) | Config validated at startup via zod schema (`config.ts:29`) | If behind a reverse proxy that strips/rewrites paths, the URL used for signature validation won't match the URL Twilio signed against | **All webhook requests rejected** (403) — complete WhatsApp outage |
| A-2 | LLM calls complete within 30s between heartbeats | Heartbeat extends lock every 10s | LLM providers can have multi-minute cold starts or throttling. If event loop is blocked, `setInterval` heartbeat won't fire | **Duplicate agent runs** per H-01 |
| A-3 | Redis is always available during webhook processing | Best-effort fallbacks exist for lock release | No circuit breaker on `getRedisClient()`. If Redis is down, `checkIdempotency` throws before async dispatch, returning 500 to Twilio | **Twilio retries flood**, eventually messages processed out of order when Redis recovers |
| A-4 | Session TTL (24h) outlives all active conversations | Reasonable for daily users | Power users chatting across midnight boundary may see session rotate mid-conversation | **Message context lost** + H-01 lock bypass |
| A-5 | `upsertFromWhatsApp` is fast and idempotent | Prisma `upsert` with `where: { phone }` is idempotent | No rate limit on customer creation. A flood of unique phone numbers creates unbounded DB rows | **DB write amplification** under attack |
| A-6 | Twilio always delivers webhook for every message | Twilio SLA | Network partition, Twilio outage, or misconfigured webhook URL means messages arrive but webhook never fires | **Silent message loss** — no fallback |
| A-7 | `sendText` retry (3x backoff) is sufficient for Twilio 429s | Handles transient errors | Twilio rate limits return 429 with `Retry-After` header. The backoff (200ms, 400ms, 800ms) is far too aggressive — may hit rate limit repeatedly | **Response not delivered** to user |

## Findings

### H-01: Agent lock / debounce key mismatch enables concurrent agent runs

**Severity:** HIGH
**File:** `apps/api/src/routes/whatsapp-webhook.ts:305-318` and `apps/api/src/whatsapp/session.ts:119-137`

**Evidence:**
- Debounce key uses `phoneHash`: `rk('wa:debounce:{hash}')` — session.ts:166
- Agent lock uses `sessionId`: `rk('wa:agent:{sessionId}')` — session.ts:121
- Session is resolved with a new UUID if Redis cache expired: session.ts:72

**Scenario:**
1. User sends message M1. Session `sess-A` is created, debounce passes, lock on `sess-A` acquired. Agent starts.
2. During agent processing (which takes 5-10s), the Redis key `wa:phone:{hash}` expires (unlikely in 24h, but possible under Redis memory pressure eviction or manual flush).
3. User sends message M2. `resolveWhatsAppSession` creates NEW session `sess-B`. Debounce key has expired (2s). `acquireAgentLock('sess-B')` succeeds because it's a different key.
4. **Two agents now run concurrently for the same phone number.** Both may send responses, call tools, modify cart state.

**Blast Radius:** Duplicate responses, cart corruption, double-ordering.
**Exploitability:** Low under normal conditions (requires session eviction). Higher if Redis uses `maxmemory-policy allkeys-lru`.
**Time to Failure:** Under normal operation: unlikely. Under Redis memory pressure: immediate.

**Fix:** Use `phoneHash` for both debounce AND agent lock, or add a secondary phone-based lock guard.

---

### H-02: Silent message loss when agent lock is held

**Severity:** HIGH
**File:** `apps/api/src/routes/whatsapp-webhook.ts:315-319`

**Evidence:**
```
const lockAcquired = await acquireAgentLock(session.sessionId);
if (!lockAcquired) {
  // Another agent run is in progress — our message is in the session history
  return;
}
```

The comment says "our message is in the session history" — and it is (appended at line 293). But the currently-running agent loaded history at line 354 BEFORE this new message was appended. The running agent will not see message M2.

**Scenario:**
1. User sends "Quero costela" (M1). Agent starts, loads history, calls LLM.
2. User sends "Defumada, por favor" (M2) 3 seconds later. Debounce window expired. Message appended to session. Lock check fails. Handler returns silently.
3. Agent responds to M1 only. M2 is in history but was never presented to the agent.
4. User gets no acknowledgment that M2 was received.

**Blast Radius:** User thinks the system ignored their message. For order modifications ("cancel", "add more"), this means wrong orders.
**Exploitability:** Very easy — just send two messages 3+ seconds apart during a slow LLM call.
**Time to Failure:** Every time an LLM call takes >3s (which is most of the time).

**Production Simulation:** Send "Quero costela" → wait 4s → send "2 unidades". Observe that the agent only responds about 1 costela.

**Mitigation:** After agent lock is released, check if new messages arrived during processing. If so, re-acquire lock and run agent again. Or: send a "typing..." indicator when the lock is held so user knows a response is pending.

---

### M-03: Early crash in `handleMessageAsync` leaves user without response

**Severity:** MEDIUM
**File:** `apps/api/src/routes/whatsapp-webhook.ts:251-253, 260-278`

**Evidence:**
```
void handleMessageAsync(...).catch((err) => {
  server.log.error(err, "[whatsapp.agent.error] Unhandled error in async handler");
});
```

The catch at line 251 only logs. The try/catch inside `handleMessageAsync` (lines 321-418) sends a fallback error message — but only for errors AFTER session resolution and lock acquisition. Errors in the early section (lines 270-312) are uncaught by the inner try/catch:

- `resolveWhatsAppSession` throws (Redis down, Prisma down) — line 280
- `touchSession` throws — line 287
- `appendMessages` throws — line 293
- `tryDebounce` throws — line 305

**Blast Radius:** User sends a message, gets 200 from Twilio's perspective, but never receives any response. The message is effectively lost.
**Exploitability:** Occurs whenever Redis or Prisma is temporarily unavailable.
**Time to Failure:** Next infrastructure hiccup.

**Fix:** Wrap the entire `handleMessageAsync` body in a try/catch with a fallback `sendText` error message.

---

### M-04: No rate limit on customer auto-creation via `upsertFromWhatsApp`

**Severity:** MEDIUM
**File:** `apps/api/src/whatsapp/session.ts:69-70`, `packages/domain/src/services/customer.service.ts:156-163`

**Evidence:**
- `resolveWhatsAppSession` calls `customerSvc.upsertFromWhatsApp(phone)` on every cache miss
- Webhook rate limit is 20 msgs/min per phone — but each DIFFERENT phone counts separately
- An attacker spoofing Twilio webhooks is stopped by signature verification. But legitimate bulk messages (e.g., WhatsApp broadcast reply storm) from many unique phones would each trigger `upsert` against Prisma.

**Blast Radius:** Write amplification against Postgres. Thousands of Customer rows created per minute.
**Exploitability:** Requires legitimate WhatsApp delivery to many phones (e.g., after a promotional broadcast).
**Time to Failure:** After any marketing campaign that drives many first-time conversations.

**Mitigation:** Add a global rate limit on customer creation (e.g., 100 new customers/minute) separate from per-phone rate limiting.

---

### M-05: Stripe content type parser intercepts ALL `application/json` requests

**Severity:** MEDIUM
**File:** `apps/api/src/routes/stripe-webhook.ts:160-176`

**Evidence:**
```
server.addContentTypeParser(
  "application/json",
  { parseAs: "buffer", bodyLimit: 1_048_576 },
  (req, body, done) => {
    if (req.url === "/api/webhooks/stripe") {
      done(null, body);  // pass raw Buffer
    } else {
      try {
        done(null, JSON.parse((body as Buffer).toString("utf-8")));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  },
);
```

This parser replaces Fastify's BUILT-IN JSON parser for ALL routes. Every JSON request now goes through: `Buffer` allocation → `toString('utf-8')` → `JSON.parse`. The built-in parser is more efficient (streaming, no intermediate string).

**Blast Radius:** ~15-20% higher memory usage per request on all JSON routes, plus loss of Fastify's optimized JSON parsing.
**Exploitability:** N/A (performance issue, not security).
**Time to Failure:** Gradual — worse under high API traffic.

**Fix:** Use Fastify's `preParsing` hook or `onRequest` to set a flag, or scope the content type parser registration to the webhook route only using `fastify.register()` with `{ prefix }`.

---

### M-06: WhatsApp content type parser has same issue — intercepts all form-urlencoded routes

**Severity:** MEDIUM
**File:** `apps/api/src/routes/whatsapp-webhook.ts:165-185`

**Evidence:** Same pattern as M-05. The parser checks `req.url === "/api/webhooks/whatsapp"` but both branches do the exact same thing (parse querystring), so the functional impact is zero. However, it replaces Fastify's default parser for `application/x-www-form-urlencoded` globally.

**Blast Radius:** Minimal currently (both branches are identical). Risk if other routes rely on Fastify's default form parser behavior.

---

### L-07: Phone hash truncation (12 chars) provides weak collision resistance

**Severity:** LOW
**File:** `apps/api/src/whatsapp/session.ts:31` and `apps/api/src/whatsapp/client.ts:32`

**Evidence:**
```
return createHash("sha256").update(phone).digest("hex").slice(0, 12);
```

12 hex chars = 48 bits of entropy. Birthday paradox gives 50% collision probability at ~16.8 million unique phones. For a restaurant in Texas, this is fine. But the hash is used as a Redis key prefix for sessions, rate limits, and debounce — a collision would merge two users' sessions.

**Blast Radius:** Two different phone numbers sharing the same hash would share rate limit counters and debounce windows. NOT session data (session key includes the full hash, and session resolution uses the actual phone number for Prisma lookup).
**Time to Failure:** Effectively never for a single-location restaurant. Risk grows with scale.

---

### L-08: Duplicate `phoneHash` function definitions

**Severity:** LOW
**File:** `apps/api/src/whatsapp/session.ts:30-32` (`hashPhone`) and `apps/api/src/whatsapp/client.ts:31-33` (`phoneHash`)

**Evidence:** Two identical functions with different names doing the same SHA-256 truncation. If one is changed without the other, hash inconsistency could cause session/rate-limit mismatches.

**Fix:** Export from a single location and import in both files.

---

### L-09: Debounce window (2s) may drop legitimate rapid follow-up messages

**Severity:** LOW
**File:** `apps/api/src/routes/whatsapp-webhook.ts:304-312`

**Evidence:**
The debounce logic is: first message in a 2s window sets the NX key and becomes the "runner." Subsequent messages within 2s return early (line 307-309). The runner then `sleep(2000)` to wait for burst messages, then loads history (which now includes all messages).

This works correctly IF all messages arrive within the 2s window. But consider:
1. M1 arrives at T=0. Debounce key set (expires at T=2). Runner sleeps until T=2.
2. M2 arrives at T=1.5. Debounce key exists. M2 returns early (correct — M1 runner will pick it up).
3. M3 arrives at T=2.5. Debounce key expired. NEW debounce window. M3 becomes a new runner.
4. M1 runner wakes at T=2, loads history (includes M1 and M2, but M3 hasn't been appended yet — it's still in progress).
5. M3 runner sleeps until T=4.5, loads history. M1 runner's response is NOT in history yet (agent still running).
6. Both runners compete for agent lock. One wins, one loses. The loser's messages may go unprocessed (see H-02).

**Blast Radius:** Messages sent exactly at the debounce boundary can trigger two agent runs.

---

### L-10: No Twilio 429 / `Retry-After` header handling in send retry

**Severity:** LOW
**File:** `apps/api/src/whatsapp/client.ts:119-132`

**Evidence:**
```
await sleep(200 * 2 ** attempt);  // 200ms, 400ms, 800ms
```

Twilio rate limit responses include a `Retry-After` header. The current backoff is purely exponential with very short delays (max 800ms). If Twilio returns 429, the retry will likely hit the same rate limit immediately.

**Blast Radius:** Failed response delivery to user. Combined with the lack of fallback in H-02, the user gets silence.
**Fix:** Check for 429 status and respect `Retry-After` header, or increase base delay.

---

### L-11: State machine has no timeout/reset mechanism

**Severity:** LOW
**File:** `apps/api/src/whatsapp/state-machine.ts`

**Evidence:** The conversation state (`browsing`, `cart_review`, `checkout`) is stored in the Redis session hash with the session's 24h TTL. There is no explicit timeout to reset a user stuck in `checkout` state. If a user enters checkout and then abandons the conversation, their state remains `checkout` until the session expires.

If they return hours later and type "oi", the state machine returns `null` from `handleCheckout` (no match), so it falls through to the LLM agent — which is correct. But the user's state is still `checkout`, which may confuse the agent's context.

**Blast Radius:** Minor UX confusion. The LLM agent handles unrecognized input as fallback.

---

### L-12: `collectAgentResponse` throws on error chunk but no timeout

**Severity:** LOW
**File:** `apps/api/src/whatsapp/formatter.ts:27-41`

**Evidence:** The `for await` loop has no timeout. If the LLM provider hangs (never yields `done` or `error`), the function blocks indefinitely. The agent lock heartbeat would keep the lock alive, preventing any other processing for this user.

**Blast Radius:** User stuck forever. Requires process restart or lock TTL exhaustion (if heartbeat also hangs due to event loop block).

---

## Test Coverage Assessment

| Module | Tests | Coverage Quality | Gaps |
|--------|-------|-----------------|------|
| `whatsapp-webhook-route` | 15 tests | Good — covers signature, idempotency, rate limit, shortcuts | No test for `handleMessageAsync` error paths (M-03 scenario) |
| `whatsapp-session` | 18 tests | Good — covers normalize, hash, session resolution, lock, debounce | No test for lock + debounce interaction (H-01 scenario) |
| `whatsapp-state-machine` | 22 tests | Excellent — full transition matrix + invariant/property tests | No test for stale state recovery (L-11) |
| `whatsapp-client` | 12 tests | Good — covers split, send, retry, interactive fallbacks | No test for Twilio 429 handling (L-10) |
| `whatsapp-formatter` | 9 tests | Good — covers all chunk types | No timeout test (L-12) |
| `whatsapp-shortcuts` | 15 tests | Excellent — covers all keywords + edge cases | None |
| `whatsapp-interactive-builders` | 16 tests | Excellent — covers all builders + truncation + edge cases | None |
| `stripe-webhook-route` | 14 tests | Good — covers signature, idempotency, all event types, error recovery | No test for concurrent processing (rare given synchronous handler) |

**Notable test quality:**
- State machine tests include property-based invariant checks (no checkout without cart_review, no payment without checkout, random event sequences never throw).
- All tests mock external dependencies correctly (Redis, Twilio, Prisma, NATS).
- Tests verify both happy path and error conditions.

**Missing test scenarios:**
- Integration test: two concurrent messages for same phone (validates H-01, H-02)
- `handleMessageAsync` early-stage crash (validates M-03)
- Twilio 429 response handling (validates L-10)
- LLM provider timeout/hang (validates L-12)

## Cross-Agent Findings

### From security-auditor

- **F-03 (requireAuth `done()` bug):** `requireAuth` middleware calls `done()` after sending 401, allowing route handlers to still execute. Does NOT affect WhatsApp or Stripe webhook routes (they use Twilio/Stripe signature auth, not JWT), but would apply if `requireAuth` is ever added to webhook-adjacent routes.
- **F-13 (trustProxy not configured):** Reinforces assumption A-01 in this report. If the app sits behind a reverse proxy without `trustProxy`, both `TWILIO_WEBHOOK_URL` mismatch (breaking signature verification) and `request.ip` logging (showing proxy IP instead of Twilio's IP) are affected. Same root cause: infra assumptions not validated at runtime.
- **F-12 (Stripe webhook architecture):** Aligns with M-05 in this report (global content type parser replacement).

### From redis-auditor

- **H-03 (agent lock / debounce key mismatch):** Independently confirmed our H-01. Agent lock uses `rk('wa:agent:${sessionId}')` (session.ts:121) while debounce uses `rk('wa:debounce:${hash}')` (session.ts:166). On session expiry + recreation, new session gets a fresh lock while debounce still keys on phone hash. Both audits recommend: key agent lock by phone hash instead of sessionId.

## Recommendations (Prioritized)

1. **[H-01 fix]** Switch agent lock key from `sessionId` to `phoneHash`. This ensures the lock protects the phone number, not the session.
2. **[H-02 fix]** After releasing agent lock, check if unprocessed messages exist in session. If so, re-acquire and run agent again. Alternatively, implement a "message pending" notification to the user.
3. **[M-03 fix]** Add outer try/catch in `handleMessageAsync` BEFORE the inner try/catch, covering session resolution and debounce. Send fallback error message on any uncaught exception.
4. **[M-05/M-06 fix]** Scope content type parsers using Fastify's encapsulated plugin registration (`fastify.register()` with prefix) instead of global parser replacement.
5. **[L-10 fix]** Parse Twilio error responses for 429 status and respect `Retry-After` header.
6. **[L-08 fix]** Consolidate duplicate `phoneHash`/`hashPhone` into a single export.
