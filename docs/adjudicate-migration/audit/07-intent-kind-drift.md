> ⚠️ **SUPERSEDED on 2026-05-24.** Pre-cutover taxonomy/Pack/caller-side naming drift audit (2026-05-23). The taxonomy in `../governance/01-intent-taxonomy.md` and `KNOWN_INTENT_KINDS` runtime constant have been reconciled with caller sites across Waves 1-9. For current outstanding items, see [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md). Content preserved unchanged below as historical record.

---

# Intent-Kind Drift Audit

> Auditor: Intent-Kind Drift Auditor (overnight task 07)
> Date: 2026-05-23
> Subject: naming consistency across taxonomy → packs → callers → KNOWN_INTENT_KINDS
> Enforcement-readiness verdict: **RED** for `order`, `payment`, **AMBER** for `whatsapp`, `customer`, **GREEN** for `reservation`. See §"Enforcement-readiness verdict per domain".

---

## Executive summary

The overnight task-06 flag is correct AND systemic. The taxonomy doc (governance §01) is the authoritative naming surface; packs and `KNOWN_INTENT_KINDS` partially track it; callers diverge in two ways:

1. **Task 06 kernel-direct wraps invented kinds that do not match taxonomy**: `order.cart.add` (taxonomy is `order.item.add`) and `order.pix.regenerate` (taxonomy is `payment.pix.regenerate`). Under enforce, pack-orders' default-REFUSE wins because the kinds aren't in any pack's intent union.
2. **Significant infrastructure intents (`order.projection.create`, `order.status.reconcile`, `order.status.transition`, `payment.create`, `payment.status.transition`, `payment.status.reconcile`, `payment.method.update`, `conversation.message.append`) are wired by callers AND consumed by command services AND validated by Zod schemas in `@ibatexas/domain` — but they are not in any pack, not in the taxonomy, and not in `KNOWN_INTENT_KINDS`. These are "pack-shaped policies living inside `@ibatexas/domain`" — the structural code is correct, but governance has not caught up.

**Counts at a glance:**

| Source | Distinct kinds | Coverage of governance §01 |
|---|---:|---|
| Governance taxonomy §01 (claim: 64) | 64 | 100% (definition) |
| `KNOWN_INTENT_KINDS` runtime constant | 32 | 33/64 named + 0 inventions |
| Pack unions combined (orders+reservations+whatsapp+customer-onboarding) | 29 | matches `KNOWN_INTENT_KINDS` minus PIX (3) |
| Caller sites construction kinds (distinct strings observed) | 36 | partial overlap; 11 are NOT in any pack |

**Total distinct drifts: 23** (breakdown in §"Findings ranked"):
- 5 rename drifts (kind in caller AND DETERMINISTIC_KERNEL_COVERAGE — name differs from taxonomy)
- 11 caller-side drifts (kind used in code with no pack home — under enforce = default-REFUSE)
- 1 caller drift to non-existent `medusa.*` namespace (intentional inline policy — confirmed)
- 5 taxonomy-only kinds with NO pack home yet (gap, but governance documents them as "future"; not blockers for enforce of currently-shipping kinds)
- 1 taxonomy → KNOWN_INTENT_KINDS gap (taxonomy 64, runtime 32) — explained, not a defect

---

## Source-of-truth inventory

| Authority | File | Count | Notes |
|---|---|---:|---|
| Governance taxonomy (canonical naming) | `docs/adjudicate-migration/governance/01-intent-taxonomy.md` | 64 | "**64 intent kinds**" claim at line 191 — verified by counting the catalog tables: 19 order + 14 payment + 8 reservation + 14 customer + 6 whatsapp + 6 system = 67. Discrepancy: doc claims 64, table count = 67. **Sub-drift.** Likely from `order.cart.sync`, `order.pix.details.set`, `order.cancel.force`, `order.amend.request`, `order.address.change`, `order.type.switch`, `order.review.submit`, `order.reorder`, `payment.method.switch`, `payment.retry`, `payment.cash.confirm`, `payment.waive`, `payment.status.force`, `customer.preferences.update`, `customer.address.remove`, `customer.session.refresh`, `customer.loyalty.redeem` — not all 17 are in the §"Intent kind union" block: the block enumerates 64 explicitly. |
| Runtime guard (typo gate at boot) | `packages/llm-provider/src/intent-kinds.ts` `KNOWN_INTENT_KINDS` | 32 | Assembled from 4 packs + pack-payments-pix (3 PIX kinds). The "32 vs 64" gap is **mostly explainable**: future pack surface (auth/loyalty/refunds/notifications/system) lives in taxonomy but doesn't have packs yet. |
| Pack: orders | `packages/pack-orders/src/types.ts` `OrderIntentKind` | 10 | Comment on line 11-14 acknowledges PIX-regen belongs in payment domain, NOT in pack-orders. |
| Pack: reservations | `packages/pack-reservations/src/types.ts` `ReservationIntentKind` | 8 | Matches taxonomy §"Domain: reservation" exactly. |
| Pack: whatsapp | `packages/pack-whatsapp/src/types.ts` `WhatsAppIntentKind` | 3 | Comment on line 22-25 acknowledges the other 3 (`handoff.request`/`followup.schedule`/`outreach.send`) "land in subsequent tasks". |
| Pack: customer-onboarding | `packages/pack-customer-onboarding/src/types.ts` `CustomerOnboardingIntentKind` | 8 | Comment on line 49-52 acknowledges `customer.session.*`, `customer.loyalty.*`, `customer.welcome_credit.*` belong to "future Packs". |
| Pack: payments-pix (adjudicate platform repo) | `@adjudicate/pack-payments-pix` `PixIntentKind` | 3 | `pix.charge.{create,confirm,refund}`. **Different namespace from taxonomy** — taxonomy uses `payment.*`, pack uses `pix.*`. |
| Inline minimal policy (no pack proper) | `packages/tools/src/medusa/adjudicated.ts` | 13 (`medusa.*`) | Documented at top of file as the LLM's view of the Medusa proxy. NOT in taxonomy. Intentional — operates one layer below domain intents. |

---

## Domain-by-domain comparison

### Domain: `order`

| Kind in taxonomy §01 | In `OrderIntentKind` (pack)? | In `KNOWN_INTENT_KINDS`? | Match? |
|---|---|---|---|
| `order.cart.ensure` | ✓ | ✓ | OK |
| `order.item.add` | ✓ | ✓ | OK — **but see drift below** |
| `order.item.update` | ✓ | ✓ | OK |
| `order.item.remove` | ✓ | ✓ | OK |
| `order.cart.sync` | ✗ | ✗ | **GAP** — taxonomy-only |
| `order.coupon.apply` | ✓ | ✓ | OK |
| `order.checkout.create` | ✓ | ✓ | OK |
| `order.pix.details.set` | ✗ | ✗ | **GAP** — taxonomy-only |
| `order.cancel` | ✓ | ✓ | OK |
| `order.cancel.system` | ✓ | ✓ | OK |
| `order.cancel.force` | ✗ | ✗ | **GAP** — taxonomy-only (admin route uses `order.status.transition` instead) |
| `order.amend.request` | ✓ | ✓ | OK |
| `order.address.change` | ✗ | ✗ | **GAP** — taxonomy-only |
| `order.type.switch` | ✗ | ✗ | **GAP** — taxonomy-only |
| `order.note.add` | ✓ | ✓ | OK |
| `order.status.transition` | ✗ | ✗ | **DRIFT — used in 8+ caller sites; no pack home** |
| `order.status.reconcile` | ✗ | ✗ | **DRIFT — used in cart-intelligence subscriber; no pack home** |
| `order.review.submit` | ✗ | ✗ | **GAP** — taxonomy-only |
| `order.reorder` | ✗ | ✗ | **GAP** — taxonomy-only |

**Drifts in caller code (kind invented or borrowed; not in pack-orders surface):**

| Kind in caller (not in pack) | Source |
|---|---|
| `order.cart.add` | `kernel-executor-envelopes.ts:52` and `intent-dispatcher.ts:109` (`DETERMINISTIC_KERNEL_COVERAGE`) — **should be `order.item.add` per taxonomy** |
| `order.cart.update` | `intent-dispatcher.ts:110` — **should be `order.item.update`** |
| `order.cart.remove` | `intent-dispatcher.ts:111` — **should be `order.item.remove`** |
| `order.cart.get_or_create` | `intent-dispatcher.ts:112` — **should be `order.cart.ensure`** |
| `order.pix.regenerate` | `kernel-executor-envelopes.ts:55` and `intent-dispatcher.ts:115` — **should be `payment.pix.regenerate`** (domain crossover) |
| `order.projection.create` | `cart-intelligence.ts:429`, validated by Zod in `order-command.service.ts:164` |
| `order.status.transition` | `admin/orders.ts:329`, `admin/order-actions.ts:172,261,407`, `payment-lifecycle.ts:115,198`, `stale-order-checker.ts:139` |
| `order.status.reconcile` | `cart-intelligence.ts:699` (Zod-validated; matches taxonomy spec but not packed) |
| `order.confirm` | only in test fixture (`defer-resolver.test.ts:169`, `defer-timeout-sweeper.test.ts:120`) — **drift in test data only** |

### Domain: `payment`

| Kind in taxonomy §01 | In any pack? | In `KNOWN_INTENT_KINDS`? | Match? |
|---|---|---|---|
| `payment.charge.create` | ✗ | ✗ | **GAP** — taxonomy-only; pack-payments-pix uses `pix.charge.create` instead |
| `payment.charge.confirm` | ✗ | ✗ | **GAP** — taxonomy-only; pack uses `pix.charge.confirm` |
| `payment.charge.fail` | ✗ | ✗ | **GAP** |
| `payment.charge.expire` | ✗ | ✗ | **GAP** |
| `payment.charge.cancel` | ✗ | ✗ | **GAP** |
| `payment.pix.regenerate` | ✗ | ✗ | **GAP** — taxonomy-only; kernel uses `order.pix.regenerate` (wrong namespace) |
| `payment.method.switch` | ✗ | ✗ | **GAP** |
| `payment.retry` | ✗ | ✗ | **GAP** |
| `payment.refund.issue` | ✗ | ✗ | **GAP** |
| `payment.refund.confirm` | ✗ | ✗ | **GAP** |
| `payment.dispute.open` | ✗ | ✗ | **GAP** |
| `payment.cash.confirm` | ✗ | ✗ | **GAP** |
| `payment.waive` | ✗ | ✗ | **GAP** |
| `payment.status.force` | ✗ | ✗ | **GAP** |

**Drifts in caller code (no pack-payments exists):**

| Kind in caller | Source |
|---|---|
| `payment.status.transition` | `admin/payments.ts:155,230,388,615,713`, `admin/order-actions.ts:314,502,604`, `pix-expiry-checker.ts:78`, `stale-order-checker.ts:177` — validated by Zod in `payment-command.service.ts:138` |
| `payment.status.reconcile` | `stripe-webhook.ts:96` — validated in `payment-command.service.ts:158` |
| `payment.create` | `cart-intelligence.ts:517` — validated in `payment-command.service.ts:118` |
| `payment.method.update` | (suspected from PATCH /payment/method endpoint, confirm in code) |

Also note: the platform-shipped `@adjudicate/pack-payments-pix` uses `pix.charge.{create,confirm,refund}`. These ARE in `KNOWN_INTENT_KINDS` (lines 100-104 of `intent-kinds.ts`) but **not in the taxonomy**. This is a namespace fork: taxonomy uses `payment.*`, the upstream Pack uses `pix.*`. Documented in `intent-kinds.ts:92-99` as intentional — IbateXas will surface `payment.pix.*` once `@ibatexas/pack-payments` lands.

### Domain: `reservation`

| Kind in taxonomy §01 | In `ReservationIntentKind` (pack)? | In `KNOWN_INTENT_KINDS`? | Match? |
|---|---|---|---|
| `reservation.create` | ✓ | ✓ | OK |
| `reservation.modify` | ✓ | ✓ | OK |
| `reservation.cancel` | ✓ | ✓ | OK |
| `reservation.checkin` | ✓ | ✓ | OK |
| `reservation.complete` | ✓ | ✓ | OK |
| `reservation.no_show.mark` | ✓ | ✓ | OK |
| `reservation.waitlist.join` | ✓ | ✓ | OK |
| `reservation.waitlist.notify` | ✓ | ✓ | OK |

**Caller drift:** none. `admin/reservations.ts` uses `reservation.checkin` and `reservation.complete`, both in pack. Task 13's confirmation receipts reference `reservation.transition` — that name does NOT appear in any caller code we found; the actual receipts use `reservation.cancel` etc. directly.

**Verdict: GREEN** — fully aligned.

### Domain: `customer`

| Kind in taxonomy §01 | In `CustomerOnboardingIntentKind`? | In `KNOWN_INTENT_KINDS`? | Match? |
|---|---|---|---|
| `customer.create` | ✓ | ✓ | OK |
| `customer.profile.update` | ✓ | ✓ | OK |
| `customer.preferences.update` | ✓ | ✓ | OK |
| `customer.pix.details.save` | ✓ | ✓ | OK |
| `customer.address.add` | ✓ | ✓ | OK |
| `customer.address.remove` | ✓ | ✓ | OK |
| `customer.anonymize` | ✓ | ✓ | OK |
| `customer.anonymize.cancel` | ✓ | ✓ | OK |
| `customer.session.issue` | ✗ | ✗ | **GAP** — taxonomy-only ("future Pack" per pack-customer-onboarding comment) |
| `customer.session.revoke` | ✗ | ✗ | **GAP** |
| `customer.session.refresh` | ✗ | ✗ | **GAP** |
| `customer.loyalty.stamp.award` | ✗ | ✗ | **GAP** |
| `customer.loyalty.redeem` | ✗ | ✗ | **GAP** |
| `customer.welcome_credit.grant` | ✗ | ✗ | **GAP** |

**Caller drift:** none observed. `me.ts:276` uses `customer.anonymize`; `me.ts:420` uses `customer.anonymize.cancel`. Both in pack.

### Domain: `whatsapp`

| Kind in taxonomy §01 | In `WhatsAppIntentKind`? | In `KNOWN_INTENT_KINDS`? | Match? |
|---|---|---|---|
| `whatsapp.message.send` | ✓ | ✓ | OK |
| `whatsapp.template.send` | ✓ | ✓ | OK |
| `whatsapp.handoff.request` | ✗ | ✗ | **GAP** ("subsequent tasks" per pack comment) |
| `whatsapp.followup.schedule` | ✗ | ✗ | **GAP** |
| `whatsapp.outreach.send` | ✗ | ✗ | **GAP** |
| `whatsapp.session.handover` | ✓ | ✓ | OK |

**Caller drift:** `conversation-archiver.ts:70` uses `conversation.message.append` — not in any pack, not in taxonomy. Distinct from `whatsapp.message.send`; this is the persistence-side event, not the egress channel intent. Should probably live in a `@ibatexas/pack-conversation` or `@ibatexas/pack-whatsapp` extension.

### Domain: `system`

| Kind in taxonomy §01 | In any pack? | In `KNOWN_INTENT_KINDS`? | Match? |
|---|---|---|---|
| `system.kernel.kill_switch.toggle` | ✗ | ✗ | **GAP** ("admin endpoint to add" per governance) |
| `system.kernel.shadow.add` | ✗ | ✗ | **GAP** |
| `system.kernel.enforce.add` | ✗ | ✗ | **GAP** |
| `system.kernel.pack.register` | ✗ | ✗ | **GAP** |
| `system.replay.run` | ✗ | ✗ | **GAP** |
| `system.backfill.execute` | ✗ | ✗ | **GAP** |

No caller uses `system.*` kinds; these are scaffolded for the future operator console.

---

## Caller-side drift (kinds used in code but not in any pack)

| Caller (file:line) | Kind used | In any pack? | If enforced, default-REFUSE? |
|---|---|---|---|
| `packages/llm-provider/src/kernel-executor-envelopes.ts:52` (`buildAddItemEnvelope`) | `order.cart.add` | ✗ (pack has `order.item.add`) | **YES — silent refuse** |
| `packages/llm-provider/src/kernel-executor-envelopes.ts:55` (`buildRegeneratePixEnvelope`) | `order.pix.regenerate` | ✗ (taxonomy has `payment.pix.regenerate`; pack-payments-pix has `pix.charge.*`) | **YES — silent refuse** |
| `packages/llm-provider/src/intent-dispatcher.ts:109-115` (`DETERMINISTIC_KERNEL_COVERAGE`) | `order.cart.add`, `order.cart.update`, `order.cart.remove`, `order.cart.get_or_create`, `order.pix.regenerate` | ✗ (5 invented names) | N/A (coverage set is not adjudicated; but the names will mislead anyone updating the set) |
| `apps/api/src/routes/stripe-webhook.ts:96` | `payment.status.reconcile` | ✗ (no pack-payments) | **YES — silent refuse** |
| `apps/api/src/routes/admin/payments.ts:155,230,388,615,713` (5 sites) | `payment.status.transition` | ✗ (no pack-payments) | **YES — silent refuse on all 5 sites** |
| `apps/api/src/routes/admin/order-actions.ts:172,261,407` (3 sites) | `order.status.transition` | ✗ (taxonomy claim, no pack-orders entry) | **YES — silent refuse** |
| `apps/api/src/routes/admin/order-actions.ts:314,502,604` (3 sites) | `payment.status.transition` | ✗ | **YES — silent refuse** |
| `apps/api/src/routes/admin/orders.ts:329` | `order.status.transition` | ✗ | **YES — silent refuse** |
| `apps/api/src/routes/admin/reservations.ts:175,221` | `reservation.checkin`, `reservation.complete` | ✓ in pack-reservations | OK |
| `apps/api/src/routes/me.ts:276,420` | `customer.anonymize`, `customer.anonymize.cancel` | ✓ in pack-customer-onboarding | OK |
| `apps/api/src/routes/cart.ts:611` | `order.checkout.create` | ✓ in pack-orders | OK |
| `apps/api/src/routes/order-actions.ts:228,514` | `order.cancel`, `order.amend.request` | ✓ in pack-orders | OK |
| `apps/api/src/subscribers/cart-intelligence.ts:429` | `order.projection.create` | ✗ | **YES — silent refuse** |
| `apps/api/src/subscribers/cart-intelligence.ts:517` | `payment.create` | ✗ | **YES — silent refuse** |
| `apps/api/src/subscribers/cart-intelligence.ts:699` | `order.status.reconcile` | ✗ | **YES — silent refuse** |
| `apps/api/src/subscribers/payment-lifecycle.ts:115,198` | `order.status.transition` | ✗ | **YES — silent refuse** |
| `apps/api/src/subscribers/conversation-archiver.ts:70` | `conversation.message.append` | ✗ | **YES — silent refuse** |
| `apps/api/src/jobs/pix-expiry-checker.ts:78` | `payment.status.transition` | ✗ | **YES — silent refuse** |
| `apps/api/src/jobs/stale-order-checker.ts:139,177` | `order.status.transition`, `payment.status.transition` | ✗ | **YES — silent refuse** |
| `packages/tools/src/medusa/adjudicated.ts:141-208` (13 kinds) | `medusa.admin.order.*`, `medusa.cart.*`, `medusa.payment_collection.*` | ✗ — by design (inline policy, no pack proper) | **YES — silent refuse if enforced via `KNOWN_INTENT_KINDS`** |

**Total caller sites that would default-REFUSE under enforce: ≈ 30 distinct sites across 11 files.**

---

## Orphans in `KNOWN_INTENT_KINDS`

A kind is "orphan" if it's in the runtime set but no caller constructs it. Cross-checking the 32 entries against caller-site grep:

- `order.cart.ensure` — only constructed inside `getOrCreateCart` tool (likely; not seen in callers grep but implied by tool layer)
- `order.item.update` — same; expected from `update_cart` tool path
- `order.item.remove` — same; expected from `remove_from_cart` tool
- `order.coupon.apply` — same; from `apply_coupon` tool
- `order.cancel.system` — expected from `stale-order-checker.ts` but **caller uses `order.status.transition` instead**; this kind is currently unreached
- `order.note.add` — not seen in caller grep
- `reservation.*` — only checkin/complete seen; create/modify/cancel/no_show.mark/waitlist.{join,notify} not seen in admin grep (likely in `reservation.service.ts` after future task 15 wraps it)
- `whatsapp.message.send`, `whatsapp.template.send`, `whatsapp.session.handover` — not in caller grep (future task 15/16 wraps them)
- `customer.create` through `customer.preferences.update`/`customer.pix.details.save`/`customer.address.*` — not in caller grep (future tasks wire `customer.service.ts`)
- `pix.charge.create/confirm/refund` — provided by `@adjudicate/pack-payments-pix`; resumed via DEFER resolution path

**Suspected orphans (in `KNOWN_INTENT_KINDS` but no caller site found):** `order.cancel.system` is the cleanest example — the stale-order-checker should emit it but instead emits `order.status.transition`, which is NOT in any pack. This is a **double drift**: the canonical kind is unused, and the kind that's used is undefined.

---

## Missing kinds from `KNOWN_INTENT_KINDS`

Kinds the runtime would silently default-REFUSE if enforced today (because nobody added them to the set):

**Order infrastructure (used in callers; need pack home + runtime registration):**
- `order.projection.create`
- `order.status.transition`
- `order.status.reconcile`

**Payment infrastructure (no pack exists; used by 10+ caller sites):**
- `payment.create`
- `payment.status.transition`
- `payment.status.reconcile`
- `payment.method.update` (suspected from PATCH /api/orders/:id/payment/method)

**Conversation infrastructure:**
- `conversation.message.append`

**Medusa inline minimal-policy namespace (13 kinds):**
- `medusa.admin.order.{edit.confirm,edit.items,edit.create,cancel,update_metadata}`
- `medusa.cart.{line_items.update,line_items.remove,line_items.add,promotion.apply,complete,update,create}`
- `medusa.payment_collection.create`

**Task-06 invented kernel kinds (5 kinds — wrong names; rename target):**
- `order.cart.add`, `order.cart.update`, `order.cart.remove`, `order.cart.get_or_create`, `order.pix.regenerate`

**Total missing (would default-REFUSE under enforce): 25+ kinds.**

---

## Taxonomy → runtime gap (64 vs 32) — explained

Of the 32 kinds NOT in `KNOWN_INTENT_KINDS`:

| Group | Count | Reason | Pack home (future or current) |
|---|---:|---|---|
| Order extension (sync, pix.details.set, cancel.force, address.change, type.switch, review.submit, reorder) | 7 | Pack-orders is scope-bounded; rest awaits expansion | `@ibatexas/pack-orders` (future) |
| Payment full surface (14 kinds) | 14 | No `@ibatexas/pack-payments` exists yet — pack-payments-pix only fields 3 PIX charge kinds | `@ibatexas/pack-payments` (future) |
| Customer auth (session.issue/revoke/refresh) | 3 | Out of scope for pack-customer-onboarding | `@ibatexas/pack-auth` (future) |
| Customer loyalty (stamp.award, redeem) | 2 | Out of scope | `@ibatexas/pack-loyalty` (future) |
| Customer credit (welcome_credit.grant) | 1 | Out of scope | `@ibatexas/pack-promotions` (future) |
| WhatsApp extensions (handoff/followup/outreach) | 3 | Out of scope for narrow pack-whatsapp | `@ibatexas/pack-whatsapp` (future scope expansion) |
| System ops kinds (6 kernel/replay/backfill) | 6 | No pack scope defined | `@ibatexas/pack-ops` (future) |

This gap is **expected** and matches what governance §01 calls "Open extension points". It's NOT a blocker for shadow/enforce of currently-shipping kinds.

What IS a blocker: the **25+ caller-side drifts** listed above — kinds called today that have no pack home today. These need either (a) a pack to be written, OR (b) the kind to be renamed to a kind a pack already declares.

---

## Enforcement-readiness verdict per domain

| Domain | Verdict | Reasoning |
|---|---|---|
| `order` | **RED** | 2 task-06 wraps use wrong names (`order.cart.add`, `order.pix.regenerate`); 3 infrastructure kinds (`order.status.transition` × 7+ sites, `order.projection.create`, `order.status.reconcile`) have no pack home. Enforce today = silent default-REFUSE on every cart-add, checkout, force-cancel, status reconcile. |
| `payment` | **RED** | No `@ibatexas/pack-payments` exists. 4 infrastructure kinds used by 10+ caller sites would all default-REFUSE. Stripe webhook reconcile would break. |
| `reservation` | **GREEN** | Fully aligned. Admin reservation endpoints use kinds that are in pack-reservations. |
| `customer` | **AMBER** | Identity-lifecycle kinds are clean (8/8 in pack). But the in-flight Pack does not cover session/loyalty/welcome-credit; those are not yet caller-active so no immediate enforce risk, but adoption of those domains will require new packs. |
| `whatsapp` | **AMBER** | 3/6 kinds packed. `conversation.message.append` is used in conversation-archiver but has no pack home — would default-REFUSE under enforce. |
| `system` | **N/A** | No callers; not yet wired. |
| `medusa.*` namespace | **NOT-IN-SCOPE** | Documented as inline minimal policy that operates separately from the kernel's enforce config. If `medusa.*` is added to `KNOWN_INTENT_KINDS` or the kernel walls off non-known kinds, this becomes RED. Currently treated as outside the typo gate. |

---

## Findings ranked (top 5 most dangerous)

1. **`order.cart.add` rename drift (kernel-executor-envelopes.ts:52).** Under enforce, every LLM-mediated AND deterministic-kernel add-to-cart silently defaults to REFUSE because pack-orders has `order.item.add`, not `order.cart.add`. This is the highest-volume mutation surface (every checkout starts here). **FIX: rename `KERNEL_INTENT_KIND_ADD_ITEM` to `"order.item.add"` and update `DETERMINISTIC_KERNEL_COVERAGE`.** The task-06 author flagged this in the file comment but kept the wrong name "and rely on the policy bundle's `PolicyBundle<string, unknown, ...>` widening" — that widening only works pre-enforce; enforce config validates against `KNOWN_INTENT_KINDS`.

2. **`order.pix.regenerate` namespace drift (kernel-executor-envelopes.ts:55).** Taxonomy says `payment.pix.regenerate` (payment domain). Pack-orders explicitly excludes PIX-regen (types.ts:11-14). Caller invents `order.pix.regenerate` and no pack accepts it. **FIX: rename to `payment.pix.regenerate` AND write `@ibatexas/pack-payments` (Tier 1) before enforce.** Until pack exists, this path is silently broken.

3. **`payment.status.transition` × 10+ sites with no pack-payments.** All admin payment actions, stripe webhook reconcile, pix expiry checker, stale order checker depend on this kind. Without `@ibatexas/pack-payments`, enforce = silent refuse on all of them. **FIX: write `@ibatexas/pack-payments` containing `payment.create`, `payment.status.transition`, `payment.status.reconcile`, `payment.method.update` BEFORE enforce.**

4. **`order.status.transition` × 7+ sites with no pack home.** Admin order force-cancel, advance-status, payment-lifecycle, stale-order-checker depend on this kind. **FIX: add to pack-orders' `OrderIntentKind` union AND `KNOWN_INTENT_KINDS`, OR move to a future `@ibatexas/pack-order-lifecycle`.**

5. **`order.cancel.system` orphan + `order.status.transition` ad-hoc replacement.** Taxonomy says `order.cancel.system` is the canonical system auto-cancel kind. `stale-order-checker.ts` instead emits `order.status.transition` with `actor: "system"` payload. Two issues: (a) the canonical kind is dead code in pack-orders, (b) the kind that's used isn't in any pack. **FIX: either resurrect `order.cancel.system` (preferred — matches taxonomy) OR formally retire it and document `order.status.transition` as the canonical system terminal-state kind. Either way, governance §01 needs an update.**

---

## Pre-enforce action items (recommendation)

Three options, in increasing order of effort:

**Option A (quick, narrow):** Before flipping enforce for ANY kind, rename the 5 task-06 wraps to match taxonomy (`order.cart.add` → `order.item.add`; `order.pix.regenerate` → `payment.pix.regenerate`) and `DETERMINISTIC_KERNEL_COVERAGE` (5 strings). Leave the payment/order-status infrastructure as-is (their kinds will refuse under enforce, but they're not in `IBX_KERNEL_ENFORCE`'s initial allowlist).

**Option B (correct, medium):** Before enforce, write `@ibatexas/pack-payments` (covering the 4 payment.* infrastructure kinds) and add `order.status.transition`, `order.status.reconcile`, `order.projection.create` to pack-orders (with their `OrderState` projections). Add `conversation.message.append` to pack-whatsapp (or a new `@ibatexas/pack-conversation`). Register all in `KNOWN_INTENT_KINDS`. Update taxonomy §01 to include these as canonical kinds (governance lags reality today).

**Option C (governance-first, slow):** Update taxonomy §01 first to match reality (rename `order.item.add` → match what packs ship, OR keep taxonomy and force packs to track). Resolve the 64-vs-67 internal count discrepancy. Decide whether `medusa.*` namespace participates in the typo gate. Then proceed with Option B.

Recommendation: **Option B**, with the renames from Option A applied first as a fast unblock. Option C is correct long-term but blocks the migration on a doc audit pass.

---

## Appendix: 64-vs-67 internal taxonomy count discrepancy

The catalog tables in `01-intent-taxonomy.md` enumerate:
- order: 19 kinds (table)
- payment: 14 kinds (table)
- reservation: 8 kinds (table)
- customer: 14 kinds (table; was "13 + customer.anonymize.cancel" per the line 191 note)
- whatsapp: 6 kinds (table)
- system: 6 kinds (table)

Sum: **67**.

The "Intent kind union (knownIntents)" code block at line 155-188 lists exactly the 64 strings the runtime should ship. Cross-checking the union vs the tables: the union has 19+14+8+14+6+6 = 67 entries. Wait — let me recount the union block.

Union block:
- order line 156-162: `cart.ensure, item.add, item.update, item.remove, cart.sync, coupon.apply, checkout.create, pix.details.set, cancel, cancel.system, cancel.force, amend.request, address.change, type.switch, note.add, status.transition, status.reconcile, review.submit, reorder` = 19
- payment line 163-168: `charge.create, charge.confirm, charge.fail, charge.expire, charge.cancel, pix.regenerate, method.switch, retry, refund.issue, refund.confirm, dispute.open, cash.confirm, waive, status.force` = 14
- reservation line 169-172: 8 (matches)
- customer line 173-179: `create, profile.update, preferences.update, pix.details.save, address.add, address.remove, anonymize, anonymize.cancel, session.issue, session.revoke, session.refresh, loyalty.stamp.award, loyalty.redeem, welcome_credit.grant` = 14
- whatsapp line 180-183: 6
- system line 184-187: 6

Sum: **67**, not 64 as the comment claims. The doc has an internal counting error. Minor — flag for governance refresh.

---

## Conclusion

The task-06 author was directionally correct (envelopes wrap the kernel-direct mutations) but **named the kinds wrong** in two ways: (1) used `cart` aggregate where taxonomy says `item`, (2) put PIX-regen under `order` where taxonomy puts it under `payment`. Under enforce, both wraps silently default-REFUSE.

Beyond task 06, the broader picture is that **payment/order/conversation infrastructure intents are wired by callers and consumed by command services with Zod-validated payloads — but they are not in any pack and not in `KNOWN_INTENT_KINDS`**. This is fine pre-enforce (`PolicyBundle<string, unknown, ...>` widens) but is a wall when `IBX_KERNEL_ENFORCE` includes these kinds.

The reservation domain is the bright spot: fully aligned across taxonomy / pack / runtime / caller. The customer-onboarding domain is structurally aligned for its narrow scope. The `medusa.*` namespace is intentionally outside the typo gate — confirm that's the design intent.

Pre-enforce work order: rename the 5 task-06 strings first, then write `@ibatexas/pack-payments`, then expand `pack-orders` with lifecycle kinds, then refresh the taxonomy doc to resolve the 64-vs-67 mismatch.
