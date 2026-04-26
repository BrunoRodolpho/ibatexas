# Stage 4 — Financial Reversals & Money-Moving (Risk: Critical)

> **TL;DR** — the irreversible money-flow stage. Order confirmation against PIX, cancellations that trigger refunds, payment-instrument re-issuance. **14-day** shadow window per `intent-shadow.ts` operational policy. Ledger enforcement engages here.

## Scope

| Intent kind | Tool name | Notes |
|---|---|---|
| `order.confirm` | (kernel-issued via `order.tool.propose`) | Binds payment status; kernel returns DEFER for pending PIX |
| `order.cancel` | `cancel_order` | Triggers downstream refund logic in `apps/api/src/payments/` |
| `order.amend` | `amend_order` | Modifies financial commitment (line items, total) |
| `payment.regenerate_pix` | `regenerate_pix` | Issues new PIX QR; voids old |
| `payment.set_pix_details` | `set_pix_details` | Binds PIX payload to order |

DEFER + webhook resume path (`apps/api/src/subscribers/defer-resolver.ts` → `@adjudicate/runtime resumeDeferredIntent`) exercises here. Ledger SET-NX dedup prevents double-execution from duplicate webhook deliveries.

## Pre-flight checklist

This is the most demanding pre-flight in the rollout. Skipping any of these has caused incidents in similar zero-trust rollouts.

- [ ] **Stage 3 enforced ≥7d with zero `DECISION_KIND` + zero `PAYLOAD_REWRITE`** (no exceptions for Stage 4 pre-flight)
- [ ] Stage 3 post-stage report filed and signed off
- [ ] **Ledger flags staged:**
  - [ ] `IBX_LEDGER_ENABLED=true` running ≥14d in production (shadow ledger writes only)
  - [ ] Ledger Redis circuit-breaker exercised in chaos drill within last 30d (`IBX_LEDGER_FAIL_OPEN=true` decision documented)
  - [ ] Postgres audit sink (`@adjudicate/audit-postgres`) writing without backlog (lag <30s)
- [ ] **Webhook subscriber resilience verified:**
  - [ ] `payment.status_changed` NATS subject draining without lag (>1s lag pages already)
  - [ ] `defer-resolver.ts` deployed + healthy; smoke: park a fake DEFER, deliver PIX webhook, observe resume in <5s
  - [ ] Property tests in `packages/intent-runtime/tests/defer-resume.test.ts` clean on the deployed SHA — N=50 concurrent invariant must hold
- [ ] **Refund pipeline:** existing manual-refund tooling tested within last 7d as fallback if kernel REFUSE blocks an in-flight refund
- [ ] **On-call:**
  - [ ] Two-person on-call rotation for the full 14-day window (fatigue is a real risk on long shadow soaks)
  - [ ] Escalation tree includes the owner directly (not just on-call) for any S1
- [ ] **Customer-comms** template approved for "your order is processing — we're verifying payment" wording, in case kernel DEFER prolongs a customer's wait beyond legacy's silent-execute UX
- [ ] **Compliance / legal** sign-off on the audit-trail format (`audit.intent.decision.v1` NATS subject + `intent_audit` Postgres table)

## Shadow flip

```bash
# enable kernel shadow for Stage 4 intents
IBX_KERNEL_SHADOW=order.confirm,order.cancel,order.amend,payment.regenerate_pix,payment.set_pix_details
# ledger remains shadow-only — DO NOT enforce yet
IBX_LEDGER_ENABLED=true
IBX_LEDGER_ENFORCE=false
IBX_LEDGER_FAIL_OPEN=true
ibx svc restart api
```

If `IBX_KERNEL_SHADOW=*` is in effect, this stage is already shadowed; re-confirm by tailing logs for shadow-mode markers from Stage 4 intent kinds.

**Smoke test (30 min):**
1. End-to-end PIX order: cart → checkout → confirm → webhook delivers `paid` → resume fires → order placed. Verify single `kernel_authoritative_decision` per intent and `defer-resolver: resumed deferred intent` exactly once in logs.
2. **Idempotency check:** replay the same PIX webhook 5 times within 60s. Verify exactly one resume, four `duplicate_resume_suppressed`, and no double-charge / double-order in `OrderProjection`.
3. Cancel a paid order → verify kernel returns EXECUTE, refund triggered, audit record on `audit.intent.decision.v1`.
4. Amend a paid order → verify atomic swap of total + line items; if amend would reduce total, refund delta triggered.
5. Regenerate PIX QR for a pending order → verify old QR returns `payment.qr.expired` decision when scanned, new QR is the active one.

## Observation window — 14 days

Watch in PostHog (Stage 4 chart includes both `_diverged_kind` and `_diverged_rewrite`):

| Event | Expected | Action threshold |
|---|---|---|
| `audit_kernel_shadow_diverged_basis` | Lower than Stage 3 (vocab mostly settled by now) | Investigate if rate >5%/intent |
| `audit_kernel_shadow_diverged_kind` | **Zero**, no exceptions | Any occurrence pages S1 |
| `audit_kernel_shadow_diverged_rewrite` | **Zero**, no exceptions | Any occurrence pages S1 |
| `intent.ledger_op outcome=duplicate` | Matches webhook-replay rate (expected) | Spike could mean broker storm |
| `intent.ledger_op outcome=error` | Zero | Any occurrence: investigate Redis health |

Real-time dashboards during business hours; alert-rules duty during off-hours.

### Expected divergence patterns for this stage

- **`order.confirm` DEFER vs legacy EXECUTE for PIX-pending:** still expected, same as Stage 3 documented exception. Will *go to zero* once Stage 4 enforce is on (kernel's DEFER becomes authoritative).
- **`order.cancel` BASIS_ONLY — refund-eligibility vocab:** legacy returned generic `cancel.ok`; kernel returns `refund.eligible.full` / `refund.eligible.partial.shipping_excluded`. **OK** — vocab upgrade.
- **Ledger `duplicate` events:** correlate 1:1 with retried/duplicated webhooks from Stripe/PIX broker. Audit basis emitted: `ledger.replay_suppressed`. **OK by design.**

### Patterns that page S1 immediately

- **`order.confirm` PAYLOAD_REWRITE:** kernel must never substitute order details (items, total, address). PAGE S1 + freeze rollout.
- **`order.cancel` DECISION_KIND, kernel REFUSE where legacy EXECUTE:** could mean kernel is blocking legitimate cancellations. Customers stuck = revenue + trust issue. Verify the basis; if it's a known compliance window (e.g., already-shipped), legacy was the bug. If basis is unexplained, page.
- **`order.amend` PAYLOAD_REWRITE other than mechanical re-totaling:** amend must not reshape the order. PAGE.
- **Ledger `error` events:** dedup is load-bearing in Stage 4. If errors persist >2 min, switch `IBX_LEDGER_FAIL_OPEN=true` (already default at this point) and page Redis on-call.
- **Webhook delivery lag >30s** on `payment.status_changed`: page broker on-call. Lag means parked DEFERs may expire (15-min timeout) before resume fires.

## Go/no-go for ENFORCE

**14 consecutive days, all true:**
- Zero `audit_kernel_shadow_diverged_kind` events
- Zero `audit_kernel_shadow_diverged_rewrite` events
- Zero ledger `error` events
- Stage 1, 2, 3 all still clean (cumulative regression check)
- DEFER → resume round-trip p99 latency <5s
- Refund-pipeline integration tests passing on the deployed SHA
- Owner sign-off explicitly recorded (S4 needs escalation beyond on-call)

If any criterion fails, **reset the 14-day clock**. No partial credit.

## Enforce flip

```bash
# kernel becomes authoritative for ALL intent kinds
IBX_KERNEL_ENFORCE=*
# ledger becomes authoritative
IBX_LEDGER_ENABLED=true
IBX_LEDGER_ENFORCE=true
IBX_LEDGER_FAIL_OPEN=false       # fail-safe in financial path
ibx svc restart api
```

**1h watchlist (war-room mode):**
- Order-creation rate, refund-trigger rate, payment-confirm rate within ±2% of prior week
- Sentry: zero new errors with `kernel_authoritative_*` or `ledger_unavailable` markers
- DEFER → resume round-trip p99 stable
- Customer-support inbox: zero new tickets mentioning "stuck on payment" or "refund didn't arrive"

**24h watchlist:**
- Same as 1h, broader window
- Audit-trail completeness check: every order in last 24h has matching `audit.intent.decision.v1` record + `intent_audit` Postgres row

**7d watchlist:**
- Refund-completion latency unchanged
- Webhook-driven resumes account for the right share of order completions (e.g., if PIX is 60% of payments, ~60% of orders should have a resume audit record)
- File post-rollout summary at `docs/ops/runbooks/post-rollout-summary.md`; declare v2.0 GA.

## Rollback

**Stage 4 rollback is delicate — it can leave in-flight payments orphaned. Preferred response to Stage 4 incident is forward-fix, not rollback.** Only roll back if forward-fix is unavailable AND the issue is causing revenue loss or compliance risk.

```bash
# Drop ENFORCE wildcard, drop ledger enforcement
IBX_KERNEL_ENFORCE=preference.update,coupon.apply,review.submit,followup.schedule,order.note.add,cart.add,cart.remove,cart.update,cart.create_or_get,cart.reorder,checkout.create,reservation.create,reservation.modify,reservation.cancel,waitlist.join,handoff.human,order.submit
IBX_LEDGER_ENFORCE=false
IBX_LEDGER_FAIL_OPEN=true
ibx svc restart api
```

**Post-rollback recovery:**
- Audit any `intent.ledger_op outcome=duplicate` events fired during the rollback window — these were correctly suppressed by the kernel; legacy will *not* suppress, so a flood of duplicate webhooks immediately after rollback may double-execute. Pause webhook delivery briefly (Twilio sandbox, Stripe dashboard) if the issue causing rollback was webhook-related.
- Reconcile any DEFERed envelopes still parked in Redis (`rk("defer:pending:*")`). Legacy doesn't know about these — manually drain by either replaying the webhook (which kernel-shadow will still see) or expiring naturally.
- File incident report within 24h.

## Escalation

| Severity | Trigger | Page | Channel |
|---|---|---|---|
| S2 | `BASIS_ONLY` rate >5%/intent | Yes | PagerDuty (kernel maintainer) |
| S1 | `DECISION_KIND` event in shadow | Yes | PagerDuty + owner WhatsApp |
| S1 | `PAYLOAD_REWRITE` event in shadow | Yes | PagerDuty + owner WhatsApp + intent-kernel maintainer |
| S1 | Ledger `error` event >2 min | Yes | PagerDuty + Redis on-call |
| S1 | DEFER → resume round-trip p99 >30s | Yes | PagerDuty + broker on-call |
| S0 | Double-charge or double-execution detected post-enforce | Yes | War-room: owner + on-call + intent-kernel + payments lead. Forward-fix preferred over rollback. |
| S0 | Refund pipeline blocking legitimate cancellations >5 min | Yes | Same as above; consider Stage 4 partial rollback |

## Post-stage report

This is the **post-rollout summary** — file at `docs/ops/runbooks/post-rollout-summary.md`:

- Total `DECISION_KIND` / `PAYLOAD_REWRITE` events across all stages cumulative
- Total ledger `duplicate` events (correlate to webhook-retry rate; expected non-zero)
- DEFER → resume round-trip latency distribution (median, p99, max) over the 14-day window
- Refund-pipeline trace: pre-enforce vs post-enforce — refund completion rate, latency
- Surprises that did not appear in earlier stages
- Outstanding follow-ups for v3.0: any kernel behaviors that should be templates-aware
- Sign-offs: owner, on-call lead, intent-kernel maintainer, payments lead, compliance

After this report is filed, declare v2.0 GA. Update `docs/PROJECT_STATE.md` and `docs/architecture/decisions.md` ADR #9 with the GA date.
