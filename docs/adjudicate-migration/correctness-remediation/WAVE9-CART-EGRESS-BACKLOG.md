# Wave 9 backlog — LLM-callable cart-store medusa bypasses

**Surfaced by:** W8-V4 (commit `3129a79`) — widened `MEDUSA_SCAN_DIRS` in `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts` to include `packages/tools/src/`.

**Status:** allowlisted in `DEFERRED_MEDUSA_MIGRATIONS` with this doc as the W9 follow-up reference.

**Severity:** P1 (LLM-callable customer-cart STORE-scope mutations bypass kernel adjudication and audit trail). Not Tier 1 or Tier 3 blocker; relevant to broader cart-egress governance posture.

## Inventory (10 sites across 6 files)

| File | Line | Operation | Endpoint |
|---|---|---|---|
| `packages/tools/src/cart/add-to-cart.ts` | 54 | POST | `/store/carts/:id/line-items` |
| `packages/tools/src/cart/apply-coupon.ts` | 14 | POST | `/store/carts/:id/promotions` |
| `packages/tools/src/cart/create-checkout.ts` | 194 | POST | `/store/carts/:id/promotions` |
| `packages/tools/src/cart/create-checkout.ts` | 229 | POST | `/store/carts/:id` (email update) |
| `packages/tools/src/cart/create-checkout.ts` | 250 | POST | `/store/payment-collections` |
| `packages/tools/src/cart/create-checkout.ts` | 291 | POST | `/store/payment-collections/:id/payment-sessions` |
| `packages/tools/src/cart/create-checkout.ts` | 331 | POST | `/store/carts/:id/complete` |
| `packages/tools/src/cart/get-or-create-cart.ts` | 136 | POST | `/store/carts` (create) |
| `packages/tools/src/cart/remove-from-cart.ts` | 14 | DELETE | `/store/carts/:id/line-items/:itemId` |
| `packages/tools/src/cart/update-cart.ts` | 14 | PATCH/POST | `/store/carts/:id/line-items/:itemId` |

## Why these matter

Every LLM-callable tool that mutates state should be adjudicated through the kernel per the IbateXas ADR #9 Intent-Gated Execution v2.0 contract. These 10 cart-store sites:

- Are reachable by the LLM via the intent-bridge in `packages/llm-provider/src/tool-registry.ts`
- Mutate customer cart state (line items, promotions, payment collections, checkout completion)
- Are NOT covered by the existing `medusaAdjudicated` wrapper (which only handles admin-scope `medusa.admin.*` egress)
- Bypass the audit ledger entirely — no `IntentEnvelope` is constructed, no policy bundle runs, no audit record is written

## Why W7/W8 did not close them

The W7 prompt scoped P5 (Stripe-Wrapper) and P6 (fetchAdmin in order.service) to ADMIN-scope medusa egress and direct Stripe SDK usage. Cart-tool STORE-scope medusa egress was implicitly out of scope — the W6 verifier didn't enumerate it because the existing `MEDUSA_SCAN_DIRS` only scanned `apps/`, not `packages/tools/`. W8-V4 was the first scan that covered `packages/tools/src/`, which is why this surfaced now.

## Recommended W9 design

**Build `medusaStoreAdjudicated` wrapper** in `packages/tools/src/medusa/store-adjudicated.ts`:

- Mirror the `packages/tools/src/medusa/adjudicated.ts` pattern (which handles admin-scope)
- New intent kinds (inline policy per D10 precedent, NOT registered in `KNOWN_INTENT_KINDS`):
  - `medusa.store.cart.create`
  - `medusa.store.cart.line_item.add`
  - `medusa.store.cart.line_item.update`
  - `medusa.store.cart.line_item.remove`
  - `medusa.store.cart.email.update`
  - `medusa.store.cart.promotion.add`
  - `medusa.store.cart.complete`
  - `medusa.store.payment_collection.create`
  - `medusa.store.payment_collection.payment_session.create`
- Per-kind policy bundles in `packages/pack-orders/` or a new `packages/pack-cart-store/`
- Default-REFUSE for unknown kinds (per W6-fixed P0-X2 pattern)
- `IBX_MEDUSA_STORE_ALLOWED_KINDS` env override for staged rollout

**Migrate the 10 sites** in one PR per RULE F (orphan wrapper + deferred migrations is the W6 surface-gap pattern).

**Add LLM-flow test coverage** asserting that the LLM cannot reach these mutations except via the wrapper.

## Estimated effort

~3-5 days, single engineer. This is a focused epic, not a "close the audit findings" loop continuation.

## Gating for production

- Not a Tier 1 shadow blocker (cart-store is not in the Tier 1 intent set)
- Not a Tier 3 shadow blocker (cart-store is not in the Tier 3 financial intent set)
- Should be done BEFORE Tier 4 enforce on any cart-related LGPD-anonymize work that depends on cart-state integrity
- Recommended sequencing: V3 hoist completion (~30 min) → Tier 4 YELLOW → cart-egress epic → Tier 4 GREEN

## Provenance

- Surfaced by: W8-V4 scan widening (commit `3129a79`)
- Allowlist: `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts` `DEFERRED_MEDUSA_MIGRATIONS` (sentinel size baseline updated 0 → 6)
- W7 synthesis cross-reference: `docs/adjudicate-migration/correctness-remediation/W7-SYNTHESIS.md` §"Wave 8 addendum"
- W7 verifier report cross-reference: `docs/adjudicate-migration/correctness-remediation/wave7-verifier-report.md` §"NEW-W7-V4 details"
