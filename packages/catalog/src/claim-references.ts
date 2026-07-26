// The CLAIM-REFERENCE VOCABULARY — the claim name spaces a capability
// definition is allowed to point at (LE2 Implementation Decision 13).
//
// # What this is, and just as importantly what it is NOT
//
// This module holds NAMES, never behavior. The RUNTIME claim machinery stays
// exactly where it is and keeps every ounce of authority it has today:
//
//   - `SUCCESS_CLAIM_CLASSES` (`apps/api/src/claustrum/ibatexas-responder.ts`)
//     owns the regexes, the `justifiedBy` arrays, the negation windows, the
//     noun guards — the anti-confabulation guard itself.
//   - `CLAIM_REGISTRY` / `REGISTRY_SPECS` (`apps/api/src/claustrum/
//     claim-registry.ts`) owns the constrained-generation enum and the per-type
//     evidence schemas the planner parameterizes.
//
// Neither moved, and nothing here can change what either does. The catalog
// needs the NAME SPACES (and only the name spaces) for one reason: the
// cross-reference check (`build-gates/check-claim-references.ts`) must be able
// to prove, AT PACKAGE BUILD TIME, that no capability definition points at a
// claim that does not exist. `packages/*` cannot import `apps/api` (the
// dependency arrow only ever runs adjudicate -> claustrum -> ibatexas, and
// packages are strictly upstream of apps), so the check cannot read the live
// runtime arrays. It reads these mirrors instead.
//
// # Why a mirror is safe here
//
// A mirror can drift; an unguarded mirror is a lie waiting to happen. Both
// arrays below are PINNED set-equal to their runtime originals by
// `apps/api/src/claustrum/__tests__/catalog-claim-references.test.ts` — a test
// that CAN see both sides, and asserts in BOTH directions (nothing here that
// the runtime lacks, nothing in the runtime that is missing here).
//
// A related, PRE-EXISTING pin also survives unchanged:
// `apps/api/src/claustrum/__tests__/capability-definitions.success-claim-
// round-trip.test.ts` already asserted that no capability links to an id
// `SUCCESS_CLAIM_CLASSES` does not define. The catalog's build gate is the
// build-time restatement of exactly that invariant, moved to where the data
// lives so it fails earlier and without an apps/api test run.
//
// Adding a claim class or a registry type without updating this file fails
// those tests loudly — that is the intended, cheap coupling.
//
// Ordering in both arrays is SOURCE ORDER of the runtime original, so a diff
// against the original stays readable. Order carries no contract; every
// consumer treats these as sets.

/**
 * The `SUCCESS_CLAIM_CLASSES` ids (`apps/api/src/claustrum/
 * ibatexas-responder.ts`) — the vocabulary a `CapabilityDefinition`'s
 * `successClaimLinks` must resolve against. 19 classes: the 11 SDD §K seed +
 * the 8 BKL-194 sweep additions.
 *
 * `fulfillment-claimed` is present and MUST stay present: it is the
 * permanently-unearnable class (`justifiedBy: []` in the responder — CLAUDE.md
 * "the anti-confabulation mirror"). Its presence in this vocabulary is not an
 * invitation to link to it; it is here because the vocabulary describes what
 * the responder DEFINES, and the responder defines it precisely so that any
 * fulfillment prose can be clamped. No capability links to it, and the
 * round-trip test asserts the generator agrees.
 */
export const CLAIM_CLASS_REFERENCES = [
  "order-placed",
  "purchase-completed",
  "payment-settled",
  "order-canceled",
  "cart-item-added",
  "refund-done",
  "note-added",
  "order-amended",
  "reservation-confirmed",
  "pix-generated",
  "fulfillment-claimed",
  // ── BKL-194 sweep additions (the taxonomy outgrew the original 11) ──
  "review-received",
  "reservation-canceled",
  "coupon-applied",
  "address-updated",
  "preferences-saved",
  "payment-method-switched",
  "fiscal-emitted",
  "data-anonymized",
] as const

/** A claim-class id a capability definition may reference. */
export type ClaimClassReference = (typeof CLAIM_CLASS_REFERENCES)[number]

const CLAIM_CLASS_SET: ReadonlySet<string> = new Set<string>(CLAIM_CLASS_REFERENCES)

/** Does `value` name a claim class the responder defines? Pure. */
export function isClaimClassReference(value: unknown): value is ClaimClassReference {
  return typeof value === "string" && CLAIM_CLASS_SET.has(value)
}

/**
 * The runtime `CLAIM_REGISTRY` type names (`apps/api/src/claustrum/
 * claim-registry.ts`) — the closed enum the claim-aware planner
 * SELECTS-and-PARAMETERIZES from (SDD §H/§P3; it never free-generates a type).
 * 17 types.
 *
 * This is the claim-TYPE name space, distinct from
 * {@link CLAIM_CLASS_REFERENCES}'s lowercase guard ids — SDD §K's "map, do not
 * equate". No `CapabilityDefinition` field references this name space TODAY
 * (`successClaimLinks` points at the guard ids); it is exposed here because it
 * is the other half of "claim-registry references" the catalog is the root of,
 * and because the claims-expansion workstream adds capability-side references
 * into it. The cross-reference checker already accepts a resolver for it, so
 * that expansion is a data change, not a gate change.
 *
 * NOT the full 37-row / 40-type-name design vocabulary (CLAUDE.md) — that is
 * the design set's registry. This mirrors what the RUNTIME actually admits
 * today, which is the only thing a dangling-reference check can honestly
 * verify against.
 */
export const REGISTRY_CLAIM_TYPE_REFERENCES = [
  "MENU_ITEM_ALLERGENS",
  "STORE_HOURS",
  "STORE_HOURS_FOR_DATE",
  "STORE_OPEN_NOW",
  "ORDER_FULFILLMENT_STAGE",
  "PAYMENT_STATUS",
  "RESERVATION_STATUS",
  "CART_CONTENTS",
  "CART_EMPTY",
  "ORDER_HISTORY",
  "PAYMENT_HISTORY",
  "MENU_ITEM_PRICE",
  "MENU_ITEM_CONTENTS",
  "MENU_OVERVIEW",
  "MENU_DIETARY",
  "STORE_INFO",
  "PURCHASE_COMPLETED",
  // Post-train additions (merged 2026-07-26): the delivery-coverage pair
  // (LE2 ticket 02 / NEW-007, PR #378) and the coupon-validity pair
  // (LE2-019, PR #383) landed via the ops chain after this mirror was cut —
  // caught by the both-directions equality gate on the merged tree.
  "DELIVERY_COVERAGE",
  "DELIVERY_NO_COVERAGE",
  "COUPON_VALID",
  "COUPON_INVALID",
] as const

/** A registry claim TYPE name (the planner's closed selection enum). */
export type RegistryClaimTypeReference = (typeof REGISTRY_CLAIM_TYPE_REFERENCES)[number]

const REGISTRY_TYPE_SET: ReadonlySet<string> = new Set<string>(
  REGISTRY_CLAIM_TYPE_REFERENCES,
)

/** Does `value` name a live registry claim type? Pure. */
export function isRegistryClaimTypeReference(
  value: unknown,
): value is RegistryClaimTypeReference {
  return typeof value === "string" && REGISTRY_TYPE_SET.has(value)
}
