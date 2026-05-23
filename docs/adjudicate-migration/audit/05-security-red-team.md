# Security Red-Team Audit

> Adversarial review of the M3 governance migration. Assumes hostile customers,
> hostile insiders, and a network adversary capable of MITM between services.
> Findings cite exact file paths and line ranges.

## Executive summary (top 5 risks)

1. **P0 — Stolen-JWT instantly destroys account (LGPD-anonymize "fresh OTP" gate is single-factor, not two-factor).** A stolen `token` cookie alone authorises `POST /api/me/data/initiate-deletion`. The Pack policy gate `requireFreshOtp` is satisfied by Redis marker `anonymize:otp:{customerId}` which the same attacker creates by hitting initiate-deletion. The OTP code is delivered to the *legitimate* customer's phone, but the attacker only needs to know the 6-digit OTP — there is *no* per-customer/per-phone rate limit on `verifyAnonymizeOtp`, only the global 30 RPM IP limit. Twilio Verify itself caps to 5 wrong checks per code, but the attacker may request many initiate-deletions in a row (also unbounded) and brute-force across a wider key space. After T+24h the destructive `anonymizeCustomer` fires.
2. **P0 — NATS bus has no authentication.** `packages/nats-client/src/index.ts:29-33` connects to `NATS_URL` with no `user`, `pass`, `token`, `nkey`, or TLS option. Any process on the network that reaches `localhost:4222` can (a) subscribe to `ibatexas.audit.intent.decision.v1` and exfiltrate every adjudicated payload (including PII the redactor missed), (b) publish forged `payment.status_changed`, `intent.defer.timeout`, `order.canceled`, and `customer.welcome_credit.grant` events that downstream subscribers consume without validation. The grace-resolver subscriber in particular runs the irreversible `anonymizeCustomer()` based purely on event-shape.
3. **P0 — Audit redactor leaks `customerId` via `envelope.actor.sessionId`.** The redactor explicitly preserves `envelope.actor` (invariant #3, `packages/llm-provider/src/audit-redactor.ts:31`). For HTTP routes (me.ts, order-actions.ts, cart.ts), `actor.sessionId = customerId` *verbatim* (not a phone hash). The contract test excludes `actor.sessionId` from its detection sweep with the incorrect rationale that "Sessions in IbateXas are SHA-256 hashed phone numbers" (`audit-redaction-contract.test.ts:610-612`) — that's only true for the WhatsApp path. CustomerIds are then published to NATS, persisted to Postgres audit, and (item 2) potentially exposed to unauthorised subscribers.
4. **P0 — Admin API-key bypasses two-person rule and role gates.** `requireManagerRole` is a no-op when no staff JWT is present (`apps/api/src/middleware/staff-auth.ts:67-74`). Anyone in possession of `ADMIN_API_KEY` reaches refund step-1, refund step-2, banner edits, schedule edits, table edits, product mutations, delivery-zone edits — without any role differentiation. The admin guard validates the key with `timingSafeEqual` (good), but the key never expires, never rotates automatically, and one compromise yields full mutation power without the two-step receipt requiring a *second* authenticated human.
5. **P0 — Anonymize "cancel" race + Twilio-spend amplification.** (a) Cancel-deletion deletes the receipt but does NOT mark the customer as "recently cancelled" — an attacker can immediately re-initiate. (b) `initiate-deletion` has no rate limit beyond global 30 RPM, but each call costs an SMS/WhatsApp Twilio Verify message to the *real* customer's phone — attacker can spam-harass the victim AND inflate Twilio bills.

## LGPD anonymize attack surface

### A1 (P0): Single-factor authentication on initiate-deletion
- `POST /api/me/data/initiate-deletion` requires only `requireAuth` (JWT cookie). No phone re-prove. No password (none exist by design — phone-OTP-only auth). Stolen cookie → attacker can initiate destruction.
- Defence-in-depth would require step-up auth: confirm the customer holds the phone *before* even SMSing them an OTP (e.g., re-send to phone and accept only if the customer's current session is recent).

### A2 (P0): OTP verification has no application-layer rate limit
- `apps/api/src/routes/me.ts:246` calls `verifyAnonymizeOtp(phone, otpCode)` directly. `apps/api/src/routes/me/anonymize-otp-gate.ts:96-105` swallows Twilio errors and returns `false` — Twilio's per-code 5-strike limit triggers but the attacker can re-initiate-deletion (which issues a *new* code, resetting the strike counter for the new code). Combined with the absence of per-customer brute-force counters (`auth.ts` has `checkBruteForce` keyed on `phoneHash` for *login* but the anonymize path does NOT call it), the effective brute-force space per hour is bounded only by Twilio's verification request budget, not by an application-level lock.

### A3 (P0): Cancel-then-reinitiate race amplifies victim harassment
- `POST /api/me/data/cancel-deletion` (`me.ts:391`) DELetes `anonymize:pending:{customerId}` and `defer:pending:{customerId}`. No cooldown is written. The next request to `/initiate-deletion` (one millisecond later) succeeds.
- Attack: attacker initiates, victim cancels, attacker initiates, victim cancels, … each iteration costs the victim a Twilio SMS notification and the platform owner ~R$0,05 per SMS. The 30 RPM IP limit can be sidestepped via a small botnet (cookies are tied to customerId not IP — JWT roams).

### A4 (P1): Pack policy lies about OTP freshness on cancel
- `me.ts:436` sets `otpFresh: true` for the cancel adjudication even though no OTP was verified for cancel. This is logically correct (cancel is non-destructive and the receipt existence is the proof-of-prior-OTP), but the *audit record* now claims `otpFresh: true` — a fact the audit consumer cannot distinguish from an actually-fresh OTP. Fix: introduce `cancel: true` and let the policy guard skip the OTP-freshness check explicitly.

### A5 (P1): Grace-resolver subscriber accepts unauthenticated NATS events
- `subscribers/anonymize-grace-resolver.ts:147` subscribes to `intent.defer.timeout` with no signature verification on the event payload. Combined with the no-NATS-auth finding (item 2), a hostile process can forge `{eventType: "intent.defer.timeout", sessionId: <victim's customerId>, signal: "customer.anonymize.confirmed_after_grace"}` — *but* the subscriber gates on `readPendingDeletion(customerId)` returning non-null, so without an existing receipt the forgery is no-op. The receipt itself is set by the *real* DELETE flow which requires the OTP. So the immediate attack is limited; however, an insider who can write to Redis (e.g., compromised admin shell) can place a fake receipt then forge the timeout to fire anonymize without ever exercising the OTP path.

### A6 (P2): Receipt key value contains the parked envelope blob (PII)
- `me.ts:313-321` stores the parked envelope at `rk(defer:pending:{customerId})` *unredacted*. The envelope payload contains `{customerId, otpToken, scope: "lgpd_art_18"}`. The OTP token is plaintext in Redis for 24h+60s. An attacker with Redis-read can:
  - learn the OTP token of any in-flight deletion (Twilio Verify single-use → already consumed by the time the receipt parks, so practical impact is low),
  - learn the `intentHash` and replay the parked-envelope shape against the sweeper.

### A7 (P2): `anonymizeCustomer` is incomplete
- `packages/domain/src/services/customer.service.ts:406-428` clears `name`, `email`, addresses, preferences, and delinks order items — but does NOT clear `phone` (the LGPD-protected identifier most likely to be a CPF or directly-linkable to one) and does NOT delete `reviews` (which carry `comment` text potentially containing PII the customer entered). LGPD Art. 16 requires that the data be erased; preserving `phone` may be defensible as "fiscal/anti-fraud retention" but should be explicitly documented and the contact-resolution paths (lookups by phone) should be hardened against reactivation.

## Audit redactor coverage gaps

### R1 (P0): `actor.sessionId` is unredacted PII for HTTP routes
- See executive #3. Fix options: (a) hash `actor.sessionId` at envelope-build time at the route layer (not the redactor — the kernel uses `actor` for routing), (b) treat `actor.sessionId` as a HASH field in the redactor, accepting the small audit-correlation cost. The contract test must be tightened to verify `actor.sessionId` either is in HASH form or matches `admin:*`/`stripe-webhook:*` literal sentinels.

### R2 (P1): Phone regex misses dashed-international format
- `+55-11-99999-9999` is NOT matched by `PHONE_RE = /(?<!\d)(?:\+?55)?\s?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}(?!\d)/g` because the regex expects whitespace (or none) between `+55` and the area code. Fortunately the `CARD_RE` catches it as a 13-digit run and replaces with `[REDACTED:CARD]` — the digits are scrubbed, just with the wrong sentinel. Fix: add `[-\s]?` between the country code and area code in `PHONE_RE`.

### R3 (P1): Email regex does not catch obfuscated forms
- `user [at] domain.com`, `user(at)domain.com`, `user AT domain DOT com` all pass through. The LLM is the typical author of such obfuscations and Anthropic models have a tendency to do this when discussing PII safely. Verify with adversarial fixtures.

### R4 (P2): Hash function is salted SHA-256 truncated to 8 hex chars
- `hashValue(value, secret)` returns first 8 of `sha256(value + secret)`. Collision space is 2^32 — fine for correlation, bad for cryptographic uniqueness. Audit team should never use the truncated hash as a primary key. (Code comment at `audit-redactor.ts:554-557` acknowledges this is intentional.) Verify auditors are not building lookup tables on the truncated form.

### R5 (P2): JSON-stringified payload sub-fields are NOT walked
- If a payload contains `{ note: "{\"cpf\":\"12345678900\",\"email\":\"x@y.com\"}" }` (already-stringified JSON), the redactor sees a single string and runs the regex defense — which DOES catch CPF and EMAIL. But for `{ payload: <base64-encoded-JSON> }` the regex misses everything. No current intent kind ships base64 in a non-binary field, so this is theoretical.

### R6 (P2): `set_pix_details` classified READ_ONLY but ingests PII
- `packages/llm-provider/src/machine/types.ts:400` lists `set_pix_details` under `READ_ONLY` (with comment explaining it does not mutate state). However, the `name`/`email`/`cpf` it ingests STILL flow into audit via the validation event path (`validation.text.refuse`, `validation.text.rewrite`). The contract test covers these intent kinds. Not a redactor bug — but verify the LLM responder is forwarding the validated `set_pix_details` arguments to the audit sink, NOT bypassing.

### R7 (P2): Numeric CPF as `number` type
- Verified covered: redactor coerces numeric/bigint values under `REDACT_FIELDS` to `[REDACTED]` (`audit-redactor.ts:430-436`). Contract test covers `cpf: 12345678900` as a number. PASS.

### R8 (P2): PII inside deeply nested objects
- Verified covered: walker recurses through arbitrary nesting. Contract corpus includes 4-deep nesting. PASS.

## Admin confirmation protocol weaknesses

### C1 (P1): Concurrent-confirm test does not actually exercise the race
- `force-routes-governance.test.ts:869-893` tests sequential consume (`first` then `second`) on the in-memory mock — it does NOT exercise true Lua atomicity (the mock uses a Map). The atomicity claim relies on real Redis `EVAL` behaviour. The Lua script (`admin-confirmation-store.ts:62-70`) is correct in Redis (GET+DEL in one round-trip is atomic), but the test mock could pass even if the production code regressed to non-atomic JS.
- Fix: add an integration test against a real Redis (or testcontainer) firing two concurrent `consume()` calls and asserting exactly one wins.

### C2 (P1): No staff-identity binding between step 1 and step 2
- `admin-confirmation-store.ts:91-117` captures `staffId` at step 1, but step 2 (`order-actions.ts:233`) consumes the receipt WITHOUT verifying that the requesting staff identity matches `pending.staffId`. ANY authorised manager (or API key holder) can complete a step-1 issued by a different manager. The captured `pending.staffId` is only used for *audit logging*, not for authorisation. Fix: in step 2, require `pending.staffId === request.staffId` (allow null-to-null for API-key paths, but log a warning).

### C3 (P2): Receipt enumeration via timing
- Confirm endpoints return 410 for unknown OR consumed OR expired. UUIDv4 randomness defeats brute force (~2^128 space). No rate limit specific to confirm endpoints — relies on global 30 RPM. Practical attack: zero. Theoretical: someone with privileged network position could try receipt enumeration; the timing-side-channel between "received receipt missing" and "received receipt expired" is the only differentiator and Redis op latency is bounded.

### C4 (P2): TTL bypass via Redis restart
- 600s TTL relies on Redis persistence. If Redis is configured ephemeral (no AOF/RDB), a restart vaporises in-flight receipts — and any operator mid-flow has to restart. Not exploitable as an attack vector since the restart only invalidates receipts (denial-of-completion, not unauthorised completion).

### C5 (P1): Refund threshold is a bypass primitive
- `payments.ts:75` sets `REFUND_CONFIRMATION_THRESHOLD_CENTAVOS = 20_000` (R$200). Below threshold, refunds EXECUTE directly with no two-step. An attacker (or rogue manager) can issue 100 × R$199 refunds in rapid succession totalling R$19,900 — each refund individually passes the threshold check. There is no aggregate-refunds rate limit or session-window cap. Fix: add a per-payment cumulative refund check, or a per-staff session-window refund total.

## Admin auth surface

### S1 (P1): Some admin GET routes lack role gates
- `GET /api/admin/products`, `GET /api/admin/orders` (`apps/api/src/routes/admin/products.ts:27`, `orders.ts:55`) lack `requireManagerRole` and rely on the outer admin guard (any staff JWT OR API key). An ATTENDANT can list every order with customer phone+email in the projection (`orders.ts:96`).
- Same risk for `GET /api/admin/orders/:id/notes` (`payments.ts:820`) and `GET /api/admin/orders/:id/payments` (`payments.ts:849`).
- Fix: tighten to `requireStaff` minimum (already implicit but make explicit), and consider `requireManagerRole` for any route exposing customer PII.

### S2 (P1): API key auth has no role differentiation
- One `ADMIN_API_KEY` (or comma-list of keys) maps to "all access". The two-step receipt protocol's "two-person rule" reduces to "one person who holds the key" if the key is the actor — there is no second-human gate. Combined with API key being a long-lived secret (`apps/api/src/routes/admin/index.ts:36`), a leak permanently grants full admin power until rotation.

### S3 (P2): Admin force-routes reason is unbounded for some fields
- All `reason` schemas use `.max(500)`. Verified safe.

### S4 (P2): API key length minimum check is non-strict outside production
- `index.ts:42-48` logs a warning but does not throw outside production. A dev environment with `ADMIN_API_KEY=short` will start. Acceptable for dev but the warning is easy to miss.

## Prompt injection / LLM exploit paths

### L1 (P1): LLM can propose any MUTATING tool the state allows
- `CapabilityPlanner` partitions tools into `visibleReadTools` (callable directly) and `allowedIntents` (LLM-PROPOSEABLE intents). `safePlan` asserts MUTATING tools never leak into READ list. Verified correct.
- The exploit surface is the *content* of the proposed arguments: a user-controlled prompt can manipulate the LLM into proposing `update_preferences` with `allergenExclusions: []` (clearing the customer's allergens). The allergen guard refuses if `allergenExclusions` is *not* an array, but `[]` IS an array — so the guard passes. There is no anti-takeover guard against "clear my allergens" when the user verbatim asks for it. This is intended behaviour but operationally dangerous: a confused or adversarially-prompted customer can wipe allergen safety in one turn.
- Fix consideration: confirm-prompt before destructive allergen clears (REQUEST_CONFIRMATION when transitioning from non-empty to empty).

### L2 (P2): `set_pix_details` is READ_ONLY but accepts CPF/name/email
- The tool does not mutate state — it validates and emits an event. But its arguments DO get audited via the validation kind, and a prompt-injected LLM could submit garbage PII without invoking the customer-facing UI. Defence: the route layer that consumes the resulting `PIX_DETAILS_COLLECTED` event should re-validate; the kernel-side path runs through `customer.pix.details.save` which has its own CPF-shape guard (`policies.ts:280-285`).

### L3 (P0): Tool name not on the planner can still be CALLED if it's in `STATE_TOOLS`
- `capability-planner.ts:82-97`: `resolveTools` returns the union list directly, but the runtime LLM tool registry validates tool calls against the tool registry, not against the planner. If a STATE_TOOLS entry references a tool name that lives in `TOOL_CLASSIFICATION.MUTATING`, `safePlan` raises. But if a NEW tool is added to the registry without being classified, the planner's "unknown → READ" fallback routes it as READ — exploit: a poorly-classified new tool that actually mutates becomes LLM-callable as a "read". The defence relies on the dev remembering to update `TOOL_CLASSIFICATION`. Recommend adding a compile-time check that every tool in the registry has a classification entry.

## NATS / webhook authenticity

### N1 (P0): NATS connection has no authentication
- See executive #2. `packages/nats-client/src/index.ts:29-33`. The `connect({servers: [natsUrl], reconnect: true, maxReconnectAttempts: -1})` has zero auth options. In production this means *any* process that can reach the NATS port can subscribe + publish. Infrastructure-level (firewall / VPC) is the only defence today.
- Fix: switch to nkey or JWT auth on the NATS side (Cluster credentials), and the client to read `NATS_CREDS` / `NATS_NKEY_SEED` env vars at connect time. The investigation 04 doc presumably already documents this — confirm if M4 fixed it (initial scan of the source says NO, this has not been addressed in the overnight work).

### N2 (P0): No per-message signature on NATS events
- Beyond connection auth, individual messages are not HMAC-signed. A subscriber cannot distinguish a kernel-produced `payment.status_changed` from a forged one. The grace resolver subscriber gates on Redis state which provides some defence, but `cart-intelligence`, outbox consumers, and analytics subscribers blindly trust.
- Fix: HMAC-sign event payloads with a per-topic key; verifier on each subscriber.

### N3: Stripe webhook signature
- Verified intact (`stripe-webhook.ts:534`). Stripe SDK enforces ≤300s tolerance.

### N4: Twilio webhook signature
- Verified intact (`whatsapp-webhook.ts:140`). Verified BEFORE the envelope is built (signature error at line 243-248 returns early).

## PII in audit records (post-redaction)

### P1 (P0): `actor.sessionId` carries `customerId` (HTTP path) or `admin:<staffId>` (admin path)
- Verified above (R1 / executive #3). Replicated finding.

### P2 (P1): Redacted records still flow to NATS subject
- `intent-audit-wiring.ts:202-211` emits to `ibatexas.audit.intent.decision.v1` AFTER the redactor runs. So `envelope.payload` is scrubbed but `envelope.actor`, `intentHash`, `auditHash`, decision metadata, and `kernelIdentity`/`kernelVersion`/`policyVersion` flow through. Combined with N1: any unauthorised NATS subscriber gets the full post-redact stream.

### P3 (P2): Console sink prints PII-free records to stdout
- Verified: console sink prefix is `[ibx-audit]` and writes JSON of the redacted record. Logs are presumed access-controlled at the orchestrator/k8s layer.

### P4 (P2): Postgres sink writes redacted records to `audit_intent_decisions`
- Verified: writer takes `record` after redactor. Postgres `actor` column will still carry `customerId` until R1 is fixed.

## CSRF + replay at HTTP layer

### X1 (P1): No CSRF token on cookie-authed POST routes
- Cookies are `sameSite: "lax"` (`auth.ts:404,411`) which blocks cross-origin POST forms but allows top-level GET-navigation CSRF and same-site CSRF (e.g., an XSS on `WEB_URL` can issue arbitrary POSTs with the session cookie). Customer mutation routes (cart, order-actions, me/data/*) accept POST/DELETE without a CSRF token.
- The anonymize flow's 3-step OTP gate happens to defeat direct CSRF (the OTP code must come back to the attacker), but `cart.checkout`, `order.cancel`, `order.amend.request` are CSRF-vulnerable.
- Fix: add a CSRF token (double-submit cookie pattern) for state-changing requests.

### X2 (P2): No Idempotency-Key header on customer mutation routes
- Admin product route uses `x-request-id` for dedup (`products.ts:114`). Customer mutation routes do not. A flaky network causes double-submits. The envelope's `nonce` is built fresh per request, so the kernel's audit-hash dedup does not catch this. Fix: accept `Idempotency-Key` header, mix into envelope nonce.

### X3: Replay-by-event-id (Stripe)
- Stripe webhook idempotency at `webhook:processed:{event.id}` with 7-day TTL — verified safe.

### X4: WhatsApp webhook idempotency
- `wa:webhook:{MessageSid}` 24h TTL — verified safe.

## Findings ranked (P0/P1/P2)

| # | ID | P | Domain | Title |
|---|----|---|--------|-------|
| 1 | A1 | P0 | LGPD | Stolen JWT alone authorises initiate-deletion |
| 2 | A2 | P0 | LGPD | No application-layer rate limit on OTP verify; per-initiate-deletion OTPs are independent |
| 3 | A3 | P0 | LGPD | Cancel-then-reinitiate creates a Twilio-spend / harassment loop |
| 4 | N1 | P0 | NATS | NATS connection has no auth |
| 5 | N2 | P0 | NATS | No per-message NATS signature |
| 6 | R1 / P1 | P0 | Audit | `actor.sessionId` carries plaintext `customerId` post-redact |
| 7 | S2 | P0 | Admin | API-key path bypasses role gates and two-person-equivalent |
| 8 | L3 | P0 | LLM | Unclassified new tool defaults to LLM-callable READ |
| 9 | A4 | P1 | LGPD | Pack policy state lies about `otpFresh` on cancel |
| 10 | A5 | P1 | LGPD | Grace resolver trusts unauthenticated NATS event (mitigated by Redis-state gate) |
| 11 | C1 | P1 | Admin | Concurrent-confirm race not actually tested (mock only) |
| 12 | C2 | P1 | Admin | No staff-identity binding between step-1 and step-2 |
| 13 | C5 | P1 | Admin | Refund threshold bypass via sub-threshold drip |
| 14 | S1 | P1 | Admin | Some admin GET routes lack role gates (ATTENDANT-readable PII) |
| 15 | R2 | P1 | Audit | Phone regex misses dashed-international `+55-11-99999-9999` (caught as CARD) |
| 16 | R3 | P1 | Audit | Email regex misses obfuscated forms `[at]`, `(at)` |
| 17 | L1 | P1 | LLM | No anti-takeover on allergen clear |
| 18 | X1 | P1 | HTTP | No CSRF token on cookie-authed POST routes |
| 19 | A6 | P2 | LGPD | Parked envelope in Redis stores OTP token plaintext (low impact — already consumed) |
| 20 | A7 | P2 | LGPD | anonymizeCustomer does not clear phone/reviews |
| 21 | R4 | P2 | Audit | 32-bit hash truncation collision risk |
| 22 | R5 | P2 | Audit | Stringified-JSON sub-fields walked only via regex |
| 23 | R6 | P2 | Audit | set_pix_details PII path needs e2e verification |
| 24 | C3 | P2 | Admin | Receipt enumeration timing side-channel (theoretical) |
| 25 | C4 | P2 | Admin | Redis-restart TTL bypass (DoS, not unauthorised completion) |
| 26 | S3 | P2 | Admin | Confirmed reason fields capped at 500 — OK |
| 27 | S4 | P2 | Admin | API key length minimum non-fatal outside production |
| 28 | L2 | P2 | LLM | set_pix_details argument shape needs guard at consumer |
| 29 | P3 | P2 | Audit | Console sink writes redacted records to stdout |
| 30 | P4 | P2 | Audit | Postgres sink inherits R1 plaintext customerId |
| 31 | X2 | P2 | HTTP | No Idempotency-Key on customer mutations |

---

### Notes on what was NOT a finding (negative results)

- **Stripe webhook signature**: intact, raw body parser scoped correctly.
- **Twilio webhook signature**: verified BEFORE envelope build, fail-closed on missing/invalid.
- **CSRF on admin routes**: admin uses `x-admin-key` header OR staff JWT; `sameSite: "lax"` plus CORS-credentials restriction provides reasonable defence.
- **Stripe replay**: idempotency key + Stripe's own 300s tolerance is adequate.
- **Lua atomic GET+DEL**: the script itself is correct; only the test coverage is weak (C1).
- **Numeric CPF in audit**: redactor coerces numbers under REDACT_FIELDS correctly.
- **Allergen array enforcement**: pack guard verified (`policies.ts:243-253`).
- **Customer ownership checks on order routes**: verified present (`order-actions.ts:65-92`).
- **JWT revocation fail-closed**: verified (`auth.ts:43-46`).
- **Customer rate-limit on send-otp / verify-otp**: verified (`auth.ts:90-115`); but NOT applied to anonymize OTP path — see A2.
