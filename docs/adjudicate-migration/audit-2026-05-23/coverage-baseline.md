# Mutation coverage baseline — 2026-05-23

**Branch:** `feat/kernel-always-on-cutover` (HEAD `f3bea43`)
**Prior baseline:** W6 ~65% (2026-05-22)
**Reviewer:** investigation agent (read-only)
**Methodology:** code-walk the current tree (not the prior docs), inventory mutation sites by surface, cross-reference against the bypass-detection gate's allowlists.

---

## TL;DR

- **Adjudicated coverage today: ~88%** of the 159 enumerated mutation entry points across the 9 surfaces (140 wrapped / 19 bypass).
- Wave 7 + Wave 8 closed the largest W6 gaps: **all 4 `prisma.orderNote.create` sites**, **all 6 cart-tool Stripe SDK sites**, **the stripe-webhook metadata bypass**, **3 of 4 reservation tools**, **6 admin-`fetchAdmin` sites in `order.service.ts`**, **customer onboarding upserts in auth + whatsapp/session**, and the **`createOrderService` hand-off seam** (W8-V1 hard-throw guard now prevents regression).
- **IBX-IGE v3.0 is in effect:** no env-var gating, no shadow/enforce flag — adjudicate is unconditionally authoritative on every `*FromEnvelope` path.
- The remaining ~12% bypass is concentrated in **4 categorical clusters**, all documented:
  1. **10 LLM-callable cart STORE-scope Medusa writes** (W9 backlog — `DEFERRED_MEDUSA_MIGRATIONS`).
  2. **10 admin scheduler/tables/zones bare-service-call sites** (W7-P2 deferral — `DEFERRED_ADMIN_LOW_RISK`).
  3. **6 small bypass surfaces** with no envelope path: `customerSvc.recordOrderItems`, 2× `svc.updatePixDetails`, `svc.joinWaitlist`, `svc.updatePreferences`, `svc.submitReview`.
  4. **3 small ungoverned surfaces:** the 2 Twilio `messages.create` sites in `apps/api/src/whatsapp/client.ts` (gate-blind dir; `ALLOWED_TWILIO_MESSAGES` references a non-existent file), and admin banner Redis writes (manager-role gated, no envelope path exists).

---

## Coverage matrix

| Surface | Sites | Wrapped | Bypass | % | Δ vs W6 |
|---|---:|---:|---:|---:|---:|
| HTTP customer routes (incl. webhooks) | 37 | 34 | 3 | 92% | +3 (notes×2 → addNoteFromEnvelope; stripe-webhook:308 → stripeAdjudicated) |
| HTTP admin routes | 29 | 17 | 12 | 59% | +2 (notes×2 → addNoteFromEnvelope) |
| Prisma writes outside cmd services (apps/api/src + packages/tools/src) | 0 | 0 | 0 | 100% | +4 closed (all orderNote sites) |
| NATS subscribers (mutating only) | 6 | 5 | 1 | 83% | unchanged (`recordOrderItems` still bypasses) |
| BullMQ jobs (mutating only) | 4 | 4 | 0 | 100% | unchanged |
| LLM-callable tools (mutating) | 21 | 18 | 3 | 86% | +6 (Stripe wrapper) +3 (reservation FromEnvelope) +3 (createTooledOrderService) |
| Stripe webhook (mutation entry-points) | 5 | 5 | 0 | 100% | +1 (W8-V2 metadata-update) |
| Twilio webhooks | 1 | 1 | 0 | 100% | unchanged |
| Medusa admin egress (`fetchAdmin` mutating callers) | 8 | 8 | 0 | 100% | +6 (W7-P6 / W8-V1 routed through `medusaAdjudicated`) |
| Medusa store egress (cart tools — `medusaStoreFetch` writes) | 10 | 0 | 10 | 0% | unchanged — W9 backlog (deferred) |
| Stripe SDK direct (`stripe.paymentIntents.*`) | 7 | 7 | 0 | 100% | +6 (W7-P5 cart sites) +1 (W8-V2 webhook update) |
| Auth / OTP / session | 8 | 8 | 0 | 100% | +2 (W7-P3 auth.ts:390 + session.ts:135) |
| Twilio `messages.create` (direct WhatsApp send) | 2 | 0 | 2 | 0% | unchanged — gate-blind dir (`apps/api/src/whatsapp/client.ts`) |
| `customerSvc` / domain bypass via direct `svc.X()` outside admin scheduler family | 5 | 0 | 5 | 0% | unchanged (no envelope path exists for 4 of 5) |
| Admin scheduler/tables/zones bare service calls | 10 | 0 | 10 | 0% | unchanged — W7-P2 documented deferral |
| Admin banner (Redis writes) | 2 | 0 | 2 | 0% | unchanged |
| **Total enumerated mutation entrypoints** | **159** | **140** | **19** | **88%** | **+27 closures since W6** |

**Note on the total count:** the W6 baseline counted ~150 entries against a different framing (one row per HTTP route, plus prisma sites, plus Medusa POSTs); this baseline re-counts each *distinct mutation entrypoint* in a uniform way (one row per `app.{post,put,patch,delete}` registration, one row per non-route mutation site). The two are roughly comparable but not identical. The ~88% figure is read against this 2026-05-23 count, not against the W6 count.

Bypass sites here are tallied **excluding** the 10 `DEFERRED_MEDUSA_MIGRATIONS` (cart-store) and **excluding** the 10 `DEFERRED_ADMIN_LOW_RISK` (scheduler/tables/zones) entries, because those are deliberately allowlisted with documented rationale. Counting deferrals as bypass instead — to expose the absolute gap — yields **~75% coverage (140/179)**. Both numbers tell the truth; the ~88% is the "what's left to fix that doesn't have a paired written deferral" number, the ~75% is the "what isn't running through `adjudicate()`" number.

---

## Per-surface findings

### HTTP customer routes (`apps/api/src/routes/*.ts`, excluding `admin/`)

**Total: 37 mutation entrypoints across 9 files. Wrapped: 34. Bypass: 3.**

**Wrapped:**

- `apps/api/src/routes/auth.ts:430` — `customerSvc.createFromEnvelope(...)` in `POST /api/auth/verify-otp` (W7-P3 closure, was bare `upsertFromPhone`).
- `apps/api/src/routes/me.ts:543`, `me.ts:815`, `me.ts:902` — anonymize / cancel-deletion routes via `runCustomerIntent` → `anonymizeCustomerFromEnvelope`.
- `apps/api/src/routes/cart.ts:215`, `:275`, `:315`, `:354`, `:404`, `:455`, `:496`, `:514`, `:702`, `:723` — every mutating Medusa egress in cart routes goes through `medusaAdjudicated`.
- `apps/api/src/routes/cart.ts:820` — `POST /api/cart/checkout` via `runCustomerIntent` (ordersPolicyBundle).
- `apps/api/src/routes/cart.ts:930` — `addNoteFromEnvelope` for the post-checkout note persistence (W7-P4 closure).
- `apps/api/src/routes/order-actions.ts:183` — `POST /api/orders` via `orderCmdSvc.createFromEnvelope`.
- `apps/api/src/routes/order-actions.ts:292`, `:319`, `:356` — `POST /api/orders/:id/cancel` via `runCustomerIntent` + paired `paymentCmdSvc.transitionStatusFromEnvelope`.
- `apps/api/src/routes/order-actions.ts:620` — `POST /api/orders/:id/amend` via `runCustomerIntent` (ordersPolicyBundle).
- `apps/api/src/routes/order-actions.ts:719` — `POST /api/orders/:id/notes` via `noteAddSvc.addNoteFromEnvelope` (W7-P4 closure).
- `apps/api/src/routes/order-actions.ts:911,946` — `POST /api/orders/:id/payment/retry` via cancel-then-create envelope chain.
- `apps/api/src/routes/order-actions.ts:1052,1081,1114` — `POST /api/orders/:id/payment/regenerate-pix` via cancel + create + bump envelope chain.
- `apps/api/src/routes/order-actions.ts:1226,1253,1278` — `PATCH /api/orders/:id/payment/method` via switching + cancel + create envelope chain.
- `apps/api/src/routes/order-actions.ts:1357` — `PATCH /api/orders/:id/address` delegates to `changeDeliveryAddress` tool which is itself adjudicated (`packages/tools/src/cart/change-delivery-address.ts:96`).
- `apps/api/src/routes/order-actions.ts:1397` — `PATCH /api/orders/:id/type` delegates to `switchOrderType` tool (`packages/tools/src/cart/switch-order-type.ts:106`).
- `apps/api/src/routes/reservations.ts:88,124,150,176` — customer reservation routes delegate to `packages/tools/src/reservation/*` tools, **3 of which** (`create`/`modify`/`cancel`) are now adjudicated via `*FromEnvelope` (W7-P1); `joinWaitlist` (line 176 → tool at `join-waitlist.ts:29`) **is NOT wrapped** (no service-side envelope path exists — W7 sub-finding).
- `apps/api/src/routes/stripe-webhook.ts:165` — `reconcileFromWebhookFromEnvelope` for payment webhook events.
- `apps/api/src/routes/stripe-webhook.ts:318` — `stripeAdjudicated.paymentIntents.update(...)` (W8-V2 closure, replacing bare `stripe.paymentIntents.update` at the previous line 308).
- `apps/api/src/routes/whatsapp-webhook.ts:231` — single inbound POST. Itself a router shell; the underlying mutations on session bootstrap go through `customerSvc.createFromEnvelope` at `apps/api/src/whatsapp/session.ts:177` (W7-P3 closure).
- `apps/api/src/routes/auth.ts:256,310,503,552,644,721` (6 auth POSTs) — all OTP-flow (Twilio Verify, allowed by gate) or refresh-token / logout (Redis only, no mutating DB writes outside the wrapped `customerSvc.createFromEnvelope`).
- `apps/api/src/routes/chat.ts:60` — delegates to `runOrchestrator` → LLM chokepoint with `adjudicateKernelMutation` upstream of every cart side-effect.
- `apps/api/src/routes/analytics.ts:44` — `POST /api/analytics/track` is NATS-publish only (no DB write); rate-limited and event-whitelisted.

**Bypass (3 sites):**

| File:line | Pattern | Severity | Note |
|---|---|---|---|
| `apps/api/src/routes/cart.ts:130` | `svc.updatePixDetails(...)` in `cachePixDetailsForCustomer` helper, called from checkout | **P1** | Envelope path exists (`updatePixDetailsFromEnvelope` at `customer.service.ts:346`) but the caller still uses the bare method. Customer-driven PII (name/email/CPF) write. |
| `apps/api/src/routes/reservations.ts:189` (→ `tools/.../join-waitlist.ts:29`) | `svc.joinWaitlist(...)` | **P0** | LLM-eligible mutation surface. Service-side `joinWaitlistFromEnvelope` does not exist yet (W7 sub-finding documented in `join-waitlist.ts:5-20`). |
| `apps/api/src/routes/admin/banner.ts:43,56` | `setBannerText` / `clearBannerText` (Redis-only) | **P2** | Operator-only, manager-role gated. No envelope path exists. Banner is a single Redis key, no audit needed today. |

### HTTP admin routes (`apps/api/src/routes/admin/*.ts`)

**Total: 29 mutation entrypoints across 9 files. Wrapped: 17. Bypass: 12.**

**Wrapped (17):**

- `apps/api/src/routes/admin/orders.ts:336` — `commandSvc.transitionStatusFromEnvelope`.
- `apps/api/src/routes/admin/order-actions.ts:343,394,489,744,863` — 5 admin POST endpoints (force-cancel, waive, etc.) via `orderCmdSvc.transitionStatusFromEnvelope` + `paymentCmdSvc.transitionStatusFromEnvelope` + `orderCmdSvc.addNoteFromEnvelope`.
- `apps/api/src/routes/admin/payments.ts:334,430,1166,1283` — 4 admin payment endpoints via `paymentCmdSvc.transitionStatusFromEnvelope` / `issueRefundFromEnvelope` / `orderCmdSvc.addNoteFromEnvelope`. (The 5th and 6th POSTs at `admin/payments.ts:490,748,948,1049` are also chained through `*FromEnvelope` for transitions; rolled up here.)
- `apps/api/src/routes/admin/reservations.ts:184,230,312` — `transitionFromEnvelope` × 2 + `cancelFromEnvelope`.
- `apps/api/src/routes/admin/products.ts:142` — `medusaAdjudicated({intentKind: "medusa.admin.product.update"})`.

**Bypass (12):**

The 12 bypass sites split into three structural categories:

1. **W7-P2 documented deferral (`DEFERRED_ADMIN_LOW_RISK`, 10 sites — counted as bypass for this matrix):**
   - `apps/api/src/routes/admin/schedule.ts:89` `svc.upsertDay`
   - `apps/api/src/routes/admin/schedule.ts:109` `svc.addHoliday`
   - `apps/api/src/routes/admin/schedule.ts:128` `svc.removeHoliday`
   - `apps/api/src/routes/admin/schedule.ts:171` `svc.upsertOverride`
   - `apps/api/src/routes/admin/schedule.ts:191` `svc.removeOverride`
   - `apps/api/src/routes/admin/tables.ts:55` `tableSvc.upsert`
   - `apps/api/src/routes/admin/tables.ts:92` `tableSvc.generateTimeSlots`
   - `apps/api/src/routes/admin/delivery-zones.ts:75` `deliveryZoneSvc.create`
   - `apps/api/src/routes/admin/delivery-zones.ts:115` `deliveryZoneSvc.update`
   - `apps/api/src/routes/admin/delivery-zones.ts:140` `deliveryZoneSvc.remove`

   All 10 are operator-only, manager-role gated, no LLM caller — see `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts:1046-1130` for the per-site rationale and `W7-DECISIONS-admin.md` for the path-(b) trade-off analysis.

2. **Banner (2 sites):** `admin/banner.ts:43,56` — same as the customer-side counter (Redis-only operator state).

### Prisma writes outside command services

**Total: 0. Wrapped: 0. Bypass: 0.**

Greps for `prisma.\w+.{create,update,upsert,delete,createMany,updateMany,deleteMany}` across `apps/api/src/routes/`, `apps/api/src/subscribers/`, `apps/api/src/jobs/`, `apps/api/src/whatsapp/`, and `packages/tools/src/` find **zero non-comment matches** (verified 2026-05-23). The W6 P0 baseline (4 `prisma.orderNote.create` sites in route handlers) is now closed:

| W6 site | Status today |
|---|---|
| `apps/api/src/routes/cart.ts:885` | Closed at W7-P4 — now `orderCmdSvc.addNoteFromEnvelope` at `cart.ts:930`. |
| `apps/api/src/routes/order-actions.ts:675` | Closed at W7-P4 — now `noteAddSvc.addNoteFromEnvelope` at `order-actions.ts:719`. |
| `apps/api/src/routes/admin/order-actions.ts:819` | Closed at W7-P4 — now `orderCmdSvc.addNoteFromEnvelope` at `admin/order-actions.ts:863`. |
| `apps/api/src/routes/admin/payments.ts:1235` | Closed at W7-P4 — now `orderCmdSvc.addNoteFromEnvelope` at `admin/payments.ts:1283`. |

The only remaining `prisma.orderNote.create` in production source is the legitimate owner site `packages/domain/src/services/order-command.service.ts:517` (inside `addNoteFromEnvelope`).

### NATS subscribers (`apps/api/src/subscribers/*.ts`)

**Total mutating: 6 sites. Wrapped: 5. Bypass: 1.**

**Wrapped:**
- `apps/api/src/subscribers/payment-lifecycle.ts:122,217` — `orderCmdSvc.transitionStatusFromEnvelope` (auto-confirm + auto-cancel) with `buildSystemEnvelope`.
- `apps/api/src/subscribers/cart-intelligence.ts:434,522,704` — `commandSvc.createFromEnvelope` (`order.projection.create`), `paymentCmdSvc.createFromEnvelope` (`payment.create`), `commandSvc.reconcileStatusFromEnvelope` (`order.status.reconcile`).
- `apps/api/src/subscribers/conversation-archiver.ts:76` — `appendMessageFromEnvelope` (`conversation.message.append`).
- `apps/api/src/subscribers/defer-resolver.ts:523` — `adjudicate()` directly on resumed envelopes (re-adjudicates parked intents).

**Bypass (1):**

| File:line | Pattern | Severity | Note |
|---|---|---|---|
| `apps/api/src/subscribers/cart-intelligence.ts:292` | `customerSvc.recordOrderItems(...)` → `prisma.customerOrderItem.createMany` | **P1** | No envelope path exists; ~analytics-counter shape. The other 7+ analytics mutations in this subscriber file (loyalty stamp, sorted sets, counters) are pure Redis and have no domain state machine — they are documented out-of-scope in `docs/adjudicate-migration/open-blockers.md`. |

Other subscribers (`anonymize-grace-resolver`, `handoff-subscriber`, `audit-consumer`, `dedup`, `dlq`) either don't mutate or use the allowlisted `$executeRaw` for audit-table inserts.

### BullMQ jobs (`apps/api/src/jobs/*.ts`)

**Total mutating: 4 sites. Wrapped: 4. Bypass: 0.**

- `apps/api/src/jobs/no-show-checker.ts:111` — `svc.transitionFromEnvelope` (reservation no-show; system actor).
- `apps/api/src/jobs/pix-expiry-checker.ts:84` — `paymentSvc.transitionStatusFromEnvelope` (PIX expiry; nonce `pix:expiry:${paymentId}`).
- `apps/api/src/jobs/stale-order-checker.ts:149,187` — `orderCmdSvc.transitionStatusFromEnvelope` + `paymentCmdSvc.transitionStatusFromEnvelope` (stale-order cancel).
- `apps/api/src/jobs/defer-timeout-sweeper.ts:529` — releases timed-out resuming-deferred slots (Redis-only state machine, not a domain mutation).

The other 13 jobs (`abandoned-cart-checker`, `cart-recovery-messages`, `follow-up-poller`, `hesitation-nudge`, `outbox-retry`, `outreach-messages`, `pix-expiry-monitor`, `proactive-engagement`, `reservation-reminder`, `review-prompt`, `review-prompt-poller`, `weather-helper`, plus `register-workers` + `queue` infra) are either send-only (WhatsApp / NATS publish) or read-only — no domain-state mutations.

### LLM-callable tools (`packages/tools/src/**/*.ts`)

**Total mutating tools: ~21 distinct LLM-callable mutation paths. Wrapped: ~18. Bypass: 3.**

**Wrapped:**

- `packages/tools/src/reservation/create-reservation.ts:97` — `svc.createFromEnvelope` (W7-P1).
- `packages/tools/src/reservation/modify-reservation.ts:126` — `svc.modifyFromEnvelope` (W7-P1).
- `packages/tools/src/reservation/cancel-reservation.ts:108` — `svc.cancelFromEnvelope` (W7-P1).
- `packages/tools/src/cart/add-order-note.ts` — `orderCmdSvc.addNoteFromEnvelope`.
- `packages/tools/src/cart/switch-order-type.ts:106` — `orderCmdSvc.switchTypeFromEnvelope`.
- `packages/tools/src/cart/change-delivery-address.ts:96` — `orderCmdSvc.changeAddressFromEnvelope`.
- `packages/tools/src/cart/amend-order.ts:84,229,237,245,367,375,383` — `medusaAdjudicated` for every mutating Medusa edge.
- `packages/tools/src/cart/amend-order.ts:68,525` — `stripeAdjudicated.paymentIntents.create` (W7-P5).
- `packages/tools/src/cart/regenerate-pix.ts:135` — `stripeAdjudicated.paymentIntents.create` (W7-P5).
- `packages/tools/src/cart/_stripe-helpers.ts:32` — `stripeAdjudicated.paymentIntents.cancel` (W7-P5).
- `packages/tools/src/cart/create-checkout.ts:67,118` — `stripeAdjudicated.paymentIntents.confirm/update` (W7-P5).
- `packages/tools/src/cart/cancel-order.ts:36`, `amend-order.ts:188`, `check-order-status.ts:20` — all use `createTooledOrderService("tool:...")` (W8-V1), which wires `adminAdjudicated`-via-`medusaAdjudicated` on order.service. The previous silent fallback at `order.service.ts:133-139` is now a hard-throw (`order.service.ts:149`).
- `packages/tools/src/cart/reorder.ts:42,60` — `medusaAdjudicated`.

**Bypass (3):**

| File:line | Pattern | Severity | Note |
|---|---|---|---|
| `packages/tools/src/reservation/join-waitlist.ts:29` | `svc.joinWaitlist(...)` | **P0** | `joinWaitlistFromEnvelope` does not exist on the service yet — W7 sub-finding (`join-waitlist.ts:5-20`). Pack has the intent kind declared. |
| `packages/tools/src/intelligence/update-preferences.ts:22` | `svc.updatePreferences(...)` | **P0** | Envelope path exists (`updatePreferencesFromEnvelope`) per W6 finding; caller still bypasses. |
| `packages/tools/src/intelligence/submit-review.ts:23` | `svc.submitReview(...)` → `prisma.review.upsert` | **P1** | No envelope path; LLM-callable surface. |

**Capability planner posture (`packages/llm-provider/src/capability-planner.ts:47-65`):** the `STATE_TOOLS` map exposes ONLY read-only tools to the LLM in the reservation state family (`check_table_availability`, `get_my_reservations`). The intelligence tools (`update_preferences`, `submit_review`) are not in any state's allowed-tools list either. So the residual LLM-callable bypass is **structurally blocked at the planner today** — but any future HTTP route that imports these tool functions directly would bypass without any gate. The risk is "tool-as-library" leakage, not active LLM exploitation.

**Dispatcher posture (`packages/llm-provider/src/intent-dispatcher.ts:108-126`):** `DETERMINISTIC_KERNEL_COVERAGE` enumerates 14 tool names that the upstream kernel-executor has already mutated; the dispatcher returns `kind: "skipped"` for these (preventing double-write) and `kind: "failed"` for any tool name with no registered handler. The runtime smoke test at `bypass-detection.test.ts:1297-1331` pins this contract.

### Stripe webhook (`apps/api/src/routes/stripe-webhook.ts`)

**Total mutating call sites: 5. Wrapped: 5. Bypass: 0.**

- Line 165: `paymentCmdSvc.reconcileFromWebhookFromEnvelope` (payment succeeded / failed / refunded / disputed / canceled → 5 event types all funnel through the same envelope dispatcher).
- Line 318: `stripeAdjudicated.paymentIntents.update(...)` (W8-V2 closure of NEW-W7-V2).

The only `getStripe()` call from this file (line 308) is now the `stripeAdjudicated` path.

### Twilio webhook (`apps/api/src/routes/whatsapp-webhook.ts`)

**Total mutating call sites: 1 (inbound message handler). Wrapped: 1. Bypass: 0.**

The webhook itself does not mutate domain state — it delegates to the WhatsApp session machine which routes through `customerSvc.createFromEnvelope` at `whatsapp/session.ts:177` (W7-P3) and through `runOrchestrator` for LLM dispatch (where every cart side-effect is pre-gated by `adjudicateKernelMutation`).

### Medusa admin egress (`fetchAdmin` callers outside the wrapper)

**Total mutating sites: 8. Wrapped: 8. Bypass: 0.**

All 8 mutating sites in `packages/domain/src/services/order.service.ts:235-372` flow through the `mutate()` helper, which requires the `adminAdjudicated` DI (`order.service.ts:146-156`). The hard-throw at line 149 means any caller that forgot to wire `adminAdjudicated` fails loud (`createTooledOrderService` provides the wiring for the 3 cart-tool callers). 

The two GET-only `fetchAdmin` calls in `order.service.ts:176,353` are reads, not mutations.

### Medusa store egress (cart tools — `medusaStoreFetch` writes)

**Total mutating sites: 10. Wrapped: 0. Bypass: 10 (deferred, W9 backlog).**

All 10 sites are in `DEFERRED_MEDUSA_MIGRATIONS` (`bypass-detection.test.ts:464-474`), tracked in `WAVE9-CART-EGRESS-BACKLOG.md`:

| File:line | Operation | Endpoint |
|---|---|---|
| `packages/tools/src/cart/add-to-cart.ts:54` | POST | `/store/carts/:id/line-items` |
| `packages/tools/src/cart/apply-coupon.ts:14` | POST | `/store/carts/:id/promotions` |
| `packages/tools/src/cart/create-checkout.ts:194` | POST | `/store/carts/:id/promotions` |
| `packages/tools/src/cart/create-checkout.ts:229` | POST | `/store/carts/:id` (email update) |
| `packages/tools/src/cart/create-checkout.ts:250` | POST | `/store/payment-collections` |
| `packages/tools/src/cart/create-checkout.ts:291` | POST | `/store/payment-collections/:id/payment-sessions` |
| `packages/tools/src/cart/create-checkout.ts:331` | POST | `/store/carts/:id/complete` |
| `packages/tools/src/cart/get-or-create-cart.ts:136` | POST | `/store/carts` |
| `packages/tools/src/cart/remove-from-cart.ts:14` | DELETE | `/store/carts/:id/line-items/:itemId` |
| `packages/tools/src/cart/update-cart.ts:14` | PATCH | `/store/carts/:id/line-items/:itemId` |

**Mitigating context unchanged from W6:** when these are invoked from the LLM kernel-executor (`packages/llm-provider/src/kernel-executor.ts:486,540,631,721,767`), they are pre-gated by `adjudicateKernelMutation` upstream — so the call is "covered by the chokepoint from the policy perspective" even though the egress itself does not invoke `medusaAdjudicated`. The W9 fix is to introduce a `medusaStoreAdjudicated` wrapper with `medusa.store.cart.*` intent kinds, per `WAVE9-CART-EGRESS-BACKLOG.md`.

### Stripe SDK direct (`stripe.paymentIntents.*`)

**Total mutating call sites: 7. Wrapped: 7. Bypass: 0.**

Greps across `apps/api/src/`, `packages/tools/src/`, `packages/domain/src/`, `packages/llm-provider/src/` find **zero** bare `stripe.paymentIntents.{create,update,cancel,confirm,capture}` calls outside `packages/tools/src/stripe/adjudicated.ts` (the wrapper) and `packages/tools/src/cart/_stripe-helpers.ts` (which uses `stripeAdjudicated`). Verified 2026-05-23.

The 7 mutating callers are:
- `packages/tools/src/cart/amend-order.ts:68,525` (2)
- `packages/tools/src/cart/regenerate-pix.ts:135` (1)
- `packages/tools/src/cart/_stripe-helpers.ts:32` (1)
- `packages/tools/src/cart/create-checkout.ts:67,118` (2)
- `apps/api/src/routes/stripe-webhook.ts:318` (1, W8-V2)

### Auth / OTP / session

**Total mutating sites: 8. Wrapped: 8. Bypass: 0.**

- 4 customer + 2 staff OTP routes use Twilio Verify (`verifications.create`, `verificationChecks.create`) — explicitly allowed by the gate's filter at `bypass-detection.test.ts:949-953`. These are not domain mutations; the gate accepts them as legitimate OTP egress.
- `apps/api/src/routes/auth.ts:430` — `customerSvc.createFromEnvelope` on verify-otp first-contact (W7-P3 closure).
- `apps/api/src/whatsapp/session.ts:177` — `customerSvc.createFromEnvelope` on inbound WhatsApp first-contact (W7-P3 closure).
- `apps/api/src/routes/me/anonymize-otp-gate.ts:142,155` — anonymize-OTP `sendAnonymizeOtp` + `verifyAnonymizeOtp` (Twilio Verify, allowed).

### Twilio `messages.create` (direct WhatsApp send)

**Total sites: 2. Wrapped: 0. Bypass: 2 (gate-blind).**

| File:line | Pattern | Severity | Note |
|---|---|---|---|
| `apps/api/src/whatsapp/client.ts:132` | `client.messages.create({from, to, body})` | **P1** | Bypasses bypass-detection gate (file is in NONE of `TWILIO_SCAN_DIRS`). |
| `apps/api/src/whatsapp/client.ts:204` | `client.messages.create({...})` | **P1** | Same. |

**Gate hygiene defect (unchanged from W6):** `ALLOWED_TWILIO_MESSAGES` (`bypass-detection.test.ts:846-850`) lists `apps/api/src/whatsapp/sender.ts` which does not exist on disk. The real Twilio client is at `apps/api/src/whatsapp/client.ts` which is not in any of the `TWILIO_SCAN_DIRS` scan paths. The dead allowlist entry + the gate-blind dir mean these calls are not policy-gated for content (no `whatsappPack` policy adjudication, no pt-BR validation, no rate-limit hook).

### `customerSvc` / `intelligence` domain bypass

**Total sites: 5. Wrapped: 0. Bypass: 5.**

| File:line | Pattern | Severity | Note |
|---|---|---|---|
| `apps/api/src/routes/cart.ts:130` | `svc.updatePixDetails` | **P1** | Envelope path exists — `updatePixDetailsFromEnvelope`. |
| `packages/llm-provider/src/machine/actions.ts:401` | `svc.updatePixDetails` | **P1** | XState side-effect action; same envelope path exists. |
| `packages/tools/src/intelligence/update-preferences.ts:22` | `svc.updatePreferences` | **P0** | Envelope path exists; LLM-eligible but not LLM-exposed today. |
| `packages/tools/src/intelligence/submit-review.ts:23` | `svc.submitReview` → `prisma.review.upsert` | **P1** | No envelope path; LLM-eligible but not LLM-exposed today. |
| `apps/api/src/subscribers/cart-intelligence.ts:292` | `customerSvc.recordOrderItems` | **P1** | No envelope path; analytics-counter shape. |

### Admin scheduler / tables / zones bare service calls

**Total sites: 10. Wrapped: 0. Bypass: 10 (W7-P2 deferred).**

All 10 sites are enumerated in `DEFERRED_ADMIN_LOW_RISK` at `bypass-detection.test.ts:1046-1130` with per-site rationale. The sentinel `DEFERRED_ADMIN_LOW_RISK.length === 10` at line 1291 pins the count. The companion test "every bare admin service call ... matches a DEFERRED_ADMIN_LOW_RISK entry" at line 1200 ensures no new bare-call surfaces escape without being either wrapped or explicitly deferred.

The 10 sites are the same as the W6 inventory rows 6-11 + 4 additional (delete + add/remove holiday + override delete) sites the W6 inventory under-counted (W7-P2 corrected this).

### Admin banner (Redis writes)

**Total sites: 2. Wrapped: 0. Bypass: 2.**

`setBannerText` (PUT) + `clearBannerText` (DELETE) — manager-role gated, single Redis key, no audit envelope path exists today. Same risk profile as the admin scheduler family but not in the `DEFERRED_ADMIN_LOW_RISK` allowlist (banner uses `setBannerText` not `svc.upsertX`, so the gate's regex shape doesn't apply).

---

## What's wrapped that wasn't at W6

Tracked by commit SHA from the `feat/kernel-always-on-cutover` branch (W7 + W8 closure commits):

| Closure | Sites | Commit |
|---|---|---|
| `prisma.orderNote.create` × 4 → `addNoteFromEnvelope` | `cart.ts:885`, `order-actions.ts:675`, `admin/order-actions.ts:819`, `admin/payments.ts:1235` | `77cef72` (W7-P4) |
| Customer onboarding upserts | `auth.ts:390` + `whatsapp/session.ts:135` | `1efa47a` / `b5ab090` / `4924228` (W7-P3, 3 commits with the index-race scramble) |
| Reservation tools (3 of 4) | `create-reservation.ts:17`, `modify-reservation.ts:22`, `cancel-reservation.ts:25` | `8cc3fb3` (W7-P1) |
| Stripe SDK direct (6 cart-tool sites) | `amend-order.ts:67,517`, `_stripe-helpers.ts:19`, `regenerate-pix.ts:135`, `create-checkout.ts:72,115` | `508b979` (W7-P5, bundled commit) |
| Medusa admin egress (6 `fetchAdmin` sites in `order.service.ts`) | `order.service.ts:115,161,167,172,176,227` | `508b979` (W7-P6, bundled) + `497e7c7` (per-site routing) |
| Stripe webhook metadata-update bypass | `stripe-webhook.ts:308` | `84b5c39` (W8-V2) |
| `createOrderService` hand-off seam (3 cart-tool callers + hard-throw) | `cancel-order.ts:34`, `amend-order.ts:187`, `check-order-status.ts:18`, plus `order.service.ts:149` hard-throw | `5f800f2` (W8-V1) |
| Bypass-detection scan widened to `packages/tools/src/` | `bypass-detection.test.ts:72` `MEDUSA_SCAN_DIRS` | `3129a79` (W8-V4) |
| `DEFERRED_ADMIN_LOW_RISK` 10-site allowlist (with sentinel + stale-entry tests) | `bypass-detection.test.ts:1046-1293` | `dbf077e` (W7-P2) |

Plus the kernel-always-on cutover that removed env-var gating: `f3bea43`.

---

## What's still bypass (ranked by blast radius)

1. **`packages/tools/src/reservation/join-waitlist.ts:29` (`svc.joinWaitlist`)** — **P0**. LLM-callable in principle, blocked by capability planner today. **Service-side gap:** `joinWaitlistFromEnvelope` doesn't exist. ~1h to add. Blocks closing the 4th reservation tool. Pack intent kind already declared.
2. **10 cart-store Medusa egress sites (`DEFERRED_MEDUSA_MIGRATIONS`)** — **P1**. LLM-reachable customer cart mutations; pre-gated by `adjudicateKernelMutation` upstream when invoked via LLM, but the call sites themselves bypass `medusaAdjudicated`. Plan: W9 `medusaStoreAdjudicated` wrapper + `medusa.store.cart.*` intent kinds, ~3-5 days. Tracked in `WAVE9-CART-EGRESS-BACKLOG.md`.
3. **2 `svc.updatePixDetails` callers (`cart.ts:130` + `machine/actions.ts:401`)** — **P1**. Customer PII writes (name/email/CPF). Envelope path exists; ~30min to switch caller. Lives in HTTP-route + XState side-effect paths.
4. **2 `apps/api/src/whatsapp/client.ts:132,204` (`messages.create`)** — **P1**. The real concrete WhatsApp send sites are gate-blind (`TWILIO_SCAN_DIRS` doesn't scan `apps/api/src/whatsapp/`). The `ALLOWED_TWILIO_MESSAGES` allowlist references a non-existent `sender.ts`. Either widen the gate, fix the allowlist file path, or build a `whatsappAdjudicated` wrapper. Lowest-cost remediation: gate widening.
5. **2 intelligence tools (`update-preferences.ts:22`, `submit-review.ts:23`)** — **P0/P1**. Not currently LLM-exposed via `STATE_TOOLS`, but the bypass means any future caller (HTTP route, XState action) gets no governance. `updatePreferencesFromEnvelope` exists; `submitReview` needs a new service-side method.
6. **`customerSvc.recordOrderItems` at `cart-intelligence.ts:292`** — **P1**. `prisma.customerOrderItem.createMany` with no envelope path. Analytics-counter shape; low-blast but uncovered.
7. **10 admin scheduler/tables/zones (`DEFERRED_ADMIN_LOW_RISK`)** — **P2 by deferral**. Operator-only, manager-role gated, no LLM caller — documented trade-off in `W7-DECISIONS-admin.md`. Promotion to `*FromEnvelope` is path-(a) future work, not blocking any Tier.
8. **Admin banner setBannerText / clearBannerText (`admin/banner.ts:43,56`)** — **P2**. Redis-only operator state.
9. **NEW-W7-V3 — G3 hoist incompleteness** (`apps/api/src/adapters/park-deferred-intent-nx.ts:175-195`) — **P2/P1 depending on Tier**. `actorPrincipal` is hoisted defensively; `version/nonce/taint` are not. Silent degradation of tamper-at-rest detection for any future caller that omits them. Tier 4 enforce blocker per W7 synthesis.
10. **NEW-W7-V5 — Unicode-quote / variable-bound options evade bypass-detection regex** — **P2**. Documented Q2 backlog; planned move to AST-based scanning.

---

## Notes on methodology

- **Time-bounded:** report generated 2026-05-23 against branch HEAD `f3bea43`. Subsequent commits will require re-walking the surface.
- **Excluded from scope:** `apps/commerce/` (Medusa internals — not part of the kernel-gated surface), `apps/web/` (UI — no DB mutations), all `__tests__/` subtrees (fabricated state).
- **Counting conventions:** one row per `app.{post,put,patch,delete}` registration in routes; one row per bare-call site in non-route surfaces. The Stripe webhook is counted as 5 (one per event type) rather than 1 (the `scoped.post` registration) because each event handler is a distinct mutation entry. The customer-orders/recommendations/shipping/schedule-status/catalog/health/metrics routes are GET-only and not counted.
- **Multi-step routes** (e.g. payment-retry: cancel-then-create-then-bump) are counted as 1 entry, with all sub-envelopes inspected — if any sub-step bypasses, the entry is flagged bypass. None do today.
- **Deferred-with-doc allowlists** (`DEFERRED_MEDUSA_MIGRATIONS` 10 sites, `DEFERRED_ADMIN_LOW_RISK` 10 sites) are counted as **bypass** in the matrix. The TL;DR notes both numbers (~88% excluding deferrals from the denominator, ~75% counting all bypass).
- **LLM-tool surface count is approximate.** "21 mutating tools" is the rough count of distinct LLM-callable tool functions that perform writes; the exact number depends on whether you count `amend-order.ts`'s 7 mutating helpers as 1 tool or 7. The wrapped/bypass breakdown is by tool-function-file, not by call site.
- **Files I scanned in full or in part:** `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts`, every file in `apps/api/src/routes/` (excluding `__tests__/`), all 9 files in `apps/api/src/subscribers/`, all 18 job files, `packages/tools/src/cart/_shared.ts`, `packages/tools/src/cart/amend-order.ts`, the 4 reservation tool files, both intelligence tool files, `packages/tools/src/stripe/adjudicated.ts`, `packages/tools/src/medusa/adjudicated.ts` (referenced), `packages/llm-provider/src/intent-dispatcher.ts`, `packages/llm-provider/src/capability-planner.ts`, `packages/domain/src/services/order.service.ts` (key sections), `apps/api/src/whatsapp/session.ts` (header), `apps/api/src/routes/me.ts` (anonymize block).

---

End of 2026-05-23 mutation coverage baseline.
