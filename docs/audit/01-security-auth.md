# 01 Audit: Security & Authentication

**Auditor:** security-auditor
**Date:** 2026-03-18
**Status:** Complete

## Executive Summary

The IbateXas API has a solid security foundation: Zod validation on all inputs, timing-safe admin key comparison, proper webhook signature verification (Stripe + Twilio), OTP brute-force protection, and strict security headers. However, the audit identified **2 Critical, 3 High, and 7 Medium severity issues** (including cross-agent findings) that need attention before production traffic.

**Top 3 findings:**

1. **[C] F-01: Admin frontend never sends `x-admin-key` header** — the admin panel is completely non-functional against the API. Every admin API call returns 401. This is a showstopper for admin operations.

2. **[H] F-03: `requireAuth` middleware calls `done()` after sending 401** — route handlers execute even when authentication fails, potentially causing side effects (DB writes, NATS events) for unauthenticated requests. The 401 response is sent to the client, but backend processing continues.

3. **[H] F-04: Rate limit key includes user-supplied `sessionId`** — attackers can bypass the 30 req/min global rate limit by rotating session UUIDs, enabling unbounded LLM inference cost via the chat endpoint.

A cross-agent finding (XF-04) adds a second Critical: the `withCustomerId` helper in the LLM tool registry allows the AI agent to supply arbitrary customer IDs, enabling IDOR via prompt injection on all reservation tools.

The admin panel auth (F-02) is a known dev stub with a documented replacement planned. The JWT architecture (24h tokens, no refresh, no revocation) is acceptable for the current scale but needs a revocation mechanism before handling sensitive operations like refunds or account changes.

## Scope

Files audited:
- `apps/api/src/middleware/auth.ts` — JWT requireAuth/optionalAuth middleware
- `apps/api/src/routes/auth.ts` — OTP flow (Twilio Verify), rate limiting, JWT issuance
- `apps/api/src/routes/admin/index.ts` — Admin API key guard
- `apps/api/src/plugins/rate-limit.ts` — Rate limiting config
- `apps/api/src/plugins/cors.ts` — CORS configuration
- `apps/api/src/plugins/helmet.ts` — Security headers
- `apps/web/src/middleware.ts` — Edge JWT decode
- `apps/admin/src/app/admin/layout.tsx` — Admin auth layout
- `apps/api/src/server.ts` — Server setup
- `apps/api/src/config.ts` — Environment variable validation
- `apps/api/src/routes/stripe-webhook.ts` — Stripe signature verification
- All route files in `apps/api/src/routes/`

## System Invariants (Must Always Be True)

1. Authenticated users cannot access other users' data
2. Admin operations are never accessible without valid API key
3. OTP brute force is impossible within reasonable time
4. JWT tokens cannot be forged or reused after expiry
5. All API inputs are validated before processing
6. Stripe webhooks only process requests with valid signatures
7. Rate limits cannot be trivially bypassed

## Assumptions That May Be False

| # | Assumption | Reality | Risk |
|---|-----------|---------|------|
| 1 | `NODE_ENV` is always `"production"` in production builds | Next.js inlines `NODE_ENV` at build time. If the admin app is built with `NODE_ENV=development` or a non-standard CI pipeline, the auth bypass is active in production. | C |
| 2 | Admin panel frontend sends `x-admin-key` header | It does NOT. `apps/admin/src/lib/api.ts:10-26` never includes this header. All admin API calls will 401. | H |
| 3 | `request.ip` reliably identifies clients for rate limiting | Behind a load balancer without `trustProxy` configured, all requests share the same IP. Rate limits become per-LB, not per-client. | H |
| 4 | OTP rate limits on phone hash are sufficient | The `otp:fail` key uses phone hash, but verify-otp has no IP-level rate limit. An attacker can try 5 codes on phone A, then 5 on phone B, etc., spraying across many phones from one IP. | M |
| 5 | `sameSite=lax` prevents CSRF for state-changing requests | `lax` only blocks cross-site cookies on non-GET requests from external navigations. For Fastify POST routes that use cookie-based JWT, cross-origin forms can still submit if the user was recently authenticated (top-level navigation). However, CORS preflight blocks most XHR-based CSRF. | L |
| 6 | Web middleware JWT decode-only is safe | Correct for edge — it only gates client-side redirects, not data access. All data access goes through API `requireAuth` which verifies signatures. Acceptable pattern. | L |
| 7 | 24h JWT with no refresh is acceptable | No refresh token means users must re-OTP every 24h. A stolen token is valid for up to 24h with no revocation mechanism. | M |

## Findings

### F-01 [C] Admin Panel Frontend Missing `x-admin-key` Header — Admin API Completely Inaccessible from Frontend

**Evidence:**
- `apps/admin/src/lib/api.ts:10-26` — `apiFetch()` sends `Content-Type` and `credentials: include` but never includes `x-admin-key`
- `apps/api/src/routes/admin/index.ts:29-43` — Every admin route requires `x-admin-key` header via timing-safe comparison
- `packages/ui/src/hooks/admin-factory.ts` — Factory receives `apiFetch` as `fetcher`, no header injection
- Grep for `x-admin-key` and `ADMIN_API_KEY` across entire `apps/admin/src/` returns zero matches

**Blast Radius:** Every admin panel feature (dashboard, products, orders, reservations, tables, delivery zones) returns 401. The admin panel is non-functional against the API.

**Exploitability:** N/A — this is a functionality gap, not an exploit. However, if a developer "fixes" this by removing the API key check rather than adding the header, it becomes Critical.

**Time to Failure:** Immediate. First admin page load triggers API calls that all fail.

**Production Simulation:** Admin opens dashboard → `GET /api/admin/dashboard` → 401. All data panels show errors.

**Remediation:** Add `x-admin-key` header to `apiFetch`. The key must come from an environment variable (e.g., `NEXT_PUBLIC_ADMIN_API_KEY`) or be injected server-side. Note: exposing it as `NEXT_PUBLIC_*` means it's in the client bundle — acceptable only if the admin app is not publicly accessible (network restriction or additional auth layer). Preferred: add server-side API route proxy in the admin Next.js app that injects the key.

---

### F-02 [H] Admin Panel Auth is Client-Side `useState` Only — No Server-Side Protection

**Evidence:**
- `apps/admin/src/app/admin/layout.tsx:13` — `useState(process.env.NODE_ENV !== 'production')` is the sole auth gate
- This is a `'use client'` component — the initial value is determined at build time by Next.js inlining
- No Next.js middleware in `apps/admin/` protecting `/admin/*` routes
- No server component or server-side check exists

**Blast Radius:** If built with `NODE_ENV !== 'production'` (CI misconfiguration, local build pushed to hosting), the admin panel renders with full UI access. Even in production build, this is a client-side-only gate — the HTML/JS is always shipped to the browser. A user can simply modify the React state in DevTools to bypass.

**Exploitability:**
- **In production build:** Open React DevTools → Components → AdminLayout → set `isStaff` state to `true`. Trivial.
- **If `NODE_ENV` misconfigured:** Zero interaction needed, panel loads open.
- However: admin API calls still require `x-admin-key` (see F-01), so data access is separately gated. The UI is exposed but non-functional without the key.

**Time to Failure:** Immediate if NODE_ENV is wrong. Always exploitable via DevTools for UI access.

**Production Simulation:** User navigates to admin URL → sees "Acesso restrito" → opens DevTools → sets state → sees admin UI → all API calls fail 401 (mitigated by F-01, ironically).

**Remediation:** Add Next.js middleware to `apps/admin/` that validates a session/token before serving any `/admin/*` page. The CLAUDE.md notes this is a known dev stub ("Step 11 replaces with Twilio Verify OTP").

---

### F-03 [H] `requireAuth` Middleware Calls `done()` After Sending 401 — Response Continues Executing

**Evidence:**
- `apps/api/src/middleware/auth.ts:44-51`:
```typescript
extractAuth(request).then(() => {
  if (!request.customerId) {
    void reply
      .code(401)
      .send({ statusCode: 401, error: "Unauthorized", message: "Autenticação necessária." });
  }
  done();  // <-- Called even after reply.send(401)
}, done);
```
- After `reply.send()`, `done()` is still called. Fastify's preHandler contract means calling `done()` after sending a reply allows the route handler to execute. The `void reply.code(401).send(...)` does not stop execution — `done()` runs on the next line unconditionally.

**Blast Radius:** Route handlers that rely on `requireAuth` will execute even when auth fails. The 401 response IS sent to the client (Fastify serializes the first reply), but the route handler still runs, potentially performing side effects (database writes, NATS events, etc.) for unauthenticated requests.

**Exploitability:** An attacker sends a request without a JWT cookie. The 401 is sent, but the route handler executes with `request.customerId = undefined`. Routes that use `request.customerId!` (non-null assertion) will pass `undefined` to downstream services.

**Time to Failure:** Every unauthenticated request to a `requireAuth` route. Side effects depend on downstream service behavior with `undefined` customerId.

**Production Simulation:** `POST /api/reservations` without token → 401 sent to client → but `createReservation({ ...request.body, customerId: undefined })` still executes.

**Remediation:** Add `return` before `done()` in the failure case, or restructure to not call `done()` after sending:
```typescript
if (!request.customerId) {
  void reply.code(401).send({ ... });
  return done();  // or just return without calling done()
}
done();
```

---

### F-04 [H] Rate Limit Key Includes `sessionId` from Request Body — Partial Bypass via Session Rotation

**Evidence:**
- `apps/api/src/plugins/rate-limit.ts:8-18`:
```typescript
keyGenerator(request: FastifyRequest): string {
  const body = request.body as Record<string, unknown> | undefined;
  if (body?.sessionId && typeof body.sessionId === "string") {
    return `${request.ip}:${body.sessionId}`;
  }
  return request.ip;
}
```
- When `sessionId` is present in the body, the rate limit key becomes `ip:sessionId`. An attacker on a single IP can send requests with different `sessionId` values to get independent rate limit buckets.

**Blast Radius:** Chat endpoint (`POST /api/chat/messages`) includes `sessionId` in the body. An attacker can generate new UUIDs to bypass the 30 req/min global rate limit, flooding the AI agent and incurring LLM costs.

**Exploitability:** Trivial. Script generates UUID v4 per request, sends to `/api/chat/messages`. Each UUID gets its own 30-request bucket. With N UUIDs, attacker gets N*30 requests/min from a single IP.

**Time to Failure:** Immediate under targeted abuse.

**Production Simulation:** Attacker sends 100 requests/min from single IP, each with unique `sessionId`. All pass rate limit. LLM inference costs accumulate.

**Remediation:** The comment says "IP cannot generate unlimited keys by changing sessionId alone" but this is false — each unique sessionId creates a new bucket. The intended behavior (shared office gets independent quotas) should use a counter per IP that caps total sessions: e.g., rate limit on IP alone, with a separate per-session concurrency limit.

---

### F-05 [M] No IP-Level Rate Limit on `verify-otp` — Phone Spray Attack

**Evidence:**
- `apps/api/src/routes/auth.ts:234-246` — `checkBruteForce(hash)` only checks per-phone failure count
- `apps/api/src/routes/auth.ts:59-67` — `checkIpRateLimit(ip)` exists but only on `send-otp`, not `verify-otp`
- An attacker can try 5 codes on phone A, 5 on phone B, 5 on phone C... from the same IP without any IP-level restriction on verify

**Blast Radius:** Attacker with a list of phone numbers can attempt OTP verification across many phones, 5 attempts each. With 1000 phone numbers, that's 5000 attempts from a single IP.

**Exploitability:** Moderate — requires knowledge of target phone numbers. Automated attack possible.

**Remediation:** Add `checkIpRateLimit(ip)` to the verify-otp endpoint, mirroring the send-otp protection.

---

### F-06 [M] JWT Has No Revocation Mechanism — Stolen Tokens Valid for 24 Hours

**Evidence:**
- `apps/api/src/routes/auth.ts:133-137` — Token issued with `expiresIn: '24h'`
- `apps/api/src/middleware/auth.ts:24` — `jwtVerify()` only checks signature and expiry
- No token blocklist/denylist exists in Redis or elsewhere
- No refresh token mechanism — token is long-lived and cannot be invalidated

**Blast Radius:** If a JWT is exfiltrated (XSS on a subdomain, compromised CDN, network interception in dev where `secure: false`), the attacker has 24 hours of access as that customer.

**Exploitability:** Requires token theft first (secondary vector). But once obtained, no mitigation exists.

**Remediation:**
- Short-term: Reduce JWT expiry to 1-2 hours, add refresh token flow
- Medium-term: Add Redis-based token revocation list checked in `extractAuth()`
- Logout (`POST /api/auth/logout`) only clears the cookie — does NOT invalidate the token server-side

---

### F-07 [M] Cookie `secure: false` in Non-Production — Token Sent Over Plain HTTP

**Evidence:**
- `apps/api/src/routes/auth.ts:302-309`:
```typescript
const isProduction = process.env.NODE_ENV === "production";
.setCookie("token", token, {
  httpOnly: true,
  secure: isProduction,  // false in dev/staging
  sameSite: "lax",
  ...
})
```

**Blast Radius:** In staging environments that use HTTP (common for internal testing), the JWT cookie is transmitted in plaintext. Any network observer can capture it.

**Exploitability:** Low in development (localhost). Medium in staging if deployed over HTTP.

**Remediation:** Consider `secure: true` always, or ensure staging uses HTTPS.

---

### F-08 [M] Web Middleware JWT Decode Without Signature Verification (Documented, Accepted)

**Evidence:**
- `apps/web/src/middleware.ts:21-31` — `isTokenExpired()` uses `atob()` to decode payload, no signature check
- This is an intentional Edge Runtime pattern (Edge Runtime cannot use `jsonwebtoken` which requires Node.js crypto)

**Blast Radius:** Limited. This middleware only controls client-side redirects (login page vs protected pages). All actual data access goes through the API server which verifies signatures via `@fastify/jwt`. An attacker who forges a token can see the protected page's client-side shell but cannot load any data.

**Exploitability:** Trivially forgeable for navigation only. No data exposure.

**Remediation:** Documented and accepted. Consider adding a comment in the middleware explaining this is intentional.

---

### F-09 [M] Checkout Route Uses `optionalAuth` — Guest Checkout Creates Orders Without Identity Verification

**Evidence:**
- `apps/api/src/routes/cart.ts:247-249` — `POST /api/cart/checkout` uses `preHandler: optionalAuth`
- Guest users (`userType: "guest"`) can complete checkout without any authenticated identity

**Blast Radius:** This is likely intentional (guest checkout is a common e-commerce pattern). However, it means order fraud is easier — no phone verification is required to place an order.

**Exploitability:** Depends on payment method. Card payments are validated by Stripe. Cash/PIX may have less validation.

**Remediation:** Verify this is intentional business logic. If fraud becomes an issue, consider requiring auth for cash orders.

---

### F-10 [L] Admin API Key Has No Rotation Mechanism

**Evidence:**
- `apps/api/src/routes/admin/index.ts:26` — `const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? ""`
- Key is read once at startup. Rotation requires server restart.
- No dual-key support for zero-downtime rotation.

**Blast Radius:** If the key is compromised, rotation requires coordinated restart of API + all admin clients.

**Remediation:** Support array of valid keys (current + previous) to allow zero-downtime rotation.

---

### F-11 [L] CORS Origin Falls Back to `WEB_URL` Single String — No Admin App Origin

**Evidence:**
- `apps/api/src/plugins/cors.ts:27-31` — In production, `resolveOrigin()` returns single `WEB_URL` string
- The admin app runs on a different origin (port 3002) but is not included in CORS allowed origins
- In production, if admin app is on a different domain, its requests will be blocked by CORS

**Blast Radius:** Admin panel API requests blocked by CORS in production unless `CORS_ORIGIN` is explicitly set to include both web and admin origins.

**Remediation:** Document that `CORS_ORIGIN` must include both web and admin origins in production (comma-separated).

---

### F-12 [L] Stripe Webhook Idempotency Key Deletion on Error May Cause Double Processing

**Evidence:**
- `apps/api/src/routes/stripe-webhook.ts:269-270`:
```typescript
// Remove idempotency key so next retry can reprocess
await redis.del(idempotencyKey);
```
- If processing fails and the key is deleted, Stripe's retry will reprocess. If the original partially succeeded (e.g., NATS event published but capture failed), the retry may cause double events.

**Blast Radius:** Potential double `order.placed` NATS events if partial failure occurs during webhook processing.

**Remediation:** Consider making individual operations idempotent rather than relying on the envelope-level key. Or keep the key and use a separate error tracking mechanism.

---

### F-13 [L] `trustProxy` Not Explicitly Configured in Fastify

**Evidence:**
- `apps/api/src/server.ts:17-25` — `Fastify()` created without `trustProxy` option
- `request.ip` in rate limiting may return the load balancer's IP instead of the client's real IP

**Blast Radius:** If deployed behind a reverse proxy (common in production), all rate limits are shared across all clients (they all appear as the same IP).

**Remediation:** Add `trustProxy: true` (or specific proxy count) to Fastify options when behind a load balancer.

---

## Auth Coverage Matrix

| Route | Method | Auth | Notes |
|-------|--------|------|-------|
| `/health` | GET | None | Correct — health check |
| `/api/auth/send-otp` | POST | None | Correct — pre-auth |
| `/api/auth/verify-otp` | POST | None | Correct — pre-auth |
| `/api/auth/logout` | POST | None | Correct — clearing cookie works without auth |
| `/api/auth/me` | GET | `requireAuth` | Correct |
| `/api/chat/messages` | POST | `optionalAuth` | Acceptable — guests can chat |
| `/api/chat/stream/:sessionId` | GET | `optionalAuth` | See F-14 below |
| `/api/products` | GET | None | Correct — public catalog |
| `/api/products/personalized` | GET | `optionalAuth` | Correct — enhances with auth |
| `/api/products/:id` | GET | `optionalAuth` | Correct |
| `/api/products/:id/reviews` | GET | None | Correct — public reviews |
| `/api/categories` | GET | None | Correct — public |
| `/api/cart` | POST | `optionalAuth` | Correct — guest carts |
| `/api/cart/:id` | GET | `optionalAuth` | See F-15 below |
| `/api/cart/:id/line-items` | POST | `optionalAuth` | Cart ID is the auth |
| `/api/cart/:id/line-items/:itemId` | PATCH | `optionalAuth` | Cart ID is the auth |
| `/api/cart/:id/line-items/:itemId` | DELETE | `optionalAuth` | Cart ID is the auth |
| `/api/cart/:id/sync` | POST | `optionalAuth` | Cart ID is the auth |
| `/api/cart/:id/promotions` | POST | `optionalAuth` | Cart ID is the auth |
| `/api/cart/:id/payment-sessions` | POST | `optionalAuth` | Cart ID is the auth |
| `/api/cart/checkout` | POST | `optionalAuth` | See F-09 |
| `/api/cart/delivery-estimate` | GET | None | Correct — public |
| `/api/cart/orders/:orderId` | GET | `requireAuth` | Correct — has IDOR check |
| `/api/coupons/validate` | POST | None | Correct — public validation |
| `/api/reservations/availability` | GET | None | Correct — public |
| `/api/reservations` | POST | `requireAuth` | Correct |
| `/api/reservations` | GET | `requireAuth` | Correct |
| `/api/reservations/:id` | PATCH | `requireAuth` | Correct |
| `/api/reservations/:id` | DELETE | `requireAuth` | Correct |
| `/api/reservations/:id/waitlist` | POST | `requireAuth` | Correct |
| `/api/shipping/estimate` | GET | None | Correct — public |
| `/api/analytics/track` | POST | None | Correct — fire-and-forget analytics |
| `/api/recommendations` | GET | `optionalAuth` | Correct |
| `/api/recommendations/also-added` | GET | None | Correct — public |
| `/api/webhooks/stripe` | POST | Signature verified | Correct |
| `/api/webhooks/whatsapp` | POST | Signature verified | Correct |
| `/api/admin/*` | ALL | `x-admin-key` header | Correct (but see F-01) |

---

### F-14 [M] Chat SSE Stream Has No Session Ownership Check

**Evidence:**
- `apps/api/src/routes/chat.ts:130-131` — `GET /api/chat/stream/:sessionId` uses `optionalAuth` but never verifies that the authenticated user owns the session
- Any user (or guest) who knows/guesses a session UUID can subscribe to another user's chat stream

**Blast Radius:** Leaks AI agent conversation content to unauthorized parties. Session IDs are UUIDs (hard to guess) but may be exposed in browser history, logs, or network traffic.

**Exploitability:** Low without session ID knowledge. If session IDs leak, trivially exploitable.

**Remediation:** Verify that `request.customerId` matches the session owner, or store session ownership in Redis.

---

### F-15 [L] Cart Access by ID Has No Ownership Check

**Evidence:**
- `apps/api/src/routes/cart.ts:67-78` — `GET /api/cart/:id` returns any cart by ID without checking ownership
- Cart IDs are Medusa-generated (non-sequential UUIDs), making enumeration impractical

**Blast Radius:** Anyone who knows a cart ID can view its contents. Cart IDs are unguessable but could leak via referrer headers, logs, or shared URLs.

**Remediation:** Acceptable risk for e-commerce (Medusa's standard pattern). Cart contents are non-sensitive compared to order data.

---

## What's Working Well

1. **Admin API key guard** — Timing-safe comparison (`timingSafeEqual`) prevents timing attacks. Returns 503 if key is unconfigured (fail-closed). Audit logging on all admin requests.
2. **Stripe webhook** — Proper signature verification via `constructEvent()`, 300s replay window, 7-day idempotency.
3. **Twilio webhook** — Signature verification via `validateRequest()`, 24h idempotency, 20 msg/min rate limit per phone.
4. **OTP brute force protection** — 5 failures/phone/hour, 3 sends/phone/10min, 10 sends/IP/hour. Phone numbers hashed in logs.
5. **Input validation** — All routes use Zod schemas. Error handler sanitizes upstream errors.
6. **Helmet security headers** — Strict CSP, HSTS in production, X-Frame-Options DENY.
7. **CORS** — Production requires explicit `WEB_URL`, dev allows only RFC 1918 private IPs.
8. **IDOR protection** — `GET /api/cart/orders/:orderId` verifies ownership before returning data.
9. **Environment validation** — `apps/api/src/config.ts` validates all required env vars at startup with Zod, crashes immediately if misconfigured.

## Cross-Agent Findings

### From whatsapp-auditor (03-whatsapp-webhooks.md)

**XF-01 [M] No global rate limit on customer auto-creation from WhatsApp.** `upsertFromWhatsApp` runs for every new phone on cache miss. Per-phone rate is 20 msgs/min, but no global cap on unique-phone creation. A marketing broadcast reply storm from thousands of new numbers could create thousands of DB rows/minute. *Security relevance:* resource exhaustion / DB write amplification.

**XF-02 [M] Twilio signature verification depends on `TWILIO_WEBHOOK_URL` matching actual URL.** If a reverse proxy rewrites the path, all webhooks return 403. Zod validates it as a URL (`config.ts:29`) but there is no runtime check comparing it to the actual request URL. *Security relevance:* silent webhook failure after infra changes (reverse proxy, CDN path rewrite). Related to F-13 (trustProxy not configured).

**XF-03 [L] Stripe webhook global content type parser replacement.** `stripe-webhook.ts:160-176` replaces Fastify's built-in JSON parser for ALL routes. It re-parses JSON for non-webhook paths, which is functionally equivalent but bypasses Fastify's optimized parsing. *Security relevance:* subtle breakage risk if future middleware depends on native Fastify body parsing behavior. Reinforces F-12 (Stripe webhook architecture concerns).

### From ai-agent-auditor (02-ai-agent.md)

**XF-04 [C] `withCustomerId` allows LLM-supplied `customerId` to bypass auth context.** `packages/llm-provider/src/tool-registry.ts:112-125` — The helper only injects `ctx.customerId` when `input.customerId` is absent. If the LLM hallucates or is prompt-injected into supplying `customerId: "other_cust"`, the tool executes with the wrong identity. Line 123 (`return fn(i)`) passes the LLM-supplied value directly without overriding from `ctx`. Affected tools: `create_reservation`, `modify_reservation`, `cancel_reservation`, `get_my_reservations`, `join_waitlist` (lines 154-158). *Security relevance:* IDOR via LLM — an attacker could craft a prompt injection in product descriptions or chat messages that instructs the agent to call reservation tools with a target customer's ID. This is a Critical auth bypass. Fix: always override `i.customerId = ctx.customerId` regardless of what the LLM provides.

**XF-05 [M] Chat routes use `optionalAuth` — unauthenticated users get full agent access.** `apps/api/src/routes/chat.ts:65` — Guest users can invoke the LLM agent via `POST /api/chat/messages` without authentication. Individual tools enforce auth for sensitive operations, but guest traffic still consumes Anthropic API tokens. Combined with F-04 (rate limit sessionId bypass), this means unbounded LLM cost from unauthenticated traffic. *Security relevance:* cost amplification vector, reinforces F-04.

### From data-layer-auditor

**XF-06 [H] No FK on `Reservation.customerId` or `Waitlist.customerId` — no referential integrity check at DB level.** `packages/domain/prisma/schema.prisma:86` — `Reservation.customerId` is a plain string with no foreign key relation to the `Customer` model. Similarly for `Waitlist.customerId`. *Security relevance:* This compounds three findings:
- **F-03** (`requireAuth` done() bypass): route handler executes with `customerId = undefined`, and the DB accepts it since there's no FK constraint to reject a non-existent customer.
- **XF-04** (`withCustomerId` LLM bypass): the LLM can supply an arbitrary `customerId` and the DB will happily store a reservation referencing a non-existent or wrong customer.
- Together these mean that neither middleware, tool layer, nor database validates that the `customerId` corresponds to a real customer. The full defense chain is: auth middleware (broken via F-03) -> tool registry (broken via XF-04) -> database (no FK). All three layers fail.

### From redis-auditor (05-redis-state-management.md)

**XF-07 [M] Non-atomic INCR + EXPIRE race in rate limiters — keys can persist forever.** Multiple rate limiters use `INCR` followed by conditional `EXPIRE` as two separate commands:
- `apps/api/src/routes/auth.ts:62-64` — `checkIpRateLimit`: `incr(key)` then `if (count === 1) expire(key, 3600)`
- `apps/api/src/routes/auth.ts:72-74` — `checkSendRateLimit`: same pattern with 600s TTL
- `apps/api/src/routes/whatsapp-webhook.ts:122-126` — `checkWebhookRateLimit`: same pattern with 60s TTL
- `apps/api/src/routes/analytics.ts:68-72` — analytics rate limit: same pattern with 60s TTL

If the process crashes or the Redis connection drops between INCR (returning 1) and EXPIRE, the key persists with no TTL. The counter is permanently stuck, effectively rate-limiting that IP/phone forever. *Security relevance:* Compounds with F-04 (rate limit bypass) and F-13 (trustProxy) — a permanently stuck key on a shared proxy IP could block all users behind that proxy. Fix: use a Lua script or `SET key 1 EX ttl NX` + `INCR` pattern to ensure atomicity, or use `EXPIRE` unconditionally on every increment (idempotent, slight overhead).

