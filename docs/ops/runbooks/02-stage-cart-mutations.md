# Stage 2 — Cart / Order Updates (Risk: Medium)

> **TL;DR** — cart-state mutations. User-reversible (can re-add/re-remove) but multi-step state machine and cross-cutting promotions logic make divergence more likely than Stage 1. 7-day window.

## Scope

| Intent kind | Tool name | Notes |
|---|---|---|
| `cart.add` | `add_to_cart` | Quantity bounds + product availability checked by kernel |
| `cart.remove` | `remove_from_cart` | Idempotent on missing items |
| `cart.update` | `update_cart` | Quantity-change envelope; subject to mechanical-cap REWRITE |
| `cart.create_or_get` | `get_or_create_cart` | Initialization-only side effects |
| `cart.reorder` | `reorder` | Bulk add from prior order; allergen + availability re-validated |

## Pre-flight checklist

- [ ] **Stage 1 enforced ≥7d with zero `DECISION_KIND` + zero `PAYLOAD_REWRITE`**
- [ ] Stage 1 post-stage report filed and signed off
- [ ] Cart-related tool-call success rate stable for ≥7d
- [ ] Inventory feed healthy (Stage 2 leans on `check_inventory` reads — outages here cause spurious DEFER)
- [ ] On-call briefed; runbook open
- [ ] Coupon edge cases reviewed (Stage 1 covered `apply_coupon`; cart updates can implicitly recompute coupon eligibility — expect related `BASIS_ONLY` here)

## Shadow flip

```bash
IBX_KERNEL_SHADOW=cart.add,cart.remove,cart.update,cart.create_or_get,cart.reorder
ibx svc restart api
```

If `IBX_KERNEL_SHADOW=*` is already in effect, this stage is already shadowed; skip the env edit and treat the day-zero observation as starting now.

**Smoke test (10 min):**
1. Add 3 items, remove 1, update quantity on another → confirm one `kernel_authoritative_decision` per call (or shadow event if not yet enforced earlier)
2. Apply a coupon mid-flow → confirm `BASIS_ONLY` events fire from coupon recomputation, no `DECISION_KIND`
3. Reorder a prior order containing an out-of-stock item → kernel should REFUSE with `availability.out_of_stock`; legacy may surface different code (`BASIS_ONLY` is OK)

## Observation window — 7 days

Watch in PostHog (Stage 2 chart filtered to cart-mutating intents):

| Event | Expected | Action threshold |
|---|---|---|
| `audit_kernel_shadow_diverged_basis` | Higher than Stage 1 (coupon recompute, allergen revalidation) | Investigate if rate >15%/intent |
| `audit_kernel_shadow_diverged_kind` | **Zero** | Any occurrence pages |
| `audit_kernel_shadow_diverged_rewrite` | Rare quantity-cap events possible | Each occurrence: review the REWRITE was a mechanical cap, not business transformation |

### Expected divergence patterns for this stage

- **`cart.update` PAYLOAD_REWRITE — quantity capped:** customer asked for 50; product max is 10. Kernel REWRITEs to 10 with basis `quantity.capped_to_max`. **OK** — this is exactly the safe-mechanical-capping use case for REWRITE. Confirm the cap matches the catalog.
- **`cart.add` BASIS_ONLY — allergen taint:** legacy didn't taint by allergen; kernel returns same EXECUTE but with `allergen.declared` basis. **OK** — vocab upgrade.
- **`cart.reorder` DECISION_KIND — legacy EXECUTE → kernel REFUSE on out-of-stock:** kernel correctly enforces availability where legacy let it through. **NOT OK** as a recurring pattern in shadow — it means legacy is permissive. **Triage: keep in shadow until product team confirms the new behavior is desired UX**, then proceed.

### Pattern that should never occur

- `cart.add` PAYLOAD_REWRITE where kernel substitutes a different product. **Page S1.** This would mean REWRITE has escaped its bounded scope (sanitization/normalization/mechanical-cap only) into business transformation.

## Go/no-go for ENFORCE

All must hold for ≥7 consecutive days:
- Zero `audit_kernel_shadow_diverged_kind` events
- Zero `audit_kernel_shadow_diverged_rewrite` events that are NOT mechanical caps (quantity, allergen flag, unicode normalization)
- Stage 1 still clean (no regression)
- Cart-success-rate baseline preserved

## Enforce flip

```bash
IBX_KERNEL_ENFORCE=preference.update,coupon.apply,review.submit,followup.schedule,order.note.add,cart.add,cart.remove,cart.update,cart.create_or_get,cart.reorder
ibx svc restart api
```

**24h watchlist:**
- Cart-abandonment rate unchanged (PostHog `cart_abandoned`)
- Average cart value within ±5% of prior week
- Zero customer-support tickets mentioning "can't add to cart" or "cart cleared"

**7d watchlist:**
- Tool-call success rate per cart intent unchanged
- Coupon-redemption rate unchanged (Stage 1 + Stage 2 interaction)
- No spike in `refusal.* by reason` for cart intents

**30d watchlist:**
- File post-stage report; proceed to Stage 3

## Rollback

```bash
# Drop Stage 2 from ENFORCE; keep Stage 1
IBX_KERNEL_ENFORCE=preference.update,coupon.apply,review.submit,followup.schedule,order.note.add
ibx svc restart api
```

If rollback is mid-flow for active sessions: a customer who just added to cart under enforce → rollback → next add under legacy is safe; the cart state is in Redis and unaffected by which path adjudicated.

## Escalation

| Severity | Trigger | Page | Channel |
|---|---|---|---|
| S3 | `BASIS_ONLY` rate >15%/intent in shadow | No | Slack `#ibx-rollout` |
| S2 | Quantity-cap REWRITE >0.5% of `cart.update` traffic | Yes | PagerDuty (intent-kernel) — likely a catalog data bug, not kernel |
| S2 | `DECISION_KIND` event in shadow | Yes | PagerDuty |
| S1 | Cart-success-rate drops >5% post-enforce | Yes | PagerDuty + owner WhatsApp; rollback |
| S1 | Non-mechanical PAYLOAD_REWRITE detected | Yes | PagerDuty + intent-kernel maintainer; investigate REWRITE scope |

## Post-stage report template

File at `docs/ops/runbooks/reports/stage-02-<YYYY-MM-DD>.md`. Same structure as Stage 1 plus:
- Quantity-cap REWRITE rate per product (look for outlier products)
- Coupon-recompute basis distribution (will inform Stage 3 expected divergence)
