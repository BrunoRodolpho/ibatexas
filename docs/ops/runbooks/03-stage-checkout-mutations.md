# Stage 3 — Checkout / Order Submission (Risk: High)

> **TL;DR** — committing the order: address, fulfillment method, payment instrument, slot reservation. Last reversible step before money moves. 7-day window; on-call watches in real-time during Stage 3 hours per `docs/ops/analytics-dashboards.md` Stage 3 chart.

## Scope

| Intent kind | Tool name | Notes |
|---|---|---|
| `checkout.create` | `create_checkout` | Materializes order from cart; touches `OrderProjection` |
| `reservation.create` | `create_reservation` | Table booking; consumes a `TimeSlot` |
| `reservation.modify` | `modify_reservation` | Slot swap; releases old, claims new (atomic) |
| `reservation.cancel` | `cancel_reservation` | Releases slot; pre-financial (no refund yet) |
| `waitlist.join` | `join_waitlist` | Capacity-management; no order created |
| `handoff.human` | `handoff_to_human` | Escalation; suspends kernel decisions for that session |
| `order.submit` | (kernel-issued) | The envelope the responder builds when LLM proposes finalizing |

Not in this stage: `order.confirm` (PIX/payment-binding), `cancel_order`, `amend_order` — those are Stage 4 because they touch money or its reversal.

## Pre-flight checklist

- [ ] **Stage 2 enforced ≥7d with zero `DECISION_KIND` + zero non-mechanical `PAYLOAD_REWRITE`**
- [ ] Stage 2 post-stage report filed and signed off
- [ ] Delivery-zone data fresh (Stage 3 leans on `estimate_delivery` reads — stale CEPs cause spurious REFUSE)
- [ ] TimeSlot table healthy (no orphan slots; index integrity verified via `ibx db check:slots` if available)
- [ ] On-call available for the entire shadow window — Stage 3 is the first stage where divergence can disrupt mid-flow customer journeys (e.g., a checkout that legacy would have allowed but kernel refuses leaves the customer stuck on the payment screen)
- [ ] Customer-support team briefed on the rollout window; warm handoff plan ready
- [ ] Rollback rehearsed against staging within last 7d

## Shadow flip

```bash
IBX_KERNEL_SHADOW=checkout.create,reservation.create,reservation.modify,reservation.cancel,waitlist.join,handoff.human,order.submit
ibx svc restart api
```

If `IBX_KERNEL_SHADOW=*` is in effect, skip the env edit.

**Smoke test (15 min):** in staging:
1. Full checkout flow, delivery, card payment placeholder → expect zero `DECISION_KIND`
2. Full checkout flow, pickup, PIX placeholder (status: pending) → expect kernel returns DEFER (Stage 4 territory but envelope shape exercised); legacy may have returned EXECUTE → **`DECISION_KIND` here is OK and EXPECTED** in shadow because Stage 4 is not yet shadow-enforced authoritative; document the count and ensure it matches PIX-pending request count in the same window
3. Reservation flow with double-booked slot → kernel REFUSE, legacy may have raced to EXECUTE → **EXPECTED divergence** during shadow; this is exactly what the kernel adds value for. Triage: confirm the legacy path's last-write-wins behavior is being correctly tightened by the kernel.
4. Handoff to human mid-flow → kernel emits `handoff.human` decision; verify session is marked staff-driven and subsequent LLM intents are short-circuited

## Observation window — 7 days

Watch in PostHog (Stage 3 hourly chart, on-call in real-time during business hours):

| Event | Expected | Action threshold |
|---|---|---|
| `audit_kernel_shadow_diverged_basis` | Moderate (zone/slot vocab) | Investigate if rate >10%/intent |
| `audit_kernel_shadow_diverged_kind` | **Zero**, except documented PIX-pending exception below | Any unexplained occurrence pages |
| `audit_kernel_shadow_diverged_rewrite` | **Zero** | Any occurrence pages — Stage 3 has no expected REWRITE patterns |

### Expected divergence patterns for this stage

- **`order.submit` DECISION_KIND, kernel returns DEFER, legacy returned EXECUTE for PIX-pending:** this is the design — kernel correctly defers PIX submissions until webhook confirmation. Count these but do NOT treat as a bug. They become normal once Stage 4 is shadow-enforced and the DEFER+resume path is exercised end-to-end. Track by `paymentMethod=pix` filter.
- **`reservation.create` DECISION_KIND, kernel REFUSE, legacy EXECUTE on slot collision:** kernel correctly enforces single-booking; legacy occasionally races. **OK in shadow** — this is the kernel adding value. Triage: confirm legacy's race condition was the bug, not the new behavior.
- **`checkout.create` BASIS_ONLY — delivery-zone vocab:** legacy returned generic basis; kernel returns `delivery.zone.outside_radius` etc. **OK.**

### Patterns that page

- **`handoff.human` PAYLOAD_REWRITE:** kernel should never rewrite a handoff — it's a binary escalation signal. PAGE.
- **`checkout.create` REFUSE in kernel where legacy EXECUTEd, when paymentMethod is NOT pix-pending and slot is NOT collided:** unexplained authority loss. PAGE.
- **`reservation.modify` DECISION_KIND where the modify atomically failed in kernel but succeeded in legacy:** the atomic swap is load-bearing; legacy doing it non-atomically would be a Stage 3 regression. PAGE for triage.

## Go/no-go for ENFORCE

All must hold for ≥7 consecutive days:
- Zero unexplained `audit_kernel_shadow_diverged_kind` events (PIX-pending DEFERs are explained)
- Zero `audit_kernel_shadow_diverged_rewrite` events
- Stages 1 and 2 still clean (no regression)
- Tool-call success rate per Stage 3 intent within ±2% of baseline
- Reservation slot-conflict rate (legacy: races; kernel: refuses cleanly) trending toward zero races

## Enforce flip

```bash
IBX_KERNEL_ENFORCE=preference.update,coupon.apply,review.submit,followup.schedule,order.note.add,cart.add,cart.remove,cart.update,cart.create_or_get,cart.reorder,checkout.create,reservation.create,reservation.modify,reservation.cancel,waitlist.join,handoff.human,order.submit
ibx svc restart api
```

**24h watchlist (active monitoring):**
- Order-creation rate within ±3% of prior week (controlling for traffic)
- Reservation-creation success rate steady; double-booking rate **at zero** (kernel enforces atomicity)
- PostHog: `checkout_started` → `order_placed` funnel conversion stable
- Sentry: zero new `kernel_authoritative_*` errors

**7d watchlist:**
- Customer-support tickets mentioning checkout / reservation: no spike
- Refusal codes from `checkout.create` distribution stable (top reasons: out_of_stock, payment_method_required, etc.)

**30d watchlist:**
- File post-stage report; proceed to Stage 4 pre-flight (which has a 14-day shadow window — plan accordingly)

## Rollback

```bash
# Drop Stage 3 from ENFORCE; keep Stages 1 + 2
IBX_KERNEL_ENFORCE=preference.update,coupon.apply,review.submit,followup.schedule,order.note.add,cart.add,cart.remove,cart.update,cart.create_or_get,cart.reorder
ibx svc restart api
```

**Mid-flow rollback caveats** (Stage 3 is the first stage where this matters):
- A customer mid-checkout when rollback fires will see one inconsistent decision; the order projection may briefly diverge
- Reservation slot claims under enforce are committed in Redis + Postgres; legacy will see them as occupied (no data corruption)
- If a customer reports "my reservation disappeared" within 30 min of rollback, check the slot release log first — kernel's atomic release may have fired in a way legacy doesn't expect

## Escalation

| Severity | Trigger | Page | Channel |
|---|---|---|---|
| S3 | `BASIS_ONLY` rate >10%/intent | No | Slack `#ibx-rollout` |
| S2 | `DECISION_KIND` event in shadow not matching documented PIX-pending exception | Yes | PagerDuty (intent-kernel) |
| S2 | Reservation atomic-swap divergence (modify) | Yes | PagerDuty + reservations team |
| S1 | `PAYLOAD_REWRITE` event | Yes | PagerDuty + intent-kernel maintainer; immediate review (Stage 3 has no expected REWRITE) |
| S1 | Order-creation rate drops >5% post-enforce | Yes | PagerDuty + owner WhatsApp; rollback |
| S1 | Double-booking detected post-enforce | Yes | PagerDuty + owner; this should be impossible — investigate before rollback (rollback would reintroduce the race) |

## Post-stage report template

File at `docs/ops/runbooks/reports/stage-03-<YYYY-MM-DD>.md`:
- Stage 1 + Stage 2 + Stage 3 cumulative `DECISION_KIND` / `PAYLOAD_REWRITE` counts (must be 0 to flip Stage 4)
- PIX-pending DEFER count during Stage 3 shadow (informs Stage 4 baseline)
- Reservation slot-collision count: pre-enforce vs post-enforce (expect: pre>0, post=0)
- Surprises, especially around handoff.human and waitlist
- Stage 4 readiness: webhook subscriber health, ledger flag pre-flight (`IBX_LEDGER_ENABLED`)
- Sign-offs: on-call lead, intent-kernel maintainer, customer-support lead
