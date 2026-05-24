# Admin force-* + LGPD red-team audit — 2026-05-24

**Branch:** `feat/kernel-always-on-cutover` @ `c5c839c`
**Method:** read-only static review of the four admin force-* routes, the
admin-confirmation-store, the LGPD anonymize OTP gate, the anonymize-grace-
resolver, the customer.service anonymize executor, the Prisma schema, and
the W6 red-team test inventory.

---

## TL;DR

**5 bugs found.** Two are concretely exploitable in production (P0 +
P1); the rest are LGPD-scope completeness gaps (P1/P2) that would fail
a regulator's "full erasure" audit.

| # | Severity | Class | Title |
|---|---|---|---|
| 1 | **P0** | Race / Compliance | Anonymize-grace-resolver vs cancel-deletion has no lock — customer sees "canceled" while Prisma anonymizes |
| 2 | **P1** | PII residue / LGPD scope | `anonymizeCustomer` skips OrderProjection denormalized PII, ConversationMessage content, Conversation/OrderStatusHistory FKs, and Medusa-side customer row |
| 3 | **P1** | Defense-in-depth gap | `middleware/auth.ts` accepts whitespace-only `sub` — staff JWT path passes the gate; W7-G1 trim only landed inside `anonymize-otp-gate`, not auth |
| 4 | **P2** | Audit gap | Force-cancel / waive / force-status / refund payloads omit `expectedVersion` — receipt + step-2 dispatch never asserts that the projection version step-1 saw still matches at step-2 dispatch |
| 5 | **P2** | NATS dedup | `subscribeNatsEvent` uses no queue group — every API instance receives every `intent.defer.timeout`, causing N-way concurrent anonymize attempts (idempotent at the DB but not at audit/event-log) |

The W6 fixes (whitespace customerId at the gate, scan-evasion, NX
placeholder) all hold at their declared site; **finding #3 surfaces an
adjacent surface (`auth.ts`) where the same hardening was NOT
applied**.

---

## Bug 1 — Anonymize cancel-vs-resolve race (P0, LGPD compliance)

**Severity:** P0
**Files:**
- `apps/api/src/routes/me.ts:845-955` (POST /cancel-deletion)
- `apps/api/src/subscribers/anonymize-grace-resolver.ts:84-134` (resolver)
- `apps/api/src/routes/me/anonymize-otp-gate.ts:572-577` (clearPendingDeletion)

**Class:** TOCTOU race — destructive operation vs cancel.

**Attack:**

1. Customer parks anonymize at T=0. `anonymize:pending:{c}` gets 24h TTL;
   the kernel-runtime parks `defer:pending:{c}` (24h + 60s grace).
2. At T=23h 59m 59.5s the defer-timeout-sweeper publishes
   `intent.defer.timeout` (intent for the customer's anonymize).
3. The `anonymize-grace-resolver` consumes the event, calls
   `readPendingDeletion({c})` → receipt present, calls
   `anonymizeCustomer({c})`. The function opens a Prisma `$transaction`
   with `timeout = 60_000ms` and starts scrubbing the customer profile +
   addresses + preferences + reviews + order items. The TX can legitimately
   take 5-30s for a customer with thousands of reviews (see W4 P0-13
   heavy-customer batch path).
4. **At T=24h 00m 01s** — while the Prisma TX is still running — the
   customer hits `POST /api/me/data/cancel-deletion`. The handler:
   - `readPendingDeletion({c})` → receipt is STILL present (resolver has
     not yet reached `clearPendingDeletion` at line 131).
   - Builds + adjudicates the cancel envelope (kernel REFUSE-supersedes-
     parked, ~ms).
   - Calls `clearPendingDeletion(c)` → DELs `anonymize:pending:{c}`.
   - Calls `redis.del(rk('defer:pending:{c}'))` → DEL the kernel envelope.
   - Calls `setCancelCooldown(c)` → 30-min cooldown.
   - Returns 200 `{ status: "canceled" }`.
5. ~5s later the resolver's `prisma.$transaction` commits successfully.
   `await clearPendingDeletion(customerId)` runs — but it's already
   cleared. Returns `{ kind: "anonymized" }`.

**Observable outcome:** the customer has the 200 "canceled" response in
hand AND a fully anonymized profile (name → "Usuário Removido", phone →
`anonymized:{hash}`, email/cpf nulled, addresses deleted, reviews
scrubbed). The customer's account is irrecoverably destroyed despite
their cancellation succeeding from their UI's perspective.

**Damage:**
- LGPD Art. 18 §VI compliance failure: cancellation must be honored
  before erasure runs. A regulator audit that probes the cancel/resume
  race will find this.
- Civil exposure: the customer can sue for unauthorized destruction of
  their account.
- Operational: the data is gone. There is no rollback (anonymize is
  defined as terminal per W4-P0-13).
- Reputational: customer service inquiries about "I cancelled but my
  account is destroyed" are unanswerable.

**Why W4/W6 missed it:**
- The two surfaces are decoupled. The customer-facing /cancel-deletion
  endpoint only knows about `anonymize:pending:{c}` and `defer:pending:{c}`.
  The resolver only knows about `anonymize:pending:{c}`. Neither holds a
  shared lock; neither aborts when the other races.
- The W6 red-team inventory tested receipt-clear behavior in
  ISOLATION; concurrent cancel + resolver was not in the test matrix.
- The `defer-resolver` (kernel-runtime side) DOES use a two-phase SETNX
  commit + cycle counter (see `subscribers/defer-resolver.ts:508-530`).
  The `anonymize-grace-resolver` is a SEPARATE subscriber that bypasses
  that protection entirely. It is documented as "Idempotent: the receipt
  is deleted AFTER `anonymizeCustomer` runs" (line 32 comment) — but
  idempotency at the row-update level does not protect against
  concurrent cancel.

**Suggested fix:**

Acquire a Redis SETNX lock at the resolver before the Prisma TX:

```typescript
// In handleAnonymizeGraceTimeout, before anonymizeCustomer:
const lockKey = rk(`anonymize:resolving:${customerId}`);
const acquired = await redis.set(lockKey, "1", { NX: true, EX: 120 });
if (acquired !== "OK") {
  return { kind: "skipped", reason: "concurrent_resolve" };
}
// And in /cancel-deletion, before clearPendingDeletion:
const lockExists = await redis.get(rk(`anonymize:resolving:${customerId}`));
if (lockExists) {
  return reply.code(409).send({
    error: "A exclusão está sendo executada agora. Não é mais possível cancelar.",
  });
}
```

Better: encode the cancel as an SETNX `anonymize:canceled:{c}` BEFORE
clearPendingDeletion; resolver checks BOTH receipt AND cancel-sentinel
in a single Lua `EVAL` (atomic read).

---

## Bug 2 — `anonymizeCustomer` LGPD scope is incomplete (P1, compliance)

**Severity:** P1
**Files:**
- `packages/domain/src/services/customer.service.ts:591-719`
  (`anonymizeCustomer`)
- `packages/domain/prisma/schema.prisma:344-553`
  (OrderProjection, Conversation, ConversationMessage, OrderStatusHistory,
  OrderEventLog, LoyaltyAccount)

**Class:** PII residue / LGPD scope.

**Attack scenario (regulator audit):**

After `anonymizeCustomer(c)` runs, query the DB for any column
plausibly carrying `c`'s name/email/phone/cpf/address/conversation
content:

```sql
-- (1) OrderProjection denormalised PII fields — NOT scrubbed.
SELECT customer_email, customer_name, customer_phone, shipping_address_json
FROM ibx_domain.order_projections
WHERE customer_id = $1;
-- → returns the customer's ORIGINAL email, name, phone, full delivery
--   address for every order they ever placed.

-- (2) ConversationMessage.content — NOT scrubbed.
SELECT cm.content
FROM ibx_domain.conversation_messages cm
JOIN ibx_domain.conversations c ON c.id = cm.conversation_id
WHERE c.customer_id = $1;
-- → returns WhatsApp/web chat transcripts: "Meu nome é Maria",
--   "Pode entregar na Rua X, 123", "Meu CPF é …", etc.

-- (3) Conversation.customerId — NOT nulled (onDelete:SetNull, but
--     Customer row is scrubbed not deleted, so the FK trigger never fires).
SELECT id FROM ibx_domain.conversations WHERE customer_id = $1;
-- → returns rows whose FK still points to the scrubbed customer.

-- (4) OrderStatusHistory / PaymentStatusHistory.actorId — NOT scrubbed.
SELECT actor_id FROM ibx_domain.order_status_history WHERE actor_id = $1;
-- → returns the customer's id as a literal value in audit rows.

-- (5) OrderEventLog.payload (JSONB) — NOT scrubbed.
SELECT payload FROM ibx_domain.order_event_log
WHERE payload->>'customerId' = $1;
-- → returns event payloads with customer email/name/phone/address.

-- (6) LoyaltyAccount — NOT deleted (Cascade FK doesn't fire since
--     Customer row not deleted).
SELECT * FROM ibx_domain.loyalty_accounts WHERE customer_id = $1;

-- (7) Reservation.specialRequests JSONB — may contain free-form
--     customer-typed text (notes). NOT scrubbed.

-- (8) Medusa-side `customer` table — entirely outside the IBX scrub.
--     The Medusa order row still carries customer.email, .first_name,
--     .last_name, .phone, etc.
```

**Damage:**
- LGPD Art. 18 §III ("eliminação dos dados pessoais tratados") is not
  satisfied. The customer has the right to FULL erasure; partial erasure
  is non-compliance.
- ANPD (Autoridade Nacional de Proteção de Dados) audit risk: any
  reasonable forensic SQL of the listed columns demonstrates the data
  was NOT erased.
- Practical risk: the chat history alone is a long-form PII trove
  (name, address, payment info, dietary restrictions, family details
  customers volunteer in restaurant chat).
- Downstream caches: Redis intelligence/loyalty buffers, embedding
  caches (`packages/llm-provider`) MAY contain customer PII —
  not investigated in this audit but call-out for follow-up.

**Why W4-P0-13 missed it:**

The W4-P0-13 commit (audit 05 §"A1/A2/A3 expansion") was billed as
"completeness fix" but explicitly scoped to:
- `phone` → sentinel
- `cpf` → null
- `Review.comment` → null
- (everything else already handled pre-W4)

The commit's comment at `customer.service.ts:482-510` enumerates ONLY
the directly-on-Customer-row identifiers. It does NOT enumerate the
6+ other tables that carry customer PII via either FK + denormalized
columns or free-form JSON.

**Suggested fix:**

Expand `anonymizeCustomer` to scrub OR rely on FK cascade for:
1. `OrderProjection.{customerEmail, customerName, customerPhone,
   shippingAddressJson}` — UPDATE these columns to null for all rows
   matching customerId.
2. `ConversationMessage.content` — UPDATE to `'[redacted]'` for all
   messages in conversations where customerId=$1.
3. `Conversation.customerId` — explicit SET NULL (don't rely on the
   FK trigger since the Customer row isn't deleted).
4. `OrderStatusHistory.actorId`, `PaymentStatusHistory.actorId` —
   UPDATE to null where actorId = customerId (the customer-initiated
   transitions; admin-driven ones are not relevant).
5. `OrderEventLog.payload` — strip customer email/name/phone from
   the JSONB. (Hard, since the schema is open. A simpler approach:
   add a `customerId` indexed column and skip event-log scrubbing
   in favor of a hash-of-customerId lookup, or document the residue
   as known LGPD-acceptable-aggregate.)
6. `LoyaltyAccount` — DELETE the row (Cascade FK works, but explicit
   delete makes the contract loud).
7. `Reservation.specialRequests` — strip / set to `[]`.
8. `Medusa /admin/customers/{medusaId}/anonymize` — issue a Medusa
   API call to scrub the commerce-side row. (Medusa may not have a
   native anonymize endpoint; a `customer.update` with nulled fields
   is the workaround.)
9. **Redis cache invalidation** — enumerate every `rk()` namespace
   that may key on customerId (`cart:`, `loyalty:`, `intelligence:`,
   `whatsapp:session:`) and DEL.

---

## Bug 3 — `auth.ts` `sub` empty-string-only guard (whitespace bypass) (P1)

**Severity:** P1
**File:** `apps/api/src/middleware/auth.ts:64-66, 94-97, 124-132`

**Class:** Whitespace bypass — same defect as W6-P0-NEW-W6-2 but at the
auth middleware, not at the anonymize gate.

**Attack:**

Forge a JWT with `sub: "   "` (3 spaces), `userType: "customer"`. The
JWT is signed with the same secret as legitimate tokens — assume an
insider with secret access, or a JWT-confusion exploit, or a leaked
signing key (the standard threat model for the whitespace bypass).

```typescript
// middleware/auth.ts:64-66
if (typeof payload.sub !== "string" || payload.sub === "") {
  return;
}
// "   " is a string AND it is NOT === "" → passes.
request.customerId = payload.sub;  // = "   "
```

`request.customerId = "   "`. `requireAuth` then runs:

```typescript
if (!request.customerId || request.customerId === "") {  // !"   " is false, "   " !== ""
  // → NOT triggered. requireAuth lets the request through.
}
```

The whitespace customerId now reaches the route handler. At the
anonymize-otp-gate layer the `assertCustomerId` does fail-closed (W7-G1
fix), so the bare anonymize calls 500 rather than 200. But:

- **All non-anonymize routes** that take `request.customerId` and pass
  it downstream WITHOUT a follow-up `.trim()` guard inherit the
  whitespace foot-gun. Quick sample:
  - `apps/api/src/routes/cart.ts` — search for `request.customerId`
    usages; if they flow into Redis keys built without `rk()`-equivalent
    canonicalisation, two stolen JWTs with `sub="abc"` vs `sub=" abc "`
    land different keys.
  - `apps/api/src/routes/orders.ts` and `order-actions.ts` — `customerId`
    flows into envelope payloads (`actor.sessionId = customerId`).
    Whitespace customerId → whitespace sessionId → kernel audit logs the
    sentinel literally, partially defeating audit's pseudonymous hashing
    purpose.
- The W6 fix ONLY landed at `anonymize-otp-gate.ts:101-120`. The
  middleware layer was NOT updated. The W6 test
  (`01-customerid-whitespace-bypass.test.ts:127-131`) EXPLICITLY calls
  out the recommendation to fix `middleware/auth.ts:64,95,127` — but
  W7-G1 closed it only at the gate.

**Damage:**
- Defense-in-depth gap: the guard exists at ONE layer only.
- For anonymize: 500 errors instead of clean 401 → unnecessary log
  noise + potentially leak stack traces in dev.
- For non-anonymize routes (cart, orders, conversations): the
  whitespace customerId pollutes downstream state, kernel audit
  pseudonymisation, Redis namespacing.

**Suggested fix:**

Apply the same trim+canonicalise at `middleware/auth.ts`:

```typescript
// auth.ts:64 (and :95)
const subRaw = payload.sub;
if (typeof subRaw !== "string" || subRaw.trim().length === 0) {
  return;
}
const sub = subRaw.trim();
// ...
request.customerId = sub;  // canonical
```

And at `requireAuth:127`:

```typescript
const id = request.customerId;
if (typeof id !== "string" || id.trim().length === 0) {
  void reply.code(401).send({ /* ... */ });
  return;
}
```

This is a 6-line change in one file. The cost of leaving it open is
ongoing whitespace-amplifier risk for every new route that consumes
`request.customerId`.

---

## Bug 4 — Force-* payloads omit `expectedVersion` (P2, audit clarity)

**Severity:** P2 — not directly exploitable for state corruption (the
domain's `canTransition` matrix blocks the unsafe transitions), but
breaks an audit invariant: step-1's view of the projection version is
NOT pinned at step-2 dispatch.

**Files:**
- `apps/api/src/routes/admin/order-actions.ts:174-180` (force-cancel
  step 1 payload — no expectedVersion)
- `apps/api/src/routes/admin/order-actions.ts:568-574` (waive step 1
  payload — no expectedVersion)
- `apps/api/src/routes/admin/payments.ts:996-1002` (force-status step 1
  payload — no expectedVersion)
- `packages/domain/src/services/order-command.service.ts:312-313` (the
  concurrency check is GATED on `expectedVersion !== undefined`)

**Class:** TOCTOU window between step 1 + step 2 — narrowed by other
defenses but not closed for audit purposes.

**Attack:**

1. T=0: Operator A initiates `POST /api/admin/orders/X/force-cancel`.
   Step 1 reads `order.fulfillmentStatus = PENDING`, `order.version = 5`.
   The receipt's payload stores `newStatus = CANCELED` but NO
   `expectedVersion`.
2. T=2s: Customer X transitions the order via `/api/orders/X/cancel`
   (customer-initiated). The order moves PENDING → CANCELED, version 5
   → 6.
3. T=5s: Operator B confirms via `POST .../force-cancel/confirm`. The
   re-read at line 314-327 sees `fulfillmentStatus = CANCELED` (terminal)
   → returns 422 "Pedido já está em estado terminal". OK, defended at
   the route-layer pre-check.

So the simple race is defended. But consider:

1. T=0: Operator A initiates force-cancel on a PENDING order, version 5.
2. T=2s: Customer's order moves PENDING → CONFIRMED → PREPARING (via
   any of three independent triggers: customer cancel + auto-uncancel,
   another admin's advance, a Stripe webhook restarting the lifecycle
   if it exists). Version is now 7.
3. T=5s: Operator B confirms. The route's terminal-state pre-check passes
   (PREPARING isn't terminal). The envelope is built with the STORED
   payload (no expectedVersion). The `canTransition(PREPARING, CANCELED)`
   matrix allows it. The kernel EXECUTEs. Order moves PREPARING → CANCELED
   at version 8.

The customer-facing outcome is the same as expected (the order is
cancelled), but **the audit record has no way to distinguish "operator
acted on version 5 evidence" from "operator acted on version 7 evidence"**.
The `previousStatus` recorded in the `order.canceled` event is PREPARING,
not the PENDING the operator saw at step 1. If the order traversed
significant state during the 10-min receipt window (a non-pathological
scenario for restaurant orders), the audit trail mis-represents the
operator's intent.

**Damage:**
- Forensic / audit clarity loss. An auditor asking "what did the
  operator see when they initiated force-cancel?" has no way to know
  from the audit record alone.
- Not directly exploitable for over-write attacks — the kernel's
  `transitionStatusFromEnvelope` still validates `canTransition`. The
  fulfillment matrix happens to permit cancel from all non-terminal
  states, but if a future state were added that should NOT cancel from
  some predecessor (e.g., a future "shipped" state), this omission
  becomes exploitable.

**Suggested fix:**

Capture the version at step 1 and include in the receipt payload:

```typescript
// order-actions.ts:174 — add to payload
const payload: OrderStatusTransitionPayload = {
  orderId: id,
  newStatus: OrderFulfillmentStatus.CANCELED,
  actor: "admin",
  expectedVersion: order.version,   // ← step-1's view
  ...(staffId ? { actorId: staffId } : {}),
  reason,
};
```

Same for waive (`paymentId` payment.version), force-status, etc. At
step 2 the kernel will emit `ConcurrencyError` if the projection has
moved; the route already imports `ConcurrencyError` from
`@ibatexas/domain` and can map it to 409 (same handling as the
existing `PATCH /api/admin/orders/:id` route at orders.ts:354-355).

---

## Bug 5 — `subscribeNatsEvent` has no queue group → N-way duplicate handler (P2)

**Severity:** P2 — idempotency at DB level holds, but the audit/event-log
layer accumulates duplicate rows; metrics double-count; logging is N×
noisy in multi-instance deployments.

**Files:**
- `packages/nats-client/src/index.ts:299-326` (subscribeNatsEvent)
- `apps/api/src/subscribers/anonymize-grace-resolver.ts:144-161`
  (subscription wiring)

**Class:** Distribution fan-out — every API instance receives every event.

**Attack:**

In a 3-replica production deployment, every `intent.defer.timeout`
event is received and handled by 3 instances of the
anonymize-grace-resolver simultaneously. Each instance:

1. Reads `anonymize:pending:{c}` → present.
2. Calls `anonymizeCustomer(c)`.
3. Calls `clearPendingDeletion(c)`.

The Prisma `updateMany`s are idempotent at row-update level (no
columns flip back); the DELETEs are idempotent (row doesn't exist).
But:
- 3 audit-log rows for each cancel-deletion → triple-counted in
  metrics + dashboards.
- 3 NATS publishes of any downstream side effects (the resolver does
  NOT publish anything, but a future refactor adding e.g.
  `analytics.customer_anonymized` would publish 3×).
- 3 log lines per resolution → log volume amplification.
- Worst case: a downstream subscriber that is NOT idempotent (a
  send-email-confirming-deletion subscriber, if added) would deliver
  3 emails.

**Damage:**
- Operational noise. Metrics inflated. Logs noisy. Cost amplified.
- Combined with Bug 1 (cancel race): a customer cancelling at the
  race window has 3 concurrent resolver instances + a cancel — the
  per-instance race exposure narrows but the cancel-vs-any-of-them
  race is the same.

**Why this wasn't caught:**
- All tests run in a single-process Vitest harness. The N-way fan-out
  is invisible without a multi-replica integration test.
- The defer-resolver (kernel-runtime side) DOES SETNX-claim resuming
  slots — that defends most legitimate uses. The anonymize subscriber
  is the exception that bypasses that protection.

**Suggested fix:**

Either:
1. Add a queue group to `subscribeNatsEvent` (NATS core supports
   `queue`-style subscriptions; `nats.subscribe(subject, { queue:
   "anonymize-grace-resolver" })` ensures only one subscriber in the
   group receives each message); OR
2. Combine with Bug 1's fix — the SETNX lock per `customerId` already
   gives single-execution semantics across instances.

(2) is cheaper since the same code change closes Bug 1 too.

---

## W6 fix-verification table

| W6 finding | W7 claimed fix | Verified? |
|---|---|---|
| **P0-NEW-W6-1** (verifyParkedEnvelopeHash inert — only `actorPrincipal` hoisted, version/nonce/taint not) | W7-G3 — fail-loud refuse on missing-fields at both adopter (NX-wrapper) and consumer (defer-resolver) | ✅ — `apps/api/src/adapters/park-deferred-intent-nx.ts:174-197` refuses to write missing-fields blobs; `apps/api/src/subscribers/defer-resolver.ts:433-461` refuses to resume them. Tests at `adapters/__tests__/park-deferred-intent-nx-hash.test.ts` exercise round-trip + tamper detection. |
| **P0-NEW-W6-2** (whitespace customerId bypass at `anonymize-otp-gate`) | W7-G1 — `assertCustomerId` trim-aware + canonicalising | ✅ at the gate — `apps/api/src/routes/me/anonymize-otp-gate.ts:110-137`. ❌ **at the middleware** — `apps/api/src/middleware/auth.ts:64-66, 94-97, 124-132` STILL checks `=== ""` and propagates whitespace customerId through `requireAuth`. See Bug 3 above. |
| **P0-NEW-W6-3** (template-literal scan evasion — backtick `method:` not detected) | W7-G2 — broaden the bypass-detection regexes | ⚠️ Not re-verified in this audit (out of scope — the regex lives in `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts` and was a CI-gate concern, not a runtime exploit). |
| **W6-3a** (clearOtpLockout does not reset failure counter) | Out-of-scope for W7-G1/G2/G3 — flagged P2 documentation pin | ➖ Not claimed fixed; documented as ops-UX gotcha. |
| **W6-3b** (NX placeholder window) | Out-of-scope — documented as forward hazard | ➖ Not claimed fixed; documented. |

---

## Methodology / clean surfaces

### Verified-clean
- **Same-actor enforcement (P0-5 / P0-5-TRUE)** — `admin-confirmation-store.ts:223-286` correctly fail-closes on null staffId, on actor-type mismatch, AND on same-staffId. Receipts are drained on every refusal branch. Whitespace staffId is normalised by `normalizeStaffId:180-184` (same trim guard as the OTP gate). ✓
- **Receipt scope by `{route, orderId}`** — every step-2 route asserts both `pending.route !== "force-cancel" | "waive" | "refund" | "force-status"` AND `pending.orderId !== id`. Cross-route replay returns 410. ✓
- **Receipt single-use** — `consume()` is atomic Lua GET+DEL. A second `consume(id)` returns null. Tested explicitly in `apps/api/src/routes/admin/__tests__/force-routes-governance.test.ts:1481-1591`. ✓
- **Refund daily-drip cap (P1-I-TRUE)** — atomic Lua check+INCR+EXPIRE at `payments.ts:158-220`. Cap is reservation-based; failed kernel decisions roll back via `rollbackDailyRefundReservation:228-235`. No read-then-write window. ✓
- **OTP atomic INCR + lockout sentinel (P0-X-OTP)** — Lua `OTP_ACQUIRE_ATTEMPT_LUA` at `anonymize-otp-gate.ts:397-417` performs INCR + threshold compare + sentinel-set in one round-trip. The Twilio round-trip can no longer race. ✓
- **OTP brute force scope per-customer** — counter keyed by `rk('anonymize:fail:{customerId}')`. ✓
- **API-key role registry (P1-H)** — `requireManagerRole`/`requireOwnerRole` fail-closed when `adminApiKeyRole` is undefined; outer guard timing-safe-compares the key (`admin/index.ts:148-164`). A leaked admin key without registry mapping cannot reach destructive routes. ✓
- **OWNER-only on force-status + waive** — preserved at `payments.ts:977-979, 1061-1063` and `order-actions.ts:541-544, 631-633`. JWT path: explicit role check. API-key path: `adminApiKeyRole === "OWNER"` via `requireOwnerRole`. ✓
- **LGPD initiate-deletion requires fresh verify-otp + outside cancel-cooldown** — `me.ts:387-404` (P0-11 stolen-JWT defense). ✓
- **WhatsApp anonymize NOT reachable** — `grep` confirms no `anonymize`/`customer.anonymize` references in `apps/api/src/whatsapp/`. The destructive flow is HTTP-only. ✓
- **`requireManager` (force-cancel) is JWT-only** — `force-cancel` uses `requireManager`, not `requireManagerRole`, so API-key callers cannot reach force-cancel at all (only `requireManagerRole` accepts API-key). The `actorPrincipal: "system"` branch in `principalFor()` is dead code on that route, but not exploitable. ✓
- **Receipt key UUID-shaped + Redis-namespaced** — `confirmationId` is `randomUUID()`. `consume()` returns null on non-UUID-shaped input (`admin-confirmation-store.ts:332-338`). No path to forge a receipt by guessing the id. Compromise of Redis is the residual threat; that's the standard infra-trust assumption. ✓
- **`me/cancel-deletion` clears both gate-receipt AND kernel envelope** — `me.ts:923-929` DEL `defer:pending:{c}`. (Best-effort wrap is acceptable — sweeper backstops in case Redis blip.) ✓
- **Payment-id swap defense at step 2** — `order-actions.ts:727-731` (waive) and `payments.ts:850-854` (refund) re-read activePayment and 409 if the payment id moved. ✓
- **30-min cancel-cooldown after cancellation** — `me.ts:935` setCancelCooldown. Kills the harassment + Twilio-spend loop. ✓
- **Refund OVER_REFUND defense at step 2** — `payments.ts:857-865` re-computes refundable and 422s if exceeded. ✓

### Surfaces examined
- The four admin force-* routes (force-cancel, refund step 1+2, waive, force-status).
- The `admin-confirmation-store` (create + consume + same-actor check).
- The four `me/anonymize` endpoints (send-otp, verify-otp, initiate-deletion, cancel-deletion, legacy DELETE).
- The OTP gate (otp send/verify/freshness, lockout sentinel, cancel-cooldown, pending-deletion receipt).
- The anonymize-grace-resolver subscriber.
- `anonymizeCustomer` executor + the Prisma schema for residual PII surfaces.
- Auth middleware `requireAuth` / `extractAuth`.
- The wave6-red-team test inventory.

---

## Open questions

1. **Cache-layer LGPD audit**: this audit did NOT enumerate Redis cache
   keys that may contain customer PII (`cart:`, `loyalty:`,
   `intelligence:embedding:`, `whatsapp:session:{phone}:`, etc.). A
   follow-up scoped to "every `rk()` namespace + does it carry
   customer-identifiable data + is it cleared on anonymize?" would
   complete the LGPD scope picture. Estimate: ~2-3h. Likely produces
   3-5 additional cache-residue findings.
2. **Medusa-side customer scrub**: Bug 2 calls out that Medusa retains
   the customer row. Is there a documented decision that Medusa is
   out-of-scope for LGPD anonymize (e.g., because it's an internal
   B2B record not exposed to the customer), or is this a known gap?
   The CLAUDE.md ADR #9/#13 does not address this.
3. **`OrderEventLog` payload scrubbing strategy**: the table is
   declared append-only-immutable (line 412). LGPD compliance and
   append-only-audit are in tension. A column-level encrypted-with-
   per-customer-key approach lets you "erase" by destroying the key
   without rewriting rows. Worth a design session.
4. **Defer-grace-resolver hardening priority**: Bug 1 + Bug 5 share a
   fix (SETNX per-customer lock). Confirm with stakeholders this is
   the right path before the implementation agent picks it up.
5. **Multi-instance integration test**: the codebase has no test
   harness that simulates >1 API instance. The defer-resolver double-
   dispatch problem (Bug 5) and any future cross-instance race need
   a `@testcontainers/nats` harness with two subscriber processes.

---

## Top-3 attacks by leverage

1. **Bug 1 (cancel-vs-resolve race)** — LGPD violation with civil and
   regulatory exposure. Window is narrow (~5-30s during the customer's
   slow anonymize TX, EXACTLY at the 24h mark) but the customer can
   trigger it deliberately by polling cancel-deletion in the last
   minutes of the grace window. **The customer can choose to land in
   the race.**
2. **Bug 2 (PII residue)** — not a single-incident exploit; a regulator
   audit finding. ~8 tables / columns retain PII after `anonymizeCustomer`
   runs. ANPD finds it on the first SQL probe.
3. **Bug 3 (whitespace `sub` at auth middleware)** — defense-in-depth
   gap for the auth layer. Not immediately exploitable for state
   corruption (the gate fail-closes), but every new route that takes
   `request.customerId` inherits the foot-gun. The fix is 6 lines.
