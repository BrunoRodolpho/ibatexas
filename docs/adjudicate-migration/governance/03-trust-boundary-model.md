> **NOTE — load-bearing with localized stale refs.** The `UNTRUSTED < TRUSTED < SYSTEM` taint lattice and per-boundary identity assertions below are still authoritative for `IntentActor.taint`. **Exception:** lines 83 and 148 reference `setKillSwitch` and `IBX_KERNEL_ENFORCE` — both deleted by the IBX-IGE v3.0 cutover (`f3bea43`); ignore those bypass-callout rows. See `README.md` in this directory for the full classification.

---

# 03 — Trust Boundary Model

> Companion to: [`01-intent-taxonomy.md`](./01-intent-taxonomy.md), [`02-capability-model.md`](./02-capability-model.md), [`04-decision-policy.md`](./04-decision-policy.md).
> Sources: investigations [02](../investigation/02-api-webhook-mutations.md), [04](../investigation/04-background-jobs-nats.md), [08](../investigation/08-security-trust-boundaries.md).

## Executive summary

- ibatexas has **seven** distinct trust crossings (Anonymous → Customer, Customer → Staff, Staff → Admin, Admin → System, System → Webhook, Webhook → Subscriber, Subscriber → Command Service). Each crossing has a defined identity assertion, a kernel-layer adjudication contribution, and a recommended `TaintPolicy` composed from `@adjudicate/primitives.createSystemTaintPolicy`.
- **Today every crossing past Customer → Staff is enforced only by middleware**, not by adjudicate. The Stripe/Twilio signature checks gate `Anonymous → Webhook` correctly, but once inside the process the webhook turns into direct Prisma writes with zero kernel review (investigation 02 §"Webhook handlers"). The kernel must own the post-signature trust transition.
- The `taint` lattice — `UNTRUSTED < TRUSTED < SYSTEM` per investigation 05 — encodes provenance. Customer-facing intents default UNTRUSTED; staff JWT raises to TRUSTED; verified webhook + cron raise to SYSTEM. The taint guard runs **after** state and **before** auth in `adjudicate()` evaluation order (per `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/kernel/`).
- **NATS broker has no per-message auth today** (investigation 04 §"P0 #1-2", investigation 08 §"Webhook signature verification table"). A subscriber that mints `system`-actor envelopes from an unauthenticated forged NATS publish is the loudest residual risk. Mitigation: per-message HMAC or NATS NKey auth before any enforce flip on subscriber-driven intents.
- Every boundary crossing requires an explicit envelope construction with the **target** trust level, not the source's. `IntentActor.taint` is set at the crossing site, not inherited from the caller. Cross-boundary inheritance via `mergeTaint(a, b)` (per investigation 05 — "lattice helpers") only narrows; never broadens.

## The trust lattice

From `@adjudicate/core` (per investigation 05):

```
SYSTEM   ── highest authority (cron, NATS subscriber, verified webhook)
   ↑
TRUSTED  ── authenticated staff/admin OR signed webhook payload before unpack
   ↑
UNTRUSTED ── anonymous public, authenticated customer, LLM proposal
```

`canPropose(taint, kind, policy)` (per investigation 05 — `core` export) is the taint gate primitive. The recommended `TaintPolicy` instance comes from `createSystemTaintPolicy({systemOnlyKinds, userMinimum, systemMinimum})` (per investigation 05 §"primitives"). The systemOnlyKinds allowlist is the subset of [`01-intent-taxonomy.md`](./01-intent-taxonomy.md) §"Default refuse policy" `SYSTEM_ONLY_KINDS`.

| `Taint` | Actor sources | Allowed to propose |
|---|---|---|
| `UNTRUSTED` | Anonymous web, authenticated customer, LLM proposal | All non-systemOnly kinds (subject to per-kind business + auth guards). |
| `TRUSTED` | Staff JWT, admin API key, signed Stripe/Twilio webhook **after signature verify but before payload unpack** | Same as UNTRUSTED + staff/admin-only kinds (`payment.refund.issue`, `order.cancel.force`, `payment.waive`, etc.). |
| `SYSTEM` | Cron jobs, NATS subscribers minting envelopes from already-trusted state, kernel-internal supersession (DEFER resume, REWRITE execute) | Everything including `systemOnlyKinds`. |

## Boundary inventory

Each row: the crossing direction, the identity assertion that must hold to traverse, the kernel adjudication contributed at the crossing site, the recommended `TaintPolicy` posture, and the current bypass shape (with file:line where applicable).

### Boundary 1 — Anonymous public → Authenticated customer

| Slot | Value |
|---|---|
| Where it crosses | `POST /api/auth/send-otp` → `POST /api/auth/verify-otp` (investigation 08 §"Customer auth flow") |
| Identity assertion | Twilio Verify code valid + phone-hash brute-force not locked out (investigation 08 — 5 fails/h, 10 OTP/h/IP, 3 OTP/10min/phone) |
| New intent kinds at crossing | `customer.create`, `customer.session.issue` ([`01-intent-taxonomy.md`](./01-intent-taxonomy.md) §"customer") |
| Adjudication contribution | Rate-limit guard via `createRateLimitGuard` (investigation 05 §"rate-limit primitives") composed into the customer-onboarding Pack. Default REFUSE on unverified-OTP path. |
| Recommended TaintPolicy | `createSystemTaintPolicy({systemOnlyKinds: ["customer.session.issue", "customer.create"], userMinimum: "UNTRUSTED", systemMinimum: "SYSTEM"})` — the session issuance itself is system-authoritative; the customer's identity claim is UNTRUSTED until OTP-verified |
| Current bypass | `POST /api/auth/verify-otp` creates Customer + issues JWT with no envelope (investigation 08 §"Auth-related mutations gaps") — pure Prisma upsert |
| Migration target | Wrap OTP-verify in `customer.session.issue` envelope built by the route with `system` actor and `TRUSTED` taint after Twilio verification succeeds |

### Boundary 2 — Authenticated customer → Staff

| Slot | Value |
|---|---|
| Where it crosses | Staff JWT issued via `POST /api/auth/staff/verify-otp`; subsequent `staff_token` cookie on `/api/admin/*` |
| Identity assertion | `staff.role ∈ {ATTENDANT, MANAGER, OWNER}` from Staff table + `active = true` (investigation 08 §"Staff/admin auth flow") |
| New intent kinds at crossing | All `payment.refund.issue`, `payment.cash.confirm`, `order.cancel.force`, `order.note.add` (staff variant), `reservation.{checkin,complete,cancel}`, schedule mutations |
| Adjudication contribution | Auth guard per kind — `requireRole({minRole: "MANAGER"})` style guard; current `requireManagerRole` middleware moves into the policy bundle so role check happens **inside** `adjudicate()` and is reflected in `AuditRecord.decision_basis` with category `auth` and code `scope_sufficient`/`scope_insufficient` (per `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/basis-codes.ts:32-36`) |
| Recommended TaintPolicy | Staff JWT path raises taint to `TRUSTED`. The envelope built by an admin HTTP route declares `actor.taint = "TRUSTED"` if `req.user.userType === "staff"`. |
| Current bypass | All 27 admin mutating routes bypass kernel (investigation 02 §"Admin surface analysis"). Force-cancel, refund, waive, force-payment-status are unaudited beyond Fastify access log. |
| Migration target | Wrap each admin route in `buildEnvelope({actor: {principal: "user", taint: "TRUSTED", sessionId: \`staff:${staffId}\`}}) → adjudicateAndAudit` |

### Boundary 3 — Staff → Admin (privilege escalation within staff roles)

| Slot | Value |
|---|---|
| Where it crosses | OWNER-only ops: `PATCH /api/admin/orders/:id/payment/status`, `POST /api/admin/orders/:id/waive` (investigation 02 §"Admin surface table") |
| Identity assertion | `staff.role === "OWNER"` |
| New intent kinds at crossing | `payment.status.force`, `payment.waive` |
| Adjudication contribution | Auth guard `requireRole({minRole: "OWNER"})` inside the policy bundle. **Always REQUEST_CONFIRMATION** for these kinds per [`04-decision-policy.md`](./04-decision-policy.md) §"Confirmation policy table" (destructive, irreversible). |
| Recommended TaintPolicy | TRUSTED (same as staff); the distinction is at the auth guard level, not taint |
| Current bypass | OWNER role check is in the route handler (`if (req.user.role !== "OWNER")`) — no audit envelope (investigation 08 §"Auth-related mutations gaps") |
| Migration target | Add `payment.status.force` and `payment.waive` to `KNOWN_INTENT_KINDS`; bundle has an auth guard producing `auth/scope_insufficient` for non-OWNER. Confirmation receipt flow per `pack-deployments-approval` pattern (investigation 05 §"pack-deployments-approval"). |

### Boundary 4 — Admin → System actor

> **Updated 2026-05-24 post-cutover:** the IBX-IGE v3.0 cutover (`f3bea43`) removed the `setKillSwitch()` API and the kill-switch / shadow / enforce admin surfaces. The `system.kernel.kill_switch.toggle` intent and the planned `POST /api/admin/kernel/kill*` routes are **DEPRECATED**. The remaining `system.*` intents (`replay.run`, `backfill.execute`, `pack.register`) are still meaningful at this trust boundary; the `kill_switch.toggle` row below is kept only for historical traceability.

| Slot | Value |
|---|---|
| Where it crosses | Admin operator action triggers a system effect: ~~`system.kernel.kill_switch.toggle`~~ (DEPRECATED post-cutover), `system.replay.run`, `system.backfill.execute` ([`01-intent-taxonomy.md`](./01-intent-taxonomy.md) §"system") |
| Identity assertion | Admin (OWNER role OR `x-admin-key` header) + 2FA receipt (`confirmationReceipt` per investigation 05 — `AdjudicateAndAuditDeps`) |
| New intent kinds at crossing | The remaining `system.*` kinds (kill-switch family is deprecated post-cutover) |
| Adjudication contribution | Always REQUEST_CONFIRMATION; the receipt flow consumes a token issued from a separate admin endpoint, mirroring `pack-deployments-approval`'s deploy-approval → resolve → kernel-substitute-EXECUTE pattern |
| Recommended TaintPolicy | Source actor stays TRUSTED; the **emitted** envelope carries `actor.taint = "SYSTEM"` because it crosses into system-only authority. Set explicitly at construction, not inherited. |
| ~~Current bypass~~ (HISTORICAL) | Pre-cutover note: no admin endpoint exposed `setKillSwitch()`. Post-cutover this row is moot — the `setKillSwitch()` API no longer exists. |
| ~~Migration target~~ (HISTORICAL) | The kill-switch admin routes were superseded by "no kill switch needed" — the always-on kernel removed the failure mode they were designed to recover from. |

### Boundary 5 — System actor → External webhook

| Slot | Value |
|---|---|
| Where it crosses | Stripe webhook endpoint `POST /api/webhooks/stripe`, Twilio webhook `POST /api/webhooks/whatsapp` (investigation 02 §"Webhook handlers") |
| Identity assertion | Provider signature verified: `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)`, `twilio.validateRequest(authToken, sig, url, body)` (investigation 08 §"Webhook signature verification table") |
| New intent kinds at crossing | `payment.charge.confirm`, `payment.charge.fail`, `payment.charge.expire`, `payment.charge.cancel`, `payment.refund.confirm`, `payment.dispute.open`, `customer.create` (WhatsApp auto-auth) |
| Adjudication contribution | Signature verification is **outside** the kernel (route-handler stage). After verification, the route builds an envelope with `actor.principal = "system"`, `actor.taint = "TRUSTED"` (signature proves provider identity but payload may still misalign with our state), `actor.sessionId = "webhook:stripe:{event.id}"`. Idempotency guard via `createIdempotencyGuard` (investigation 05 §"primitives") keyed on `event.id` short-circuits replays. |
| Recommended TaintPolicy | TRUSTED for the envelope; the kernel may then raise to SYSTEM internally if the payload reconciles with internal state (e.g. matching Payment row exists). |
| Current bypass | Stripe webhook directly calls `paymentCmdSvc.reconcileFromWebhook`, `medusaStore.complete`, `publishNatsEvent("order.placed")` (investigation 02 §"Stripe webhook" — 9-step side-effect chain) |
| Migration target | Each Stripe event type becomes its own envelope kind. Master plan §"Workstreams WS3" + investigation 02 §"Phase API-1". |

### Boundary 6 — External webhook → Internal NATS subscriber

| Slot | Value |
|---|---|
| Where it crosses | Webhook publishes to NATS (e.g. Stripe webhook publishes `payment.status_changed`); subscribers (`payment-lifecycle.ts`, `cart-intelligence.ts`) consume and mutate (investigation 04 §"NATS subscribers inventory") |
| Identity assertion | **None today** (investigation 04 §"P2 #13 — No NATS broker auth"). Connection-level NATS auth (NATS_URL credentials) only — no per-message signing. A compromised internal pod can forge any event. |
| New intent kinds at crossing | `order.status.reconcile`, `customer.loyalty.stamp.award`, `payment.charge.confirm` (subscriber-amplified path) |
| Adjudication contribution | Per-message HMAC or NATS NKey auth (investigation 04 §"Recommendation Operational #6") **before** the subscriber mints a system-actor envelope. The envelope then carries `actor.taint = "SYSTEM"` because the subscriber's role is to consume already-trusted internal state. The HMAC seed is `(eventId, publisherActor, publisherIntentHash)` — verified by the subscriber, recorded in `IntentEnvelope.taint`. |
| Recommended TaintPolicy | SYSTEM for the subscriber-emitted envelope, but **only if** message-level auth holds. Without per-message auth, taint **must** stay TRUSTED (cannot trust the broker for system-only kinds). |
| Current bypass | Every NATS subscriber (`cart-intelligence:order.placed` creates Payment + LoyaltyAccount; `payment-lifecycle:payment.status_changed` auto-confirms orders) runs without envelope (investigation 04 P0 #1-3) |
| Migration target | Subscriber builds envelope keyed on `eventId` (`actor.sessionId = "sub:order.placed:{eventId}"`), passes through `adjudicateAndAudit` with the system Pack. Master plan §"Workstreams WS3" Phase API-4. |

### Boundary 7 — Internal subscriber/job → Command service

| Slot | Value |
|---|---|
| Where it crosses | Subscriber or cron job calls `OrderCommandService.transitionStatus`, `PaymentCommandService.create`, `CustomerService.upsertFromPhone`, etc. (investigation 03 §"Recommended adjudication entry points") |
| Identity assertion | The subscriber/job **must** have already crossed Boundary 6 (or Boundary 5 if cron-initiated). Identity = `actor.principal = "system"` with `actor.sessionId` describing the job/subscriber. |
| New intent kinds at crossing | All command service methods become `*.transition`, `*.create`, `*.cancel.system` ([`01-intent-taxonomy.md`](./01-intent-taxonomy.md) — every kind with a `sys` actor) |
| Adjudication contribution | Command service signature changes from `transitionStatus(orderId, args)` to `transitionStatus(envelope: IntentEnvelope<"order.status.transition", ...>, deps)`. The kernel runs **before** the Prisma transaction; on EXECUTE the service performs the DB write under its existing `withLock`. Audit emit fires inside the lock-protected section so audit ordering matches mutation ordering (investigation 03 §"Locks ≠ audit"). |
| Recommended TaintPolicy | Inherits the subscriber/job's taint (SYSTEM or TRUSTED). Command service does **not** mint new taint; it consumes the envelope's. |
| Current bypass | All 50 Prisma mutation sites + Medusa HTTP hops bypass kernel (investigation 03 §"Adjudication coverage today: zero") |
| Migration target | Single chokepoint per service per investigation 03 §"Recommended adjudication entry points table". OrderCommandService, PaymentCommandService, ReservationService, CustomerService, MessageCommandService (new). |

## Cross-boundary inheritance rules

A single user action can traverse multiple boundaries — e.g. customer chats → LLM proposes `order.checkout.create` → kernel says EXECUTE → checkout creates Stripe PaymentIntent → Stripe later sends `payment_intent.succeeded` webhook → subscriber confirms order. Three boundary crossings; three envelopes; three kernel calls.

**Taint never broadens.** A customer-initiated chain that starts UNTRUSTED stays UNTRUSTED in the customer's own envelope. The downstream subscriber crossing Boundary 6 emits its **own** envelope with SYSTEM taint — but that envelope's `supersedes` field points back to the customer's envelope, preserving the causal chain (per investigation 05 §"Supersession").

```
customer.create [UNTRUSTED, customer-OTP]
   ↓ supersedes
customer.session.issue [TRUSTED, system mint after OTP verify]
   ↓
order.checkout.create [UNTRUSTED, customer LLM proposal]
   ↓ EXECUTE
payment.charge.create [SYSTEM, kernel emits during checkout execute]
   ↓ … wire …
payment.charge.confirm [TRUSTED, Stripe webhook after sig verify]
   ↓ supersedes (DEFER resume)
order.checkout.create [resumed; same intentHash as original]
   ↓ supersedes
order.status.transition [SYSTEM, subscriber emits on payment confirmation]
```

## NATS message auth (the loudest gap)

Investigation 04 §"P0 #1" and 08 §"Webhook signature verification table" both flag that NATS has no per-message auth. Until this is fixed:

1. ~~**No subscriber-driven intent kind may be added to `IBX_KERNEL_ENFORCE` outside of staging.**~~ (HISTORICAL — IBX_KERNEL_ENFORCE was removed by the IBX-IGE v3.0 cutover; the kernel is always authoritative, so there is no staged-rollout allowlist to gate against. The underlying concern remains: subscribers can mint system-actor envelopes from forged events, and the kernel sees only the envelope, not the source — see item 3 below for the durable mitigation.)
2. **Stripe webhook → NATS publish → subscriber** is the chain that bridges TRUSTED (Stripe-verified) to internal NATS (unauth). The publisher's identity disappears at the NATS boundary.
3. **Recommended interim**: subscribers mint envelopes only when the source event's `idempotencyKey` matches an outbox entry (NATS outbox replay; investigation 04 §"Outbox subjects" lists the 8 critical events). The outbox is internal-Postgres-backed (Redis lists today, future Postgres), so a forged NATS event without a corresponding outbox row never crosses into a kernel envelope.

`createIdempotencyGuard` from `@adjudicate/primitives` (investigation 05 §"primitives") composes naturally here:
```ts
createIdempotencyGuard({
  matches: ({kind}) => SUBSCRIBER_DRIVEN_KINDS.has(kind),
  extractKey: ({payload}) => payload.eventId,
  hasBeenSeen: async (key) => await outbox.has(key),
  onReplay: () => decisionRefuse(
    refuse("idempotency", "duplicate", "Esse evento já foi processado."),
    [basis("ledger", "replay_suppressed")]
  ),
})
```

## Current bypass paths (cited from investigations)

Per investigation 02 §"Top bypass paths", investigation 03 §"Highest-risk unadjudicated mutations", investigation 04 §"Highest-risk un-adjudicated async paths", investigation 08 §"Top P0/P1 security gaps":

| Bypass | Boundary violated | Severity | Cited |
|---|---|---|---|
| Stripe webhook directly writes Payment + completes Medusa cart | 5 → 7 (skips kernel) | P0 | inv 02 §"Stripe webhook" |
| Admin force-cancel order writes OrderProjection directly | 2/3 → 7 | P0 | inv 02 §"Admin surface analysis"; inv 03 §"Highest-risk P0 #2" |
| `payment-lifecycle` subscriber auto-confirms orders on PAID | 6 → 7 (no envelope) | P0 | inv 04 §"P0 #1" |
| `cart-intelligence:order.placed` creates Payment rows | 6 → 7 | P0 | inv 04 §"P0 #3" |
| `stale-order-checker` cron cancels orders by clock | 4 → 7 (skips kernel) | P0 | inv 04 §"P0 #4" |
| `defer-resolver` not wired — DEFER → resume chain dead | 6 → 7 (cannot complete) | P0 | inv 04 §"P0 #5" |
| `notification.send` accepts arbitrary `body` text | 7 (free-form text egress) | P0 | inv 04 §"P0 #6" |
| `DELETE /api/me/data` LGPD anonymize one-click | 1 → 7 (no envelope, no confirmation) | P0 | inv 08 §"P0 #2" |
| AuditRecord.envelope.payload leaks CPF/email to NATS | 7 (audit sink) | P0 | inv 08 §"P0 #1" |
| `handoff_to_human` no per-customer rate limit | 1 → 7 | P1 | inv 08 §"P1 #4" |
| `SESSION_HMAC_SECRET` defaults to known constant | 1 → 2 (forged sessions) | P1 | inv 08 §"P1 #6" |
| NATS broker has no per-message auth | 6 (lateral movement) | P1 | inv 04 §"P2 #13"; inv 08 §"Top blind spots" |

## Recommended TaintPolicy composition

Single shared TaintPolicy across all packs (composed at boot from per-pack `systemOnlyKinds` slices):

```ts
import { createSystemTaintPolicy } from "@adjudicate/primitives";
import { SYSTEM_ONLY_KINDS } from "@ibatexas/llm-provider/intent-kinds";

export const ibxTaintPolicy: TaintPolicy = createSystemTaintPolicy({
  systemOnlyKinds: SYSTEM_ONLY_KINDS,         // see 01-intent-taxonomy.md
  userMinimum: "UNTRUSTED",                   // customers can propose at this level
  systemMinimum: "SYSTEM",                    // system-only kinds reject below SYSTEM
});
```

This single instance plugs into every domain pack's `PolicyBundle.taint` slot. The Pack-specific shadowing (e.g. `pixTaintPolicy` in `@adjudicate/pack-payments-pix`) is **replaced** by the ibatexas single source of truth; per investigation 05, `pixTaintPolicy` is currently UNUSED so no regression.

## Migration sequencing per boundary

| Boundary | Phase | Effort (per master plan §"Workstreams") |
|---|---|---|
| 5 — Webhook → System | WS3 Phase API-1 (Stripe + DEFER wire) | ~3-5 days; investigation 02 |
| 7 — Subscriber/Job → Command Service | WS3 Phase API-4 + master plan §"Workstreams WS1" service wraps | ~5-7 days; investigation 03+04 |
| 2 — Customer → Staff (admin routes) | WS3 Phase API-3 | ~10-14 days; investigation 02 |
| 3 — Staff → Admin (OWNER-only) | WS3 Phase API-3 (high-blast subset) | overlapping; ~3 days |
| 1 — Anonymous → Customer (OTP) | WS3 Phase API-5 | ~2 days |
| 4 — Admin → System (kill switch + replay) | WS3 Phase API-3 + new admin routes | ~3-4 days |
| 6 — Webhook → Subscriber (NATS auth) | parallel infra task; gating WS6 enforce flips on subscriber kinds | ~1-2 weeks; out-of-scope for kernel itself but blocks enforce |

## Cross-references

- Intent kinds + actor matrix: [`01-intent-taxonomy.md`](./01-intent-taxonomy.md) §"Actor types" and §"Intent catalog".
- Decision outcomes per crossing (REFUSE / ESCALATE / REQUEST_CONFIRMATION): [`04-decision-policy.md`](./04-decision-policy.md).
- Audit fields per crossing: [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md) §"Required AuditRecord fields".
- Kill switch reachability across boundaries: [`07-rollback-recovery.md`](./07-rollback-recovery.md) §"Global kill switch".
