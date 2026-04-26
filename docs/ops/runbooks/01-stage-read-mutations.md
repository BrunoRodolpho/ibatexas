# Stage 1 — Read-like Mutations (Risk: Low)

> **TL;DR** — first kernel-authoritative stage. Idempotent / reversible mutations that don't commit money or block flows. 7-day zero-divergence window before flipping ENFORCE.

## Scope

Intent kinds covered in this stage:

| Intent kind | Tool name | Why "read-like" |
|---|---|---|
| `preference.update` | `update_preferences` | Toggle on a customer record; reversible, idempotent |
| `coupon.apply` | `apply_coupon` | Reversible: removes cleanly if customer changes mind |
| `review.submit` | `submit_review` | Free text + rating; no financial impact |
| `followup.schedule` | `schedule_follow_up` | Reminder scheduling; no order state change |
| `order.note.add` | `add_order_note` | Note appended to existing order; no financial impact |

`order.tool.propose` envelopes whose underlying `toolName` is in this list count as Stage 1 traffic.

## Pre-flight checklist

- [ ] B0 baseline complete: `IBX_KERNEL_SHADOW=*` ran in staging ≥48h with telemetry verified flowing to Sentry + PostHog
- [ ] Dashboards green: no open Sentry alerts for `audit_kernel_shadow_diverged_*`
- [ ] On-call briefed; this runbook open in shared tab
- [ ] Rollback procedure rehearsed against staging (≤2 min from flip to revert)
- [ ] `pnpm test --filter @ibx/intent-kernel --filter @ibx/intent-runtime` clean on the deployed SHA

## Shadow flip (if not already covered by `IBX_KERNEL_SHADOW=*`)

If running narrow shadow rather than wildcard:

```bash
IBX_KERNEL_SHADOW=preference.update,coupon.apply,review.submit,followup.schedule,order.note.add
ibx svc restart api
```

**Smoke test (5 min):** trigger one example of each intent kind via WhatsApp test number; in PostHog confirm one `audit_kernel_shadow_diverged_basis` (or no event) per intent — never `..._diverged_kind` or `..._diverged_rewrite` on a clean smoke.

## Observation window — 7 days

Watch in PostHog (`docs/ops/analytics-dashboards.md` Stage 1 chart):

| Event | Expected | Action threshold |
|---|---|---|
| `audit_kernel_shadow_diverged_basis` | Non-zero is OK (vocab differences) | Flag for review only if rate >5%/intent |
| `audit_kernel_shadow_diverged_kind` | **Zero** | Any occurrence pages on-call; fix policy bug before flip |
| `audit_kernel_shadow_diverged_rewrite` | **Zero** | Any occurrence pages on-call; manual review per event |

Sentry alerts:
- `kernel_shadow_diverged_kind` rate >0.1% per intent class for >5 min → page (configured)
- `kernel_shadow_diverged_rewrite` any occurrence → page (configured)

### Expected divergence patterns for this stage

- **`apply_coupon` BASIS_ONLY drift:** legacy returns generic basis; kernel returns vocabulary-controlled `coupon.eligible` / `coupon.exhausted`. **OK** — vocab upgrade artifact.
- **`update_preferences` BASIS_ONLY:** legacy elides basis when no-op; kernel always emits `preference.unchanged`. **OK.**
- **`submit_review` PAYLOAD_REWRITE:** kernel may strip URLs from review text via the validation-layer REWRITE path. **Investigate** — should be rare; if pattern, tighten the LLM prompt rather than relying on REWRITE.

## Go/no-go for ENFORCE

All must hold for ≥7 consecutive days:
- Zero `audit_kernel_shadow_diverged_kind` events
- Zero `audit_kernel_shadow_diverged_rewrite` events (PAYLOAD_REWRITE)
- All `audit_kernel_shadow_diverged_basis` patterns explained and signed off in the Stage 1 review doc

If any criterion fails: stay in shadow, fix the policy bug or vocab gap, reset the 7-day clock.

## Enforce flip

```bash
IBX_KERNEL_ENFORCE=preference.update,coupon.apply,review.submit,followup.schedule,order.note.add
# IBX_KERNEL_SHADOW remains as-is (covers later-stage intents)
ibx svc restart api
```

**24h watchlist:**
- Sentry: zero new `kernel_authoritative_*` errors
- PostHog: tool-call success rate per intent kind unchanged (±2%) vs prior week
- Customer-support inbox: no spike in "preferences not saving" / "coupon not applying" tickets

**7d watchlist:**
- Tool-call success rate stable
- Refusal rate by `refusalCode` matches baseline (no surprise denials)

**30d watchlist:**
- File post-stage report (template below) and proceed to Stage 2 pre-flight

## Rollback

```bash
# 1. revert ENFORCE list — drop Stage 1 intents
IBX_KERNEL_ENFORCE=  # or whatever subset was previously stable
# 2. restart
ibx svc restart api
# 3. verify
ibx infra status
```

Verify in PostHog: `kernel_authoritative_decision` events drop for Stage 1 intent kinds within ~2 min of restart.

If a customer was mid-flow during rollback, their session may see one anomalous decision; the legacy path is idempotent so retry resolves cleanly.

## Escalation

| Severity | Trigger | Page | Channel |
|---|---|---|---|
| S3 | `BASIS_ONLY` rate >5%/intent | No | Slack `#ibx-rollout` |
| S2 | Single `DECISION_KIND` event in shadow | Yes | PagerDuty (intent-kernel) |
| S2 | Single `PAYLOAD_REWRITE` event | Yes | PagerDuty (intent-kernel) |
| S1 | `DECISION_KIND` rate >0.1% intent for >5 min in shadow | Yes | PagerDuty + WhatsApp owner |
| S1 | Tool-call success rate drops >5% post-enforce | Yes | PagerDuty + WhatsApp owner; trigger rollback |

## Post-stage report template

File at `docs/ops/runbooks/reports/stage-01-<YYYY-MM-DD>.md`:

- Total `BASIS_ONLY` events: <count>; top 3 patterns
- Total `DECISION_KIND` events during shadow: <count> (must be 0 to flip)
- Total `PAYLOAD_REWRITE` events during shadow: <count> (must be 0 to flip)
- Date shadow started / date enforce flipped
- Surprises: <free form>
- Open questions for Stage 2: <free form>
- Sign-offs: on-call lead, intent-kernel maintainer
