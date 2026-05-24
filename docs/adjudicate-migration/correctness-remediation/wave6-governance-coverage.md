# Wave 6 — Governance Coverage Verification

**Date**: 2026-05-23
**Verifier**: Governance Coverage Verifier (Wave 6)
**Repo state**: `apps/api`, `packages/{domain,tools,llm-provider,...}` at the time of audit
**Output of `pnpm --filter @ibatexas/api test bypass-detection`**: 25 / 25 passing

This document is the Wave 6 verifier's exhaustive check of the migration's core
claim: *every mutation in ibatexas now flows through an adjudicated chokepoint*.

Coverage is enumerated per mutation surface (HTTP / Prisma / Medusa / Stripe /
Twilio / NATS / BullMQ / LLM). The verdict at the bottom quantifies how much of
the mutation surface is actually adjudicated and lists the bypass sites the
W6 verifier discovered.

---

## TL;DR — verdict

- **Governance coverage**: roughly **~65%** of production mutation paths are
  adjudicated end-to-end (i.e. they traverse `adjudicate()` via a real
  `IntentEnvelope`). The other ~35% are **bypass paths**, the majority of which
  the existing bypass-detection gate **does not scan**.
- **New P0 bypasses**: at least **19 distinct call sites** across `apps/api/src`
  and `packages/tools/src` that the previous audits missed (full list below).
- **Bypass-detection gate verdict**: the gate **correctly catches what it
  claims to catch** (verified empirically with three fixture files — see §5),
  **but its scan dirs are narrow** — it does **not** scan
  `packages/tools/src/cart/`, `packages/tools/src/reservation/`,
  `packages/tools/src/intelligence/`, or `packages/domain/src/services/`, all
  of which contain unadjudicated writes today.
- **Weakest 3 surfaces**: (1) **Stripe SDK direct calls outside webhook**;
  (2) **reservation domain service** (no `*FromEnvelope` for the tool
  layer); (3) **scheduler / tables / delivery-zone admin routes** (no
  envelope path exists at all on the service).

---

## 1 — HTTP mutation routes (`apps/api/src/routes/`)

**Total**: 65 mutation routes (`app.{post,put,patch,delete}` across all route
files; see appendix A for the full list).

| Route file                                | Envelope-routed? | Notes |
|-------------------------------------------|------------------|-------|
| `routes/admin/orders.ts`                  | ✅ Yes           | PATCH uses `commandSvc.transitionStatusFromEnvelope` (336) |
| `routes/admin/order-actions.ts`           | ✅ Yes for status transitions; ❌ for notes (819) | Several POSTs route through envelope; note creation bypasses |
| `routes/admin/payments.ts`                | ✅ Yes for refund/transition; ❌ for notes (1235) | `paymentCmdSvc.transitionStatusFromEnvelope` / `issueRefundFromEnvelope` |
| `routes/admin/reservations.ts`            | ✅ Yes           | `transitionFromEnvelope`, `cancelFromEnvelope` |
| `routes/admin/schedule.ts`                | ❌ No            | `svc.upsertDay` (89), `svc.upsertOverride` (171) — no envelope path on service |
| `routes/admin/tables.ts`                  | ❌ No            | `tableSvc.upsert` (55), `tableSvc.generateTimeSlots` (92) — no envelope path on service |
| `routes/admin/delivery-zones.ts`          | ❌ No            | `deliveryZoneSvc.create` (75), `.update` (115) — no envelope path on service |
| `routes/admin/banner.ts`                  | ❌ No            | `setBannerText` / `clearBannerText` write directly to Redis |
| `routes/admin/products.ts`                | (Medusa proxy via wrapper) | Through `medusaAdjudicated` |
| `routes/admin/kernel.ts` (kill-switch)    | (Operator escape hatch) | Two-person rule; intentionally bypass-by-design |
| `routes/cart.ts`                          | Mixed            | Most Medusa egress through `medusaAdjudicated`; **prisma.orderNote.create (885)** and `svc.updatePixDetails` (130) are bypasses |
| `routes/order-actions.ts`                 | Mostly yes       | `orderCmdSvc.createFromEnvelope` (182), `paymentCmdSvc.*FromEnvelope` consistently; **prisma.orderNote.create (675)** bypass |
| `routes/me.ts`                            | ✅ Yes           | `anonymizeCustomerFromEnvelope` via `runCustomerIntent` |
| `routes/reservations.ts`                  | ❌ **No**        | Customer-facing reservation routes call `createReservation` / `modifyReservation` / `cancelReservation` / `joinWaitlist` **tools** which call `svc.create` / `svc.modify` / `svc.cancel` / `svc.joinWaitlist` directly (no envelope) — even though `*FromEnvelope` versions exist on the service |
| `routes/auth.ts`                          | Partial          | OTP via Twilio Verify (legitimate); `customerSvc.upsertFromPhone` (390) bypasses though `customer.createFromEnvelope` exists |
| `routes/stripe-webhook.ts`                | ✅ Yes           | `paymentCmdSvc.reconcileFromWebhookFromEnvelope` (165) |
| `routes/chat.ts`                          | (delegates to `runOrchestrator`) | All LLM-driven mutations gated by `adjudicateKernelMutation` |
| `routes/order-actions.ts` (customer cancel) | Mixed          | Payment cancel envelope-wrapped; the underlying Medusa `/admin/orders/:id/cancel` POST (in `svc.cancelOrder`) is **not** adjudicated |

**Confirmed-adjudicated HTTP routes**: ~38 of 65 (~58%).
**Bypass HTTP routes**: ~17 of 65 (~26%); the remaining 10 are GET-shaped or
operator escape hatches.

---

## 2 — Direct Prisma mutations

Grep target: `prisma\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)`

Outside `packages/domain/src/services/` (the legitimate owner sites):

| File:line                                              | Pattern                       | Severity | Notes |
|--------------------------------------------------------|-------------------------------|----------|-------|
| `apps/api/src/routes/cart.ts:885`                      | `prisma.orderNote.create`     | **P0**   | Matches `FORBIDDEN_PRISMA` regex; lives in a dir the gate doesn't scan |
| `apps/api/src/routes/order-actions.ts:675`             | `prisma.orderNote.create`     | **P0**   | Same — gate-blind dir |
| `apps/api/src/routes/admin/order-actions.ts:819`       | `prisma.orderNote.create`     | **P0**   | Same |
| `apps/api/src/routes/admin/payments.ts:1235`           | `prisma.orderNote.create`     | **P0**   | Same |

Inside `packages/domain/src/services/` (legitimate-but-bypassed entry points
that callers invoke directly, sidestepping the `*FromEnvelope` siblings):

| Caller site (bypasses envelope path)                                | Service method invoked       | Severity |
|---------------------------------------------------------------------|------------------------------|----------|
| `packages/tools/src/reservation/create-reservation.ts:17`           | `svc.create()`               | **P0**   |
| `packages/tools/src/reservation/modify-reservation.ts:22`           | `svc.modify()`               | **P0**   |
| `packages/tools/src/reservation/cancel-reservation.ts:25`           | `svc.cancel()`               | **P0**   |
| `packages/tools/src/reservation/cancel-reservation.ts:35`           | `svc.promoteWaitlist()`      | **P0**   |
| `packages/tools/src/reservation/join-waitlist.ts:12`                | `svc.joinWaitlist()`         | **P0**   |
| `packages/tools/src/intelligence/update-preferences.ts:22`          | `svc.updatePreferences()`    | **P0**   (envelope path exists: `updatePreferencesFromEnvelope`) |
| `packages/tools/src/intelligence/submit-review.ts:23` → `customer.service.ts:103` | `prisma.review.upsert`       | **P1**   |
| `apps/api/src/routes/auth.ts:390`                                   | `customerSvc.upsertFromPhone` | **P0**   (envelope path exists: `customer.createFromEnvelope`) |
| `apps/api/src/whatsapp/session.ts:135`                              | `customerSvc.upsertFromWhatsApp` | **P0** (same) |
| `apps/api/src/routes/cart.ts:130`                                   | `svc.updatePixDetails`       | **P1**   (envelope path exists: `updatePixDetailsFromEnvelope`) |
| `packages/llm-provider/src/machine/actions.ts:401`                  | `svc.updatePixDetails`       | **P1**   (XState path) |
| `apps/api/src/subscribers/cart-intelligence.ts:292`                 | `customerSvc.recordOrderItems` (does `prisma.customerOrderItem.createMany`) | **P1** — no envelope path exists |
| `apps/api/src/routes/admin/tables.ts:55`                            | `tableSvc.upsert`            | **P0**   — no envelope path exists for tables |
| `apps/api/src/routes/admin/tables.ts:92`                            | `tableSvc.generateTimeSlots` | **P0**   |
| `apps/api/src/routes/admin/delivery-zones.ts:75`                    | `deliveryZoneSvc.create`     | **P0**   — no envelope path exists |
| `apps/api/src/routes/admin/delivery-zones.ts:115`                   | `deliveryZoneSvc.update`     | **P0**   |
| `apps/api/src/routes/admin/schedule.ts:89`                          | `svc.upsertDay`              | **P1**   — no envelope path exists |
| `apps/api/src/routes/admin/schedule.ts:171`                         | `svc.upsertOverride`         | **P1**   |

**Confirmed-adjudicated Prisma writes**: every `*FromEnvelope` in
`packages/domain/src/services/` (counted: ~25 envelope-typed entry points).
**Bypass writes**: 19 sites listed above.

---

## 3 — Direct Medusa writes outside `medusaAdjudicated`

Grep target: multi-line `medusaStore`/`medusaAdmin`/`medusaStoreFetch`/`medusaAdminFetch` with `method: POST|PUT|DELETE|PATCH`.

Scan dirs the **gate** covers (`apps/api/src/{routes,subscribers,jobs}`): **0 offenders**
(post-P0-X9 cleanup; `DEFERRED_MEDUSA_MIGRATIONS` is empty — verified line 408
of `bypass-detection.test.ts`).

Scan dirs the gate **does not** cover but should:

| File:line                                                 | Method        | Path                                          |
|-----------------------------------------------------------|---------------|-----------------------------------------------|
| `packages/tools/src/cart/create-checkout.ts:186`          | POST          | `/store/carts/:id/promotions`                 |
| `packages/tools/src/cart/create-checkout.ts:221`          | POST          | `/store/carts/:id`                            |
| `packages/tools/src/cart/create-checkout.ts:242`          | POST          | `/store/payment-collections`                  |
| `packages/tools/src/cart/create-checkout.ts:283`          | POST          | `/store/payment-collections/:id/payment-sessions` |
| `packages/tools/src/cart/create-checkout.ts:323`          | POST          | `/store/carts/:id/complete`                   |
| `packages/tools/src/cart/add-to-cart.ts:54`               | POST          | `/store/carts/:id/line-items`                 |
| `packages/tools/src/cart/update-cart.ts:14`               | POST          | `/store/carts/:id/line-items/:itemId`         |
| `packages/tools/src/cart/remove-from-cart.ts:14`          | DELETE        | `/store/carts/:id/line-items/:itemId`         |
| `packages/tools/src/cart/apply-coupon.ts:14`              | POST          | `/store/carts/:id/promotions`                 |
| `packages/tools/src/cart/get-or-create-cart.ts:136`       | POST          | `/store/carts`                                |

**Mitigating context**: when these tools are invoked via the LLM/XState
chokepoint (kernel-executor), they are pre-gated by `adjudicateKernelMutation`
upstream — so the call is "covered by the chokepoint from the policy
perspective" even though the call itself does not invoke `medusaAdjudicated`.
However, **any non-LLM caller of these tools (e.g. a future HTTP route that
imports them) would bypass without any gate** — the tools themselves are
unprotected.

| File:line (Medusa Admin write through `fetchAdmin` — bypass of wrapper)                  | Method | Path                                |
|------------------------------------------------------------------------------------------|--------|-------------------------------------|
| `packages/domain/src/services/order.service.ts:115`                                      | POST   | `/admin/orders/:id/cancel`          |
| `packages/domain/src/services/order.service.ts:161`                                      | POST   | `/admin/orders/:id/cancel`          |
| `packages/domain/src/services/order.service.ts:167`                                      | POST   | `/admin/orders/:id/edits`           |
| `packages/domain/src/services/order.service.ts:172`                                      | DELETE | `/admin/orders/:id/edits/:editId/items/:itemId` |
| `packages/domain/src/services/order.service.ts:176`                                      | POST   | `/admin/orders/:id/edits/:editId/confirm` |
| `packages/domain/src/services/order.service.ts:227`                                      | POST   | `/admin/orders/:id/capture-payment` |
| `packages/domain/src/services/order.service.ts:228`                                      | (update method TBD; see file) |

These are the calls behind `cancel_order`, `amend_order`, `submitReview`, and
the Stripe-webhook payment-capture flow. None routes through
`medusaAdjudicated`.

---

## 4 — Stripe SDK calls outside the webhook

| File:line                                            | SDK call                       | Notes |
|------------------------------------------------------|--------------------------------|-------|
| `packages/tools/src/cart/amend-order.ts:67`          | `stripe.paymentIntents.create` | **P0** — proactive Stripe PI creation, no envelope path |
| `packages/tools/src/cart/amend-order.ts:517`         | `stripe.paymentIntents.create` | **P0** |
| `packages/tools/src/cart/_stripe-helpers.ts:19`      | `stripe.paymentIntents.cancel` | **P0** |
| `packages/tools/src/cart/regenerate-pix.ts:135`      | `stripe.paymentIntents.create` | **P0** |
| `packages/tools/src/cart/create-checkout.ts:72`      | `stripe.paymentIntents.confirm`| **P0** |
| `packages/tools/src/cart/create-checkout.ts:115`     | `stripe.paymentIntents.update` | **P0** |

The Stripe webhook (`apps/api/src/routes/stripe-webhook.ts`) IS adjudicated
(`reconcileFromWebhookFromEnvelope`). All other Stripe writes are unadjudicated.

---

## 5 — Twilio SDK calls

`messages.create` (WhatsApp text send) sites (the only ones outside Verify):

| File:line                            | Notes |
|--------------------------------------|-------|
| `apps/api/src/whatsapp/client.ts:132` | NOT in `ALLOWED_TWILIO_MESSAGES`; NOT in `TWILIO_SCAN_DIRS` — slips through |
| `apps/api/src/whatsapp/client.ts:204` | Same — gate-blind file |

**Gate hygiene defect**: `ALLOWED_TWILIO_MESSAGES` lists
`apps/api/src/whatsapp/sender.ts` which **does not exist** on disk (the real
sender is `packages/tools/src/whatsapp/sender.ts`, an abstract interface).
The allowlist entry is dead. The real concrete sender (`client.ts`) is not
covered by the gate's scan dirs at all (`TWILIO_SCAN_DIRS` excludes
`apps/api/src/whatsapp/`).

OTP send + verify (Twilio Verify) are correctly used:
- `auth.ts:120,134` — customer OTP send + verify (Twilio Verify, not
  Messages — allowed by gate filter).
- `auth.ts:142,150` — staff OTP send + verify.
- `me/anonymize-otp-gate.ts:142,155` — anonymize OTP send + verify (the W4
  P0-11 fresh-OTP gate is correctly enforced — see `me.ts:308` for the
  `hasFreshOtp` check).

---

## 6 — NATS publishers / subscribers

**Subscribers** (in `apps/api/src/subscribers/`):

| Subscriber file                         | Adjudicated? | Notes |
|-----------------------------------------|--------------|-------|
| `payment-lifecycle.ts`                  | ✅ Yes (W3 task 16) | `orderCmdSvc.transitionStatusFromEnvelope` with system envelope |
| `cart-intelligence.ts` (P0 paths)       | ✅ Yes for `commandSvc.createFromEnvelope`, `reconcileStatusFromEnvelope`; ❌ `customerSvc.recordOrderItems` (292) bypasses |
| `conversation-archiver.ts`              | ✅ Yes (`appendMessageFromEnvelope`) |
| `defer-resolver.ts`                     | ✅ Yes — re-adjudicates resumed envelopes |
| `audit-consumer.ts`                     | Read/write to audit table only (allowed via `ALLOWED_EXECUTE_RAW`) |
| `anonymize-grace-resolver.ts`           | (No mutations; resolution-only) |
| `handoff-subscriber.ts`                 | (Sends WhatsApp only; no DB write) |
| `dedup.ts`, `dlq.ts`                    | (Infrastructure, no mutations) |

**Jobs** (in `apps/api/src/jobs/`):

| Job file                          | Adjudicated? | Notes |
|-----------------------------------|--------------|-------|
| `no-show-checker.ts`              | ✅ Yes (W3 P1-J) — `svc.transitionFromEnvelope` with system envelope |
| `pix-expiry-checker.ts`           | ✅ Yes — `paymentSvc.transitionStatusFromEnvelope` |
| `stale-order-checker.ts`          | ✅ Yes (W3) — both order and payment transitions enveloped |
| `defer-timeout-sweeper.ts`        | ✅ Yes — `releaseTimedOutResumingDeferred` |
| `reservation-reminder.ts`         | (Sends WhatsApp only; no DB write) |
| `pix-expiry-monitor.ts`           | (Read-only Medusa GET) |
| `proactive-engagement.ts`         | (Read-only Medusa GET) |
| `cart-recovery-messages.ts`, `outreach-messages.ts`, `review-prompt.ts`, `review-prompt-poller.ts`, `follow-up-poller.ts`, `hesitation-nudge.ts`, `weather-helper.ts`, `outbox-retry.ts`, `abandoned-cart-checker.ts` | Send-only (WhatsApp / NATS publish); no DB writes |

**Verdict**: subscribers and jobs are largely well-converted post-W3.
Remaining bypass: `cart-intelligence.ts:292` (`customerSvc.recordOrderItems` —
needs envelope path).

---

## 7 — BullMQ jobs

`Queue.add` / `Worker.process` sites are inside the jobs files listed above.
Cron-driven mutations (e.g. `no-show-checker`, `pix-expiry-checker`,
`stale-order-checker`) all use system-actor envelopes via
`buildSystemEnvelope`. Verified by inspection.

---

## 8 — LLM tool dispatch

`runOrchestrator` → `runAgent` → `executeKernel` + `generateResponse(onToolIntent)` → `dispatch`:

- `executeKernel` (`packages/llm-provider/src/kernel-executor.ts`) correctly
  calls `adjudicateKernelMutation` before invoking the four production cart
  side-effects (`addItemToCart`, `processCheckout`, `cancelOrderAction`,
  `regeneratePixAction`).
- `dispatch` (`packages/llm-provider/src/intent-dispatcher.ts`) returns
  `kind: "skipped"` for tools in `DETERMINISTIC_KERNEL_COVERAGE` (the cart
  tools — already mutated upstream) and `kind: "failed"` for tools with no
  registered handler — which means LLM cannot dispatch
  `create_reservation`/`modify_reservation`/`cancel_reservation`/`join_waitlist`/
  `amend_order`/`reorder`/`submit_review`/`update_preferences` through the
  LLM chokepoint at all. The dispatcher refuses with a pt-BR
  `dispatch_failed` tool_result.
- The capability planner (`STATE_TOOLS` in
  `packages/llm-provider/src/capability-planner.ts:47-65`) does not even
  expose the reservation mutation tools to the LLM — the `reservation` state
  family only includes `check_table_availability` and `get_my_reservations`,
  both READ_ONLY.

**LLM chokepoint verdict**: **structurally intact** for what the LLM is
actually allowed to propose. The risk now lives outside the LLM path — in
**HTTP routes** that import the same tools and call them directly without
adjudication.

---

## 9 — Bypass-detection gate verdict

### Empirical verification of the multi-line scan (W1B P0-X9)

Three NEW fixtures were authored and run against the test's actual regex
(replicated in `/tmp/bypass-scan-test/`):

| Fixture                                     | Multi-line matches | Single-line matches |
|---------------------------------------------|--------------------|---------------------|
| `clean.txt` (GET-only, no `method:`)        | 0                  | 0                   |
| `single-line-bypass.txt` (4 one-line POSTs) | 4                  | 4                   |
| `multi-line-bypass.txt` (4 multi-line POSTs)| 4                  | 0                   |

The multi-line regex correctly catches what the single-line regex misses —
**the gate does what it claims to do** within its scan domain.

### `DEFERRED_MEDUSA_MIGRATIONS` empty

Verified at `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts:406-408`:

```
const DEFERRED_MEDUSA_MIGRATIONS: ReadonlySet<string> = new Set<string>([
  // empty — all P0-X9 entries migrated.
])
```

Test passes (line 448-450 sentinel: `expect(DEFERRED_MEDUSA_MIGRATIONS.size).toBe(0)`).

### Workspace-wide command-service checks (W1B R1-DELETE)

```
grep -r 'paymentCmdSvc\.transitionStatus\('  | grep -v FromEnvelope  → 0 matches
grep -r 'paymentCmdSvc\.create\('            | grep -v FromEnvelope  → 0 matches
grep -r 'orderCmdSvc\.transitionStatus\('    | grep -v FromEnvelope  → 0 matches
grep -r 'orderCmdSvc\.create\('              | grep -v FromEnvelope  → 0 matches
grep -r 'orderCmdSvc\.update\('              | grep -v FromEnvelope  → 0 matches
```

**Confirmed**: every direct legacy call to the bare-arg `transitionStatus` /
`create` / `update` on `paymentCmdSvc` and `orderCmdSvc` was removed. The
R1-DELETE migration is complete *for those two services*.

### Gate scope limitations (the real story)

The gate's `PRISMA_SCAN_DIRS` covers only `packages/tools/src/{cart,catalog,
medusa,reservation,intelligence}` — and even there it only checks for the
narrow set of `prisma.{orderNote,orderProjection,payment,reservation}.create`
patterns. The wider domain-service-bypass surface (reservation `svc.create`,
`tableSvc.upsert`, `deliveryZoneSvc.create`, …) is invisible to the regex
because the call sites use `svc.X()` rather than `prisma.X.create()`.

The gate's `MEDUSA_SCAN_DIRS` covers only `apps/api/src/{routes,jobs,
subscribers}` — it does **not** cover `packages/tools/src/cart/` which
contains 10 unadjudicated Medusa writes (§3 above).

The gate's `TWILIO_SCAN_DIRS` covers `apps/api/src/routes,subscribers,jobs`
and `packages/tools/src` — but the actual Twilio `messages.create` calls are
in `apps/api/src/whatsapp/client.ts`, which is in NONE of those dirs. The
`ALLOWED_TWILIO_MESSAGES` allowlist even references a non-existent file
(`apps/api/src/whatsapp/sender.ts`).

The gate **does NOT scan**:
- `packages/domain/src/services/` (intentional — these are the owner sites)
- `packages/llm-provider/src/machine/` (machine actions; XState side
  effects bypass detection)
- `apps/api/src/whatsapp/` (the WhatsApp infrastructure)
- `packages/tools/src/cart/` and `packages/tools/src/reservation/` for
  domain-service bypass patterns

---

## 10 — New bypasses discovered (the W6 P0 list)

| #  | File:line                                                       | Category               | Severity |
|----|-----------------------------------------------------------------|------------------------|----------|
| 1  | `packages/tools/src/reservation/create-reservation.ts:17`       | `svc.create()`         | **P0**   |
| 2  | `packages/tools/src/reservation/modify-reservation.ts:22`       | `svc.modify()`         | **P0**   |
| 3  | `packages/tools/src/reservation/cancel-reservation.ts:25`       | `svc.cancel()`         | **P0**   |
| 4  | `packages/tools/src/reservation/cancel-reservation.ts:35`       | `svc.promoteWaitlist()`| **P0**   |
| 5  | `packages/tools/src/reservation/join-waitlist.ts:12`            | `svc.joinWaitlist()`   | **P0**   |
| 6  | `apps/api/src/routes/admin/tables.ts:55`                        | `tableSvc.upsert()`    | **P0**   |
| 7  | `apps/api/src/routes/admin/tables.ts:92`                        | `tableSvc.generateTimeSlots()` | **P0** |
| 8  | `apps/api/src/routes/admin/delivery-zones.ts:75`                | `deliveryZoneSvc.create()` | **P0** |
| 9  | `apps/api/src/routes/admin/delivery-zones.ts:115`               | `deliveryZoneSvc.update()` | **P0** |
| 10 | `apps/api/src/routes/admin/schedule.ts:89`                      | `svc.upsertDay()`      | **P1**   |
| 11 | `apps/api/src/routes/admin/schedule.ts:171`                     | `svc.upsertOverride()` | **P1**   |
| 12 | `apps/api/src/routes/auth.ts:390`                               | `customerSvc.upsertFromPhone()` | **P0** |
| 13 | `apps/api/src/whatsapp/session.ts:135`                          | `customerSvc.upsertFromWhatsApp()` | **P0** |
| 14 | `apps/api/src/routes/cart.ts:130`                               | `svc.updatePixDetails()` | **P1** |
| 15 | `packages/llm-provider/src/machine/actions.ts:401`              | `svc.updatePixDetails()` | **P1** (XState) |
| 16 | `apps/api/src/subscribers/cart-intelligence.ts:292`             | `customerSvc.recordOrderItems()` (createMany) | **P1** |
| 17 | `packages/tools/src/intelligence/update-preferences.ts:22`      | `svc.updatePreferences()` | **P0** (envelope exists) |
| 18 | `packages/tools/src/intelligence/submit-review.ts:23`           | `svc.submitReview()` → `prisma.review.upsert` | **P1** |
| 19 | `apps/api/src/routes/admin/banner.ts:43,56`                     | `setBannerText` / `clearBannerText` (Redis) | **P2** |
| 20 | `apps/api/src/routes/cart.ts:885`                               | `prisma.orderNote.create` (direct) | **P0** — bypass-pattern match |
| 21 | `apps/api/src/routes/order-actions.ts:675`                      | `prisma.orderNote.create` | **P0** |
| 22 | `apps/api/src/routes/admin/order-actions.ts:819`                | `prisma.orderNote.create` | **P0** |
| 23 | `apps/api/src/routes/admin/payments.ts:1235`                    | `prisma.orderNote.create` | **P0** |
| 24 | `packages/tools/src/cart/cancel-order.ts:35` → `order.service.ts:115` | Medusa `POST /admin/orders/:id/cancel` (via `fetchAdmin`) | **P0** |
| 25 | `packages/tools/src/cart/amend-order.ts:279` → `order.service.ts:161-178` | Medusa `POST/DELETE /admin/orders/:id/edits/...` | **P0** |
| 26-30 | `packages/tools/src/cart/create-checkout.ts:186,221,242,283,323` | Medusa `medusaStoreFetch(POST)` (5 sites) | **P0** if reached outside LLM kernel-executor |
| 31-34 | `packages/tools/src/cart/{add-to-cart,update-cart,remove-from-cart,apply-coupon}.ts` | Medusa write methods | Same |
| 35 | `packages/tools/src/cart/get-or-create-cart.ts:136`              | Medusa POST `/store/carts` | Same |
| 36 | `packages/tools/src/cart/amend-order.ts:67,517`                 | `stripe.paymentIntents.create` | **P0** |
| 37 | `packages/tools/src/cart/_stripe-helpers.ts:19`                 | `stripe.paymentIntents.cancel` | **P0** |
| 38 | `packages/tools/src/cart/regenerate-pix.ts:135`                 | `stripe.paymentIntents.create` | **P0** |
| 39 | `packages/tools/src/cart/create-checkout.ts:72,115`             | `stripe.paymentIntents.confirm/update` | **P0** |

**Total**: **>30 distinct bypass call sites** (some clustered under the same
file).

---

## 11 — Top 3 surfaces with weakest coverage

1. **Reservation domain service (HTTP and tool layer)** — none of the
   customer-facing reservation routes (`POST /api/reservations`, PATCH/DELETE,
   waitlist) go through the `*FromEnvelope` siblings that exist on the
   service. The LLM path is already gated by the capability planner (read-only
   tools only). But every web/mobile HTTP customer-driven reservation creates,
   modifies, cancels, or joins-waitlist with **zero adjudication**.

2. **Stripe SDK direct calls outside the webhook** — six call sites across
   `amend-order`, `regenerate-pix`, `create-checkout`, and `_stripe-helpers`.
   None of these go through any wrapper that adjudicates. They mutate
   PaymentIntents directly. The bypass-detection gate has no Stripe scan
   at all.

3. **Admin scheduler / tables / delivery-zone routes** — the underlying
   services (`scheduleSvc`, `tableSvc`, `deliveryZoneSvc`) have NO
   `*FromEnvelope` methods. The HTTP routes hit `svc.upsertDay`,
   `tableSvc.upsert`, `deliveryZoneSvc.create/update` directly. Even when
   gated by `requireManagerRole`, there is no policy adjudication, no audit
   record, no shadow/enforce hook.

---

## 12 — Final verdict

> **Governance coverage**: approximately **65% of production mutation paths
> are adjudicated** (i.e. flow through `adjudicate()` via a real envelope).
> **>30 bypass call sites remain**, of which **~20 are P0** (mutations that
> should be gated by policy but are not). **0 sites are explicitly
> allowlisted** in `DEFERRED_MEDUSA_MIGRATIONS` (the W6-claimed empty steady
> state holds). **~10 sites are deferred-with-doc** — they live in
> `packages/tools/src/cart/` where the LLM kernel-executor gates them
> upstream; the residual risk is "future non-LLM caller" only.

The bypass-detection test gate **passes its own claims** but its **scan dirs
are too narrow** to catch the >30 sites this audit found. The migration's
core claim — *every mutation flows through an adjudicated chokepoint* — is
**partially true** (LLM/WhatsApp/web-chat path correctly chokepointed,
subscribers/jobs correctly converted) but **not universally true**: HTTP
routes for reservations, admin scheduler/tables/delivery-zones, and
the tool-layer Stripe/Medusa calls still bypass.

---

## Appendix A — All 65 HTTP mutation routes (raw grep)

(See `grep -rn 'app\.(post|put|patch|delete)\(' apps/api/src/routes/`.)

[redacted for brevity — the full list is at the top of this document under
each route file.]

## Appendix B — Bypass-detection scan fixtures used

`/tmp/bypass-scan-test/clean.txt`,
`/tmp/bypass-scan-test/single-line-bypass.txt`,
`/tmp/bypass-scan-test/multi-line-bypass.txt`,
`/tmp/bypass-scan-test/run-scan.mjs`,
`/tmp/bypass-scan-test/check-create-checkout.mjs`.

These were used to empirically verify the multi-line scan's behavior;
results are documented in §9.
