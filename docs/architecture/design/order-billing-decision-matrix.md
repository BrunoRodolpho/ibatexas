# Order × Billing Decision Matrix

> Source of truth for what actions are allowed given order type, fulfillment status, payment status, and payment method. Every customer/admin/system action must be validated against this matrix.

---

## 1. Order Fulfillment States

| Status | Description | Terminal? |
|--------|-------------|-----------|
| `pending` | Order placed, not yet confirmed by kitchen | No |
| `confirmed` | Kitchen accepted, queued for preparation | No |
| `preparing` | Kitchen actively cooking | No |
| `ready` | Food ready for pickup/delivery | No |
| `in_delivery` | Driver en route (delivery only) | No |
| `delivered` | Customer received order | Yes |
| `canceled` | Order canceled | Yes |

### Fulfillment Transition Matrix

```
pending     → confirmed, canceled
confirmed   → preparing, canceled
preparing   → ready, canceled
ready       → in_delivery (delivery), delivered (pickup/dine_in)
in_delivery → delivered
delivered   → (terminal)
canceled    → (terminal)
```

---

## 2. Payment States

| Status | Description | Terminal (per-attempt)? |
|--------|-------------|------------------------|
| `awaiting_payment` | Order created, no PI initiated | No |
| `payment_pending` | PI created, waiting (PIX QR shown / card processing) | No |
| `payment_expired` | PIX QR expired (past `pixExpiresAt`) | Yes* |
| `payment_failed` | Card declined / PI failed | Yes* |
| `cash_pending` | Cash order, payment expected on receipt | No |
| `paid` | Confirmed/captured | No |
| `switching_method` | Transitional: atomic method switch in progress | No |
| `partially_refunded` | Partial refund issued | No |
| `refunded` | Full refund — terminal | Yes |
| `disputed` | Chargeback opened | No |
| `canceled` | PI canceled | Yes |
| `waived` | Admin waived payment | Yes |

*Per-attempt terminal — retry creates a NEW Payment row.

### Payment Transition Matrix

```
awaiting_payment    → payment_pending, cash_pending, canceled
payment_pending     → paid, payment_expired, payment_failed, switching_method, canceled
payment_expired     → canceled
payment_failed      → canceled
cash_pending        → paid, canceled
switching_method    → payment_pending, cash_pending, canceled
paid                → partially_refunded, refunded, disputed
partially_refunded  → refunded
disputed            → paid (won), refunded (lost)
refunded            → (terminal)
canceled            → (terminal)
waived              → (terminal)
```

---

## 3. Order Types

| Type | Description | Has Delivery? | Cash Allowed? | Dine-in? |
|------|-------------|---------------|---------------|----------|
| `delivery` | Delivered to customer address | Yes | No* | No |
| `pickup` | Customer picks up at restaurant | No | Yes | No |
| `dine_in` | Customer eats at restaurant | No | Yes | Yes |

*Cash on delivery is not supported initially (security risk for drivers).

---

## 4. Customer Actions Matrix

### 4.1 Cancel Order

> Customer requests full order cancellation.

| Fulfillment Status | Allowed? | Condition | Behavior |
|--------------------|----------|-----------|----------|
| `pending` | ✅ Yes | Within cancel PONR | Cancel order + cancel active payment |
| `pending` | ⚠️ Escalate | Past cancel PONR | Escalate to admin |
| `confirmed` | ✅ Yes | Within cancel PONR | Cancel order + cancel active payment |
| `confirmed` | ⚠️ Escalate | Past cancel PONR | Escalate to admin |
| `preparing` | ⚠️ Escalate | Always | Kitchen already cooking, escalate |
| `ready` | ❌ No | — | Food ready, cannot cancel |
| `in_delivery` | ❌ No | — | Driver en route |
| `delivered` | ❌ No | — | Use refund flow instead |
| `canceled` | ❌ No | — | Already canceled |

**Payment interaction:** When order is canceled:
- Active payment transitions → `canceled`
- Stripe PI is canceled
- If payment was `paid`, admin must process refund separately

### 4.2 Amend Order — Add Item

| Fulfillment Status | Allowed? | Notes |
|--------------------|----------|-------|
| `pending` | ✅ Yes | No PONR restriction for adds |
| `confirmed` | ✅ Yes | No PONR restriction for adds |
| `preparing` | ✅ Yes | Kitchen notified of addition |
| `ready` | ❌ No | Food already done |
| `in_delivery` | ❌ No | In transit |
| `delivered` | ❌ No | Completed |
| `canceled` | ❌ No | Canceled |

**Payment interaction:** If PIX/card and total changes, new Stripe PI created with updated amount.

### 4.3 Amend Order — Remove Item / Change Quantity

| Fulfillment Status | Allowed? | Condition |
|--------------------|----------|-----------|
| `pending` | ✅ Yes | Within item's amend PONR |
| `pending` | ⚠️ Escalate | Past amend PONR |
| `confirmed` | ✅ Yes | Within item's amend PONR |
| `confirmed` | ⚠️ Escalate | Past amend PONR |
| `preparing` | ⚠️ Escalate | Always escalate — kitchen is cooking |
| `ready`+ | ❌ No | — |

### 4.4 Change Payment Method

| Payment Status | Allowed? | Notes |
|----------------|----------|-------|
| `awaiting_payment` | ✅ Yes | No PI yet — just set method |
| `payment_pending` | ✅ Yes | Cancel old PI → create new |
| `payment_expired` | ✅ Yes | Old attempt terminal, create new Payment row |
| `payment_failed` | ✅ Yes | Old attempt terminal, create new Payment row |
| `cash_pending` | ✅ Yes | Switch to PIX/card |
| `paid` | ❌ No | Already paid |
| `switching_method` | ❌ No | Switch already in progress |
| `partially_refunded` | ❌ No | Already paid, refund in progress |
| `refunded` | ❌ No | Terminal |
| `disputed` | ❌ No | Dispute in progress |
| `canceled` | ✅ Yes* | Only if order still active — create new Payment |
| `waived` | ❌ No | Admin waived |

**Order type restrictions:**

| Switch | delivery | pickup | dine_in |
|--------|----------|--------|---------|
| PIX → card | ✅ | ✅ | ✅ |
| PIX → cash | ❌ | ✅ | ✅ |
| card → PIX | ✅ | ✅ | ✅ |
| card → cash | ❌ | ✅ | ✅ |
| cash → PIX | ✅ | ✅ | ✅ |
| cash → card | ✅ | ✅ | ✅ |

### 4.5 Retry Payment (Same Method)

| Payment Status | Allowed? | Behavior |
|----------------|----------|----------|
| `payment_expired` | ✅ Yes | Create new Payment row + new Stripe PI |
| `payment_failed` | ✅ Yes | Create new Payment row + new Stripe PI |
| `awaiting_payment` | ❌ No | Payment not yet attempted |
| `payment_pending` | ❌ No | Still processing |
| `paid` | ❌ No | Already paid |
| Other terminal | ❌ No | — |

**Rate limits:** 3 PIX regens/hr per customer, 5/order total, 10 retries/order total.

### 4.6 Regenerate PIX QR

| Payment Status | Payment Method | Allowed? |
|----------------|---------------|----------|
| `payment_expired` | PIX | ✅ Yes |
| `payment_pending` | PIX | ❌ No (still valid) |
| `payment_failed` | PIX | ❌ No (use retry) |
| Any | card/cash | ❌ No (not PIX) |

### 4.7 Add Order Notes

| Fulfillment Status | Allowed? | Notes |
|--------------------|----------|-------|
| `pending` | ✅ Yes | |
| `confirmed` | ✅ Yes | Kitchen sees notes |
| `preparing` | ✅ Yes | Kitchen sees notes |
| `ready` | ✅ Yes | For driver/pickup |
| `in_delivery` | ✅ Yes | For driver |
| `delivered` | ✅ Yes | Post-delivery feedback |
| `canceled` | ❌ No | Order canceled |

**Max 500 chars per note, unlimited notes per order.**

### 4.8 Change Delivery Address

| Fulfillment Status | Order Type | Allowed? | Condition |
|--------------------|-----------|----------|-----------|
| `pending` | delivery | ✅ Yes | Within amend PONR |
| `confirmed` | delivery | ✅ Yes | Within amend PONR |
| `preparing` | delivery | ⚠️ Escalate | Past PONR |
| `ready` | delivery | ❌ No | Driver assignment imminent |
| `in_delivery` | delivery | ❌ No | Already dispatched |
| Any | pickup/dine_in | ❌ N/A | No delivery address |

### 4.9 Switch Order Type (delivery ↔ pickup)

| Fulfillment Status | Allowed? | Condition |
|--------------------|----------|-----------|
| `pending` | ✅ Yes | Within amend PONR |
| `confirmed` | ⚠️ Escalate | May affect pricing (delivery fee) |
| `preparing`+ | ❌ No | Too late |

**Payment interaction:** If switching to delivery from pickup, cash payment must switch to PIX/card. If switching to pickup from delivery, delivery fee removed → payment amount changes.

---

## 5. Admin Actions Matrix

| Action | Required Role | Fulfillment Status | Payment Status | Notes |
|--------|-------------|-------------------|----------------|-------|
| Force cancel order | MANAGER+ | Any non-terminal | Any | Cancels payment too |
| Override fulfillment status | MANAGER+ | Any | Any | Bypass normal transitions |
| Confirm cash payment | ATTENDANT+ | Any | `cash_pending` | Marks cash received |
| Issue full refund | MANAGER+ | Any | `paid` | Transitions → refunded |
| Issue partial refund | MANAGER+ | Any | `paid` | Transitions → partially_refunded |
| Override payment status | OWNER | Any | Any | Emergency override |
| Waive payment | OWNER | Any | Non-terminal | Transitions → waived |
| Add admin note | ATTENDANT+ | Any | Any | Internal notes |
| Advance fulfillment | ATTENDANT+ | Non-terminal | Any | Normal status progression |

---

## 6. System Actions

| Trigger | Action | Order Impact | Payment Impact |
|---------|--------|-------------|----------------|
| PIX QR expires (past `pixExpiresAt`) | Transition payment | None | `payment_pending` → `payment_expired` |
| Stripe webhook: succeeded | Reconcile payment | Auto-confirm if pending | → `paid` |
| Stripe webhook: failed | Reconcile payment | None | → `payment_failed` |
| Stripe webhook: dispute | Reconcile payment | None | → `disputed` |
| 24h unpaid order | Stale order cleanup | Cancel order | Cancel payment |
| Payment → `paid` event | Auto-confirm order | `pending` → `confirmed` | — |
| Payment → `refunded` event | Cancel order (if pending/confirmed) | → `canceled` | — |

**PIX QR expiry window** is env-configurable via `PIX_EXPIRY_SECONDS` (default `3600` = 1h, max 3 days). It is set on the Stripe PI at checkout (`expires_after_seconds`) and persisted as `Payment.pixExpiresAt`; the checker job (every 5min) expires payments whose `pixExpiresAt` is in the past — it does not key off a fixed literal.

**Critical invariant:** PIX expiry NEVER cancels the order. Only the stale order checker (24h) auto-cancels unpaid orders.

---

## 7. Channel Parity Requirements

| Action | Web | WhatsApp | Admin |
|--------|-----|----------|-------|
| Cancel order | ✅ | ✅ | ✅ |
| Add item | 🔲 TODO | ✅ | ❌ |
| Remove item | 🔲 TODO | ✅ | ❌ |
| Change quantity | 🔲 TODO | ✅ | ❌ |
| Change payment method | ✅ | ✅ | ✅ |
| Retry payment | ✅ | ✅* | ✅ |
| Regenerate PIX | ✅ | ✅ | ❌ |
| Add notes | ✅ | ❌ TODO | ✅ |
| View payment status | ✅ | ✅ | ✅ |
| Change delivery address | 🔲 TODO | 🔲 TODO | ❌ |
| Switch order type | 🔲 TODO | 🔲 TODO | ❌ |
| Confirm cash | ❌ N/A | ❌ N/A | ✅ |
| Refund | ❌ N/A | ❌ N/A | ✅ |

Legend: ✅ = implemented, 🔲 = planned, ❌ = not applicable, * = via tool

---

## 8. Validation Rules Summary

### Universal Rules (all channels, all order types)
1. **Canceled orders are immutable** — no actions allowed
2. **Delivered orders are immutable** — except notes and refund requests
3. **Paid payments block method switch** — must refund first
4. **Terminal payment statuses are per-attempt** — retry creates NEW row
5. **PONR is per-item, per-action** — different windows for amend vs cancel
6. **Rate limits are per-customer AND per-order** — both must pass
7. **All mutations require distributed lock** — payment-level or order-level
8. **Version field enforces optimistic concurrency** — stale writes fail

### Order Type-Specific Rules
1. **Delivery orders cannot pay with cash** — no cash on delivery
2. **Dine-in orders have relaxed PONR** — can amend until `preparing`
3. **Pickup/dine-in show `ready` as final pre-customer state** — no `in_delivery`

### Payment Method-Specific Rules
1. **PIX QR expiry is env-configurable** (`PIX_EXPIRY_SECONDS`, default 1h) — auto-expires past `pixExpiresAt`, customer can regenerate
2. **Card requires 3DS** — handled by Stripe PaymentElement
3. **Cash requires admin confirmation** — `cash_pending` → `paid` is admin-only
4. **PIX regeneration rate limited** — 3/hr per customer, 5/order total
