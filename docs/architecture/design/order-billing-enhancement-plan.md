# Order × Billing Enhancement Plan

> Final comprehensive plan synthesizing the decision matrix, codebase audit, security review, and review findings.
> Source of truth: `docs/architecture/design/order-billing-decision-matrix.md`

---

## ⚠️ P0 Security Fixes (Deploy Before Any Enhancement)

> Found by backend security audit. These are auth/authz gaps in existing admin payment endpoints.

### S1. Missing Authentication on Admin Payment Endpoints — CRITICAL

**File:** `apps/api/src/routes/admin/payments.ts`

Four endpoints have **NO `preHandler` guard** — any unauthenticated request can hit them:

| Endpoint | Missing Guard | Risk |
|----------|---------------|------|
| `POST /api/admin/orders/:id/payment/confirm-cash` | `requireStaff` | Anyone can confirm cash payments |
| `POST /api/admin/orders/:id/notes` | `requireStaff` | Anyone can add admin notes |
| `GET /api/admin/orders/:id/notes` | `requireStaff` | Exposes customer notes |
| `GET /api/admin/orders/:id/payments` | `requireStaff` | Exposes payment history + Stripe PI IDs |

**Fix:** Add `preHandler: [requireStaff]` to all four routes. `confirm-cash` should require `ATTENDANT+` role.

### S2. Status Override Accepts Arbitrary String — MEDIUM

**File:** `apps/api/src/routes/admin/payments.ts` (PATCH `/payment/status`)

Zod schema uses `z.string().min(1)` instead of `z.enum(Object.values(PaymentStatus))`. Invalid status strings could bypass validation.

**Fix:** Change to `z.enum(["awaiting_payment", "payment_pending", ...])` using PaymentStatus values.

### S3. Missing Order Existence Check in Admin Mutations — HIGH

**File:** `apps/api/src/routes/admin/payments.ts`

Admin confirm-cash, refund, and status-override endpoints don't verify the order exists before mutating payments. IDOR risk.

**Fix:** Add `const order = await orderQuerySvc.getById(id); if (!order) return 404;` to all admin mutation handlers.

### S4. Missing Rate Limits on Amend/Cancel — MEDIUM

**Files:** `apps/api/src/routes/order-actions.ts`

No rate limiting on `POST /orders/:id/amend` and `POST /orders/:id/cancel`. Could enable spam-based race condition attacks.

**Fix:** Add Redis-backed rate limit: max 5 amends + 5 cancels per customer per 10 minutes.

### S5. Refund Amount Upper-Bound Validation — MEDIUM

**File:** `apps/api/src/routes/admin/payments.ts`

No explicit check that `refundAmount <= (amountInCentavos - refundedAmountCentavos)`. Over-refund possible.

**Fix:** Validate `refundAmount <= refundableAmount` before Stripe call.

### S6. `"pay_canceled"` Typo in Stale Order Checker — BUG

**File:** `apps/api/src/jobs/stale-order-checker.ts:73`

```typescript
// BUG: "pay_canceled" doesn't exist — should be "canceled"
status: { notIn: ["refunded", "pay_canceled", "waived", "payment_failed", "payment_expired"] }
```

Stale checker never filters out `canceled` payments, meaning it may attempt to re-cancel already-canceled payments.

**Fix:** Change `"pay_canceled"` to `"canceled"`.

### S7. Amendment Doesn't Sync Payment Table — HIGH

**File:** `packages/tools/src/cart/amend-order.ts:20-57` (`regeneratePixIfNeeded`)

When items are added/removed/qty changed:
1. Medusa order total changes ✓
2. Old Stripe PI canceled ✓
3. New Stripe PI created with new amount ✓
4. **Old Payment row is NEVER transitioned to canceled** ✗
5. **No new Payment row is created for the new PI** ✗

The old Payment row is orphaned with stale `amountInCentavos`. Webhook reconciliation will apply to the new Stripe PI which has no matching Payment row.

**Fix:** After `regeneratePixIfNeeded`, transition old Payment → canceled and create new Payment row with updated amount + new Stripe PI ID.

### S8. Payment Events Not Written to OrderEventLog — MEDIUM

**Files:** `stripe-webhook.ts`, `payment-lifecycle.ts`, `amend-order.ts`

Payment status changes are published to NATS and recorded in `PaymentStatusHistory`, but never appended to `OrderEventLog`. Event sourcing reconstruction from OrderEventLog alone misses all payment transitions.

**Fix:** Append payment events to OrderEventLog with type `payment.status_changed` and discriminator `{paymentId}:{newStatus}`.

### S9. No Handler for `partially_refunded` or `disputed` Payment — MEDIUM

**File:** `apps/api/src/subscribers/payment-lifecycle.ts:169-171`

Payment lifecycle subscriber has no case for `partially_refunded` or `disputed`. Order continues fulfillment silently during a dispute.

**Fix:** Add subscriber cases:
- `disputed` → halt fulfillment, notify staff via NATS
- `partially_refunded` → notify customer, log event

### S10. Lock TTL May Be Too Short for Stripe API — LOW

**File:** `apps/api/src/routes/stripe-webhook.ts:66`

Lock TTL is 10s but Stripe API calls + DB transaction can exceed this under load. Lock could expire mid-operation.

**Fix:** Increase webhook lock TTL to 30s. Monitor actual operation times.

---

## Current State Inventory

### What EXISTS

| Component | File(s) | Status |
|-----------|---------|--------|
| Order fulfillment status enum + transitions | `packages/types/src/order-status.ts` | Complete |
| Payment status enum + transitions | `packages/types/src/payment-status.ts` | Complete |
| PONR engine (per-item, day-of-week overrides) | `packages/domain/src/services/ponr.ts` | Complete |
| Payment CQRS services | `packages/domain/src/services/payment-*.ts` | Complete |
| Order CQRS services | `packages/domain/src/services/order-*.ts` | Complete |
| Cancel order tool + endpoint | `cancel-order.ts`, `order-actions.ts` | Complete |
| Amend order tool (add/remove/qty/change_payment) | `amend-order.ts` | Complete |
| Regenerate PIX tool + endpoint | `regenerate-pix.ts`, `order-actions.ts` | Complete |
| Check payment status tool | `check-payment-status.ts` | Complete |
| Payment retry endpoint | `order-actions.ts` POST `/payment/retry` | Complete |
| Payment method switch endpoint | `order-actions.ts` PATCH `/payment/method` | Complete |
| Order notes endpoint (add + list) | `order-actions.ts` POST/GET `/notes` | Complete |
| PIX expiry checker job | `apps/api/src/jobs/pix-expiry-checker.ts` | Complete |
| Stripe webhook reconciliation | `apps/api/src/routes/webhooks/stripe.ts` | Complete |
| Stale order cleanup (24h) | `apps/api/src/jobs/stale-order-cleanup.ts` | Assumed |
| Test suites (cancel, amend, regenerate-pix, pix-expiry) | `__tests__/` | Complete |
| Decision matrix document | `order-billing-decision-matrix.md` | Complete |
| `deliveryType` field on OrderProjection | Prisma schema | Exists (untyped string) |
| **Web order detail/tracking page** | `apps/web/src/app/[locale]/pedido/[orderId]/page.tsx` | **Complete** |
| **Web order list page** | `apps/web/src/app/[locale]/account/orders/page.tsx` | **Complete** |
| **OrderTimeline component** | `apps/web/src/components/molecules/OrderTimeline.tsx` | **Complete** |
| **OrderActions component** (cancel, retry, switch, regenerate) | `apps/web/src/components/molecules/OrderActions.tsx` | **Complete** |
| **OrderNotes component** (add + list) | `apps/web/src/components/molecules/OrderNotes.tsx` | **Complete** |
| **PaymentStatusBadge component** | `apps/web/src/components/molecules/PaymentStatusBadge.tsx` | **Complete** |
| **PixCountdown component** | `apps/web/src/components/molecules/PixCountdown.tsx` | **Complete** |
| **Customer orders API** | `apps/api/src/routes/customer-orders.ts` GET `/api/customer/orders` | **Complete** |
| **Admin orders API** (list, detail, status update) | `apps/api/src/routes/admin/orders.ts` | **Complete** |
| **Stripe return handler** | `apps/web/src/app/[locale]/pedido/stripe-return/page.tsx` | **Complete** |

### What is MISSING

| # | Gap | Severity | Decision Matrix Section |
|---|-----|----------|------------------------|
| G1 | **OrderType enum** — `deliveryType` is unvalidated string, no `DeliveryType` in `@ibatexas/types` | High | §3 |
| G2 | **Cash-on-delivery block** — no validation prevents cash payment for delivery orders | Critical | §4.4, §8 |
| G3 | **Order type-aware PONR** — dine-in should have relaxed PONR (until `preparing`) | Medium | §8 |
| G4 | **Centralized action validator** — each tool checks its own rules; no shared `canPerformAction()` | High | §8 |
| ~~G5~~ | ~~Web order detail page~~ | ~~Critical~~ | **EXISTS** at `/pedido/[orderId]` with timeline, actions, notes, payment |
| G6 | **Web item amendment UI** — add/remove/qty changes not in web OrderActions (only cancel/retry/switch/regen) | Medium | §7 |
| ~~G7~~ | ~~Web payment management UI~~ | ~~High~~ | **EXISTS**: PixCountdown, PaymentStatusBadge, retry/switch/regenerate in OrderActions |
| G8 | **Admin force cancel, confirm cash, refund, override UI** — admin API exists but no admin UI pages for these actions | High | §5, §7 |
| G9 | **Delivery address change** — no tool, no endpoint, no UI | Medium | §4.8 |
| G10 | **Order type switch** — no tool, no endpoint, no UI (delivery↔pickup) | Medium | §4.9 |
| G11 | **WhatsApp notes** — agent can't add order notes | Low | §7 |
| G12 | **Admin internal notes** — no staff-only notes (separate from customer notes) | Medium | §5 |
| G13 | **Fulfillment status in cancel/amend validation** — amend-order.ts checks Medusa `order.status` not `OrderProjection.fulfillmentStatus` | Medium | §4 |
| ~~G14~~ | ~~PIX countdown on checkout~~ | ~~Medium~~ | **EXISTS** via PixCountdown component on order tracking page |
| G15 | **Switching method state on PATCH endpoint** — `payment_pending` and `cash_pending` not in switchable list | Low | §4.4 |

---

## Implementation Phases

### Phase A: Type Safety & Validation Foundation (Backend)

> Make the decision matrix enforceable in code.

#### A1. OrderType Enum (`@ibatexas/types`)

**File:** `packages/types/src/order-type.ts` (new)

```typescript
export const OrderType = {
  DELIVERY: "delivery",
  PICKUP: "pickup",
  DINE_IN: "dine_in",
} as const

export type OrderType = (typeof OrderType)[keyof typeof OrderType]

export const ORDER_TYPE_LABELS_PT: Record<OrderType, string> = {
  delivery: "Entrega",
  pickup: "Retirada",
  dine_in: "No local",
}
```

Export from `packages/types/src/index.ts`.

**Prisma migration:** Add `OrderType` enum to domain schema, change `OrderProjection.deliveryType` from `String?` to `OrderType?`. Backfill existing rows.

#### A2. Centralized Action Validator (`@ibatexas/types`)

**File:** `packages/types/src/order-action-validator.ts` (new)

Central function implementing the decision matrix:

```typescript
interface ActionContext {
  fulfillmentStatus: OrderFulfillmentStatus
  paymentStatus: PaymentStatus
  paymentMethod: PaymentMethod
  orderType: OrderType
  orderCreatedAt: Date
  itemPonrMinutes?: number
}

type ActionResult =
  | { allowed: true }
  | { allowed: false; reason: string; escalate?: boolean }

export function canPerformAction(
  action: CustomerAction,
  context: ActionContext,
): ActionResult
```

**Actions to validate:**
- `cancel_order` — fulfillment ∈ {pending, confirmed} + within PONR
- `amend_add_item` — fulfillment ∈ {pending, confirmed, preparing}
- `amend_remove_item` — fulfillment ∈ {pending, confirmed} + within PONR; preparing → escalate
- `amend_update_qty` — same as remove
- `change_payment_method` — payment not terminal/paid + order type validates method
- `retry_payment` — payment ∈ {payment_expired, payment_failed}
- `regenerate_pix` — payment = payment_expired + method = pix
- `add_notes` — fulfillment != canceled
- `change_delivery_address` — fulfillment ∈ {pending, confirmed} + orderType = delivery + within PONR
- `switch_order_type` — fulfillment = pending + within PONR

**Cash-on-delivery block** (G2) built into `change_payment_method`:
```typescript
if (newMethod === "cash" && orderType === "delivery") {
  return { allowed: false, reason: "Pagamento em dinheiro não disponível para entrega." }
}
```

**Order type-aware PONR** (G3):
```typescript
// dine_in gets relaxed PONR — can amend until preparing
if (orderType === "dine_in" && ["pending", "confirmed"].includes(fulfillmentStatus)) {
  return { allowed: true } // bypass time-based PONR
}
```

#### A3. Payment Method Switch Validation

**File:** `packages/types/src/payment-method-matrix.ts` (new)

Implements the method × order type matrix from decision matrix §4.4:

```typescript
export function canSwitchPaymentMethod(
  from: PaymentMethod,
  to: PaymentMethod,
  orderType: OrderType,
): boolean
```

#### A4. Refactor Existing Tools to Use Validator

**Files to modify:**
- `packages/tools/src/cart/cancel-order.ts` — replace inline status checks with `canPerformAction("cancel_order", ctx)`
- `packages/tools/src/cart/amend-order.ts` — replace inline checks with validator calls
- `apps/api/src/routes/order-actions.ts` — all endpoints use validator
- `packages/tools/src/cart/regenerate-pix.ts` — use validator for eligibility check

**Key change in amend-order.ts** (G13): Replace `modifiableStatuses = ["pending", "requires_action"]` with proper `OrderFulfillmentStatus` check via the validator.

#### A5. Extend Switchable Payment States (G15)

**File:** `apps/api/src/routes/order-actions.ts`

In PATCH `/payment/method`, add `payment_pending` and `cash_pending` to switchable states (per decision matrix §4.4).

---

### Phase B: New Backend Capabilities

#### B1. Delivery Address Change Tool + Endpoint (G9)

**Tool:** `packages/tools/src/cart/change-delivery-address.ts` (new)

```typescript
export async function changeDeliveryAddress(
  input: { orderId: string; newAddress: ShippingAddress },
  ctx: AgentContext,
): Promise<{ success: boolean; message: string }>
```

- Validate via `canPerformAction("change_delivery_address", ...)`
- Update Medusa order shipping address via admin API
- Update `OrderProjection.shippingAddressJson`
- Publish `order.address_changed` NATS event

**Endpoint:** `PATCH /api/orders/:id/address` in `order-actions.ts`

#### B2. Order Type Switch Tool + Endpoint (G10)

**Tool:** `packages/tools/src/cart/switch-order-type.ts` (new)

```typescript
export async function switchOrderType(
  input: { orderId: string; newType: OrderType },
  ctx: AgentContext,
): Promise<{ success: boolean; message: string }>
```

- Validate via `canPerformAction("switch_order_type", ...)`
- If switching to delivery from pickup: block cash → force method switch
- If switching to pickup from delivery: remove delivery fee, recalculate total
- Update `OrderProjection.deliveryType`
- Publish `order.type_changed` NATS event

**Endpoint:** `PATCH /api/orders/:id/type` in `order-actions.ts`

#### B3. Admin Actions Endpoints (G8)

**File:** `apps/api/src/routes/admin-order-actions.ts` (new)

All endpoints require `requireStaffAuth` middleware with role checks.

| Endpoint | Role | Action |
|----------|------|--------|
| `POST /api/admin/orders/:id/force-cancel` | MANAGER+ | Force cancel any non-terminal order |
| `POST /api/admin/orders/:id/confirm-cash` | ATTENDANT+ | Transition cash_pending → paid |
| `POST /api/admin/orders/:id/refund` | MANAGER+ | Full refund (paid → refunded) |
| `POST /api/admin/orders/:id/partial-refund` | MANAGER+ | Partial refund |
| `POST /api/admin/orders/:id/waive` | OWNER | Waive payment |
| `POST /api/admin/orders/:id/override-status` | OWNER | Emergency override any status |
| `POST /api/admin/orders/:id/advance` | ATTENDANT+ | Normal status progression |
| `POST /api/admin/orders/:id/notes` | ATTENDANT+ | Internal staff note |

#### B4. Admin Internal Notes (G12)

Add `isInternal: Boolean @default(false)` to `OrderNote` Prisma model. Internal notes hidden from customer queries. Admin can see both.

#### B5. WhatsApp Notes Tool (G11)

Register `add_order_note` tool in `TOOL_CLASSIFICATION` for the `post_order` state. Uses existing `OrderNote` create endpoint.

---

### Phase C: Web Customer Order Management (Frontend)

> Close remaining channel parity gaps. Most web UI already exists.

**Already implemented (no work needed):**
- ✅ Order detail/tracking page — `/pedido/[orderId]` with timeline, payment, actions, notes
- ✅ Order list page — `/account/orders` with pending/completed tabs, 15s auto-refresh
- ✅ PixCountdown component — real-time countdown with expiry animation
- ✅ PaymentStatusBadge component — color-coded status badges
- ✅ OrderActions component — cancel, retry payment, switch method, regenerate PIX
- ✅ OrderNotes component — add/view notes
- ✅ OrderTimeline component — adapts for delivery vs pickup/dine-in
- ✅ Customer orders API — `GET /api/customer/orders` with pagination
- ✅ Stripe return handler — `/pedido/stripe-return`

#### C1. Item Amendment UI (G6)

**File:** `apps/web/src/components/molecules/OrderActions.tsx` (modify)

Add to existing OrderActions component:
1. **"Alterar pedido" button** — opens amendment dialog
2. **`AmendOrderDialog.tsx`** (new component) — modal with:
   - Current items list with quantity controls (+/-)
   - Remove item button per row
   - Product search/add for new items
   - PONR countdown display
   - Calls `POST /api/orders/:id/amend` with action: add/remove/update_qty

#### C2. Delivery Address Change UI (G9)

**File:** `apps/web/src/components/molecules/OrderActions.tsx` (modify)

Add to OrderActions (only for delivery orders, within PONR):
1. **"Alterar endereço" button** — opens address form dialog
2. **`ChangeAddressDialog.tsx`** (new component) — address form with validation
3. Calls `PATCH /api/orders/:id/address` (from Phase B1)

#### C3. Order Type Switch UI (G10)

**File:** `apps/web/src/components/molecules/OrderActions.tsx` (modify)

Add to OrderActions (only for pending orders, within PONR):
1. **"Alterar tipo" toggle** — delivery ↔ pickup switcher
2. Shows delivery fee impact message
3. Warns if cash payment must switch for delivery
4. Calls `PATCH /api/orders/:id/type` (from Phase B2)

#### C4. i18n Additions

**File:** `apps/web/messages/pt-BR.json` (modify)

Add keys for:
- `orders.amend_dialog_title`, `orders.amend_add_item`, `orders.amend_remove_item`
- `orders.change_address`, `orders.switch_type`
- `orders.ponr_countdown`, `orders.ponr_expired`

---

### Phase D: Admin Dashboard Order Management (Frontend)

**Already implemented (backend only):**
- ✅ Admin orders API — `GET /api/admin/orders` (list), `GET /api/admin/orders/:id` (detail), `PATCH /api/admin/orders/:id` (status update)
- ✅ Admin payments API — confirm-cash, refund, status override (but see S1-S3 for auth fixes)

#### D1. Admin Order Detail Page — `/admin/orders/[id]`

**File:** `apps/web/src/app/[locale]/admin/orders/[id]/page.tsx` (new)

Extended version of customer order detail:
- All customer-visible info + internal staff notes
- Staff action buttons (force cancel, confirm cash, refund, advance status)
- Payment history (all attempts, not just active)
- Full event timeline
- Customer info (phone, delivery address)

#### D2. Admin Order List Page — `/admin/orders`

**File:** `apps/web/src/app/[locale]/admin/orders/page.tsx` (new)

- All orders (all customers), paginated
- Filters: status, payment status, order type, date range, customer
- Quick actions: advance status, confirm cash
- Highlight: unpaid orders, orders needing attention (escalated)

#### D3. Role-Gated Action Components

- Force cancel: `MANAGER+` only
- Confirm cash: `ATTENDANT+`
- Refund/partial refund: `MANAGER+`
- Override status / waive: `OWNER` only
- Staff notes: `ATTENDANT+`

---

### Phase E: Testing & Documentation

#### E1. Unit Tests for New Code

| Test File | Tests |
|-----------|-------|
| `packages/types/src/__tests__/order-action-validator.test.ts` | All 10 actions × all status combos × all order types |
| `packages/types/src/__tests__/payment-method-matrix.test.ts` | 18 combos (6 switches × 3 order types) |
| `packages/tools/src/cart/__tests__/change-delivery-address.test.ts` | Happy path, PONR, non-delivery, ownership |
| `packages/tools/src/cart/__tests__/switch-order-type.test.ts` | Happy path, cash→pix force, fee adjustment, PONR |
| `apps/api/src/routes/__tests__/admin-order-actions.test.ts` | All 8 admin actions + role checks |

#### E2. Integration Tests

| Scenario | Validates |
|----------|-----------|
| PIX expiry → regenerate → pay → deliver | Full happy path |
| Card fail → retry → switch to PIX → pay | Multi-method flow |
| Cancel before PONR → verify payment canceled | Cancel + payment coordination |
| Cancel after PONR → verify escalation | PONR enforcement |
| Delivery order → attempt cash → blocked | Order type × payment validation |
| Dine-in → amend during preparing → allowed | Relaxed dine-in PONR |
| Switch delivery → pickup → delivery fee removed | Order type switch + recalc |

#### E3. Documentation Updates

| Doc | Changes |
|-----|---------|
| `agent-tools.md` | Add change_delivery_address, switch_order_type, add_order_note |
| `bounded-contexts.md` | Add OrderType to Order context |
| `hybrid-state-flow.md` | Add new tools to post_order state |
| `redis-memory.md` | New lock keys for address change, type switch |
| `analytics-dashboards.md` | New events: address_changed, type_switched, admin actions |
| `domain-model.md` | OrderType enum, isInternal on OrderNote |

---

## Execution Order & Estimates

| # | Phase | Tasks | Effort | Dependencies |
|---|-------|-------|--------|-------------|
| 0a | S1 | **Fix missing auth on admin endpoints** | Trivial | **DEPLOY FIRST** |
| 0b | S2 | Fix status override enum validation | Trivial | None |
| 0c | S3 | Add order existence checks in admin | Small | None |
| 0d | S4 | Add rate limits on amend/cancel | Small | None |
| 0e | S5 | Refund amount upper-bound validation | Trivial | None |
| 0f | S6 | **Fix `"pay_canceled"` typo in stale checker** | Trivial | **DEPLOY FIRST** |
| 0g | S7 | Fix amendment Payment row orphaning | Medium | None |
| 0h | S8 | Write payment events to OrderEventLog | Small | None |
| 0i | S9 | Add disputed/partial-refund handlers | Small | None |
| 0j | S10 | Increase webhook lock TTL to 30s | Trivial | None |
| 1 | A1 | OrderType enum + migration | Small | None |
| 2 | A2 | Centralized action validator | Medium | A1 |
| 3 | A3 | Payment method switch matrix | Small | A1 |
| 4 | A4 | Refactor tools to use validator | Medium | A2, A3 |
| 5 | A5 | Extend switchable payment states | Trivial | None |
| 6 | B1 | Delivery address change | Small | A2 |
| 7 | B2 | Order type switch | Medium | A1, A2 |
| 8 | B3 | Admin action endpoints | Medium | A2 |
| 9 | B4 | Admin internal notes | Small | None |
| 10 | B5 | WhatsApp notes tool | Trivial | None |
| 11 | C1 | Item amendment UI (add to existing OrderActions) | Medium | B1 endpoints |
| 12 | C2 | Delivery address change UI | Small | B1 |
| 13 | C3 | Order type switch UI | Small | B2 |
| 14 | C4 | i18n additions | Small | C1-C3 |
| 15 | D1 | Admin order detail page (new) | Large | B3 |
| 16 | D2 | Admin order list page (new) | Medium | B3 |
| 17 | D3 | Role-gated action components | Small | D1 |
| 18 | E1 | Unit tests | Medium | A-B |
| 19 | E2 | Integration tests | Medium | A-D |
| 20 | E3 | Documentation + minor doc fixes | Small | All |

**Critical path:** S1+S6 (bugs) → A1 → A2 → A4 → B1-B3 → C1 (amendment UI)

**Parallelizable:**
- S1-S10 (all independent, can be done in parallel)
- A5 + B4 + B5 (trivial/independent)
- B1 + B2 + B3 (after A2 completes)
- C1 + C2 + C3 (after respective B endpoints)
- D1 + D2 (after B3)
- E1-E3 (after each phase completes)

**Scope reduction vs initial estimate:** Web order detail page, order list, PIX countdown, payment management components, and payment status badges all already exist. Phase C reduced from 6 tasks (2 Large) to 4 tasks (1 Medium, 2 Small, 1 Small). Total effort reduced ~30%.

---

## Validation Checklist

After all phases complete, verify:

- [ ] Every action in decision matrix §4-6 is validated by `canPerformAction()`
- [ ] Cash on delivery blocked for `OrderType.DELIVERY`
- [ ] PIX expiry NEVER cancels order (only 24h stale cleanup does)
- [ ] All customer actions available on both web and WhatsApp (§7 parity)
- [ ] Admin can: force cancel, confirm cash, refund, override status, add internal notes
- [ ] PONR is order type-aware (dine-in relaxed)
- [ ] Payment method switch is order type-aware
- [ ] All status transitions validated by `canTransition()` / `canTransitionPayment()`
- [ ] Distributed locks on all payment mutations
- [ ] Optimistic concurrency (version field) on all updates
- [ ] All new NATS events documented
- [ ] All new Redis keys use `rk()` and documented
- [ ] All user-facing text in pt-BR
- [ ] All prices in integer centavos
