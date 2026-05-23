# Wave 3 — Intent-Kind Gaps

**Date:** 2026-05-23
**Branch:** `feat/adjudicate-w3-money-path`
**Purpose:** Track intent kinds named by W3 fixes that do NOT yet exist in any pack. Each row is an input to Wave 5 (pack-payments creation + pack-orders extension + KNOWN_INTENT_KINDS reconciliation).

The W3 fixes use the **closest available envelope-typed entry point** today (typically `paymentCmdSvc.transitionStatusFromEnvelope` / `createFromEnvelope` against `paymentProjectionPolicyBundle`) so the kernel sees and audits the mutation. When Wave 5 lands `@ibatexas/pack-payments`, the call sites enumerated here become the migration list.

## P0-1 — Refund magnitude

| Wave 5 intent kind | Used today | Surface |
|---|---|---|
| `payment.refund.issue` | `payment.status.transition` (with `refundedAmountCentavos` rewritten inside executor under EXECUTE branch) | `apps/api/src/routes/admin/payments.ts` refund step-1 + step-2 + `executeRefund` helper |

**Why the gap:** `paymentProjectionPolicyBundle` doesn't model a `refund_amount` cap as a policy guard — the cap is enforced at the HTTP layer (`refundAmount > refundableAmount` check) and the magnitude is forwarded into the audit `reason` field rather than carried in a typed payload. Wave 5 should:
- Declare `payment.refund.issue` + `payment.refund.issue.confirm` kinds in pack-payments.
- Add a magnitude-based decision guard:
  - amount > R$500 AND ≤ R$1000 → REQUEST_CONFIRMATION (matches W3 threshold).
  - amount > R$1000 → ESCALATE (matches `ESCALATE_REFUND_THRESHOLD_CENTAVOS` in pack-payments-pix per governance §"04-decision-policy.md").
- Validate `amount ≤ refundableAmount` as a state guard.

## P0-2 — payment/retry + regenerate-pix

| Wave 5 intent kind | Used today | Surface |
|---|---|---|
| `payment.retry` | `payment.status.transition` (cancel old) + `payment.create` (new attempt) | `apps/api/src/routes/order-actions.ts` payment/retry handler |
| `payment.pix.regenerate` | `payment.status.transition` (cancel old) + `payment.create` (new attempt) + `payment.regeneration.count.increment` (synthetic) | `apps/api/src/routes/order-actions.ts` regenerate-pix handler |

**Why the gap:** The retry/regenerate flows are atomic-conceptually (cancel-old → create-new → bump-counter) but envelope-decompose into 2-3 separate envelopes today because the existing `paymentProjectionPolicyBundle` doesn't model the composite operation. The `regenerationCount` increment is wrapped today as an envelope-typed `bumpRegenerationCountFromEnvelope` (added in W3) but the kind label is `payment.create` for the new payment and a synthetic `payment.regeneration.count.increment` kind for the bump. Wave 5 should:
- Declare `payment.retry` and `payment.pix.regenerate` as composite intent kinds with executors that internally do the multi-step transition.
- Add a rate-limit guard inside the pack (the current per-customer-per-hour cap is a Redis check at the route layer; should move into the pack as a state guard).
- Declare `payment.regeneration.count.increment` as a SYSTEM-only kind or merge it into `payment.pix.regenerate`'s executor.

## P0-3 — amend-order pipeline

| Wave 5 intent kind | Used today | Surface |
|---|---|---|
| `order.amend.add_item` / `order.amend.update_qty` / `order.amend.remove_item` | `medusa.admin.order.edit.create` + `medusa.admin.order.edit.items` + `medusa.admin.order.edit.confirm` (each via `medusaAdjudicated()`) | `packages/tools/src/cart/amend-order.ts` |
| `payment.method.switch` (already declared in `paymentProjectionPolicyBundle`) | Used directly via `payment.status.transition` chain | `packages/tools/src/cart/amend-order.ts` change_payment branch |
| `payment.create` (Stripe PI replacement on amend) | `payment.create` via `paymentCmdSvc.createFromEnvelope` | `packages/tools/src/cart/amend-order.ts` `syncPaymentAfterAmendment` |

**Why the gap:** Amendment is conceptually a single operation (modify order → recompute total → regenerate payment) but decomposes into 5-6 envelopes today. `pack-orders` doesn't declare an `order.amend.batch` kind. Wave 5 should:
- Either declare `order.amend.batch` as a composite kind that the pack adjudicates as a single envelope, OR
- Keep the per-step decomposition (current) but extend `pack-orders` with the granular `order.amend.add_item` / `order.amend.update_qty` / `order.amend.remove_item` kinds so the adopter's `pack-orders.adjudicate()` call replaces the inline `medusaAdjudicated()` calls in amend-order.ts.

## P1-I — Refund drip cap

No intent-kind gap. The aggregate-per-day cap is a route-layer guard (Redis counter `refund:daily-total:{staffId}:{YYYY-MM-DD}`) that gates the existing `payment.status.transition` envelope path. Wave 5 may move this guard into pack-payments as a state-guard if a `RefundDripState` snapshot becomes part of the standard state shape.

## P1-L — ALLOWED_MEDUSA_DIRECT carve-out

No intent-kind gap. This is a bypass-detection test correction (remove POST-writers from the carve-out list).

## Action items for Wave 5

1. **Create `@ibatexas/pack-payments`** with:
   - `payment.refund.issue` + `payment.refund.issue.confirm` (matches governance §"04-decision-policy.md" threshold ladder).
   - `payment.retry` + `payment.pix.regenerate` (composite kinds with rate-limit state guards).
   - `payment.create`, `payment.status.transition`, `payment.status.reconcile`, `payment.method.switch` — migrate from `paymentProjectionPolicyBundle` (currently domain-internal).
2. **Extend `@ibatexas/pack-orders`** with `order.amend.add_item` / `order.amend.update_qty` / `order.amend.remove_item` OR `order.amend.batch`.
3. **Reconcile `KNOWN_INTENT_KINDS`** with the new pack-payments kinds.
4. **Remove `paymentProjectionPolicyBundle`** in favor of pack-payments (domain-internal bundle replaced by first-party pack).
5. **Update tests** in `apps/api/src/routes/admin/__tests__/force-routes-governance.test.ts` to use the new pack-payments kinds.

## Status

| Gap | Status | Wave 5 owner |
|---|---|---|
| `payment.refund.issue` declaration | OPEN | pack-payments task |
| `payment.retry` declaration | OPEN | pack-payments task |
| `payment.pix.regenerate` declaration | OPEN | pack-payments task |
| `order.amend.batch` (or granular) declaration | OPEN | pack-orders extension task |
| `paymentProjectionPolicyBundle` → pack-payments migration | OPEN | pack-payments task |
