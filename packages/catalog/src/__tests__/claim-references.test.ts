// LE2-014 — cross-reference check v0.
//
// The gate's value depends entirely on it being a GENUINE check. The FE-4
// freshness work named the failure mode precisely ("generated-vs-generated"):
// a gate whose two sides are the same expression always passes and proves
// nothing. So the central test here is not "the real data passes" — it is
// "a deliberately-dangling reference FAILS", with the real data as the
// control.

import { describe, expect, it } from "vitest"

import {
  assertClaimReferencesResolve,
  CatalogCrossReferenceError,
  findClaimReferenceDanglers,
  formatClaimReferenceReport,
} from "../build-gates/check-claim-references.js"
import {
  CLAIM_CLASS_REFERENCES,
  isClaimClassReference,
  isRegistryClaimTypeReference,
  REGISTRY_CLAIM_TYPE_REFERENCES,
} from "../claim-references.js"
import { CAPABILITY_DEFINITIONS } from "../capability-definitions/definitions.js"
import type { CapabilityDefinition } from "../capability-definitions/types.js"

describe("cross-reference check v0 — the gate rejects a dangler", () => {
  it("FAILS on a capability linking to a claim id nothing defines", () => {
    const withDangler: readonly CapabilityDefinition[] = [
      ...CAPABILITY_DEFINITIONS,
      {
        kind: "order.checkout.create",
        pack: "ibatexas/pack-orders",
        mutating: true,
        tier: "identity",
        successClaimLinks: ["order-placed", "this-claim-does-not-exist"],
      },
    ]
    const danglers = findClaimReferenceDanglers(withDangler)
    expect(danglers).toEqual([
      {
        kind: "order.checkout.create",
        field: "successClaimLinks",
        reference: "this-claim-does-not-exist",
        vocabulary: "CLAIM_CLASS_REFERENCES",
      },
    ])
    // The good reference alongside it is NOT reported — the gate discriminates
    // per-reference, it does not condemn the whole definition.
    expect(danglers.map((d) => d.reference)).not.toContain("order-placed")

    expect(() => assertClaimReferencesResolve(withDangler)).toThrow(
      CatalogCrossReferenceError,
    )
  })

  it("names the capability, the field, and the bad reference in the failure message", () => {
    // The message is the entire UX of a failed build. It must be actionable
    // without opening the checker's source.
    const report = formatClaimReferenceReport([
      {
        kind: "order.cancel",
        field: "successClaimLinks",
        reference: "order-nuked",
        vocabulary: "CLAIM_CLASS_REFERENCES",
      },
    ])
    expect(report).toContain("order.cancel")
    expect(report).toContain("successClaimLinks")
    expect(report).toContain("order-nuked")
    expect(report).toContain("CLAIM_CLASS_REFERENCES")
    expect(report).toContain("1 dangling claim reference")
  })

  it("catches a dangler on a near-miss (casing / typo), not just an absurd string", () => {
    // Realistic failure: the claim classes are lowercase-hyphenated, and the
    // registry TYPE name space is UPPER_SNAKE (SDD §K "map, do not equate").
    // Reaching for the wrong name space is the mistake a human actually makes.
    const withNearMiss: readonly CapabilityDefinition[] = [
      {
        kind: "order.cancel",
        pack: "ibatexas/pack-orders",
        mutating: true,
        tier: "identity",
        successClaimLinks: ["ORDER_CANCELED", "order-cancelled"],
      },
    ]
    const danglers = findClaimReferenceDanglers(withNearMiss)
    // "ORDER_CANCELED" — right idea, wrong name space. "order-cancelled" —
    // the British spelling; the real id is "order-canceled".
    expect(danglers.map((d) => d.reference).sort()).toEqual([
      "ORDER_CANCELED",
      "order-cancelled",
    ])
  })
})

describe("cross-reference check v0 — the real catalog is coherent (the control)", () => {
  it("every claim reference in CAPABILITY_DEFINITIONS resolves", () => {
    expect(findClaimReferenceDanglers(CAPABILITY_DEFINITIONS)).toEqual([])
  })

  it("actually checked a non-trivial number of references (a vacuous gate is not a gate)", () => {
    const checked = assertClaimReferencesResolve(CAPABILITY_DEFINITIONS)
    expect(checked).toBeGreaterThan(20)
  })

  it("definitions with no claim link are valid-by-absence, not danglers", () => {
    // Most capabilities legitimately have no claim link — the live claim
    // registry covers only a handful of proposable types. `undefined` is a
    // correct value, never a missing one.
    const unlinked = CAPABILITY_DEFINITIONS.filter(
      (d) => d.successClaimLinks === undefined,
    )
    expect(unlinked.length).toBeGreaterThan(0)
    expect(findClaimReferenceDanglers(unlinked)).toEqual([])
  })
})

describe("claim-reference vocabularies", () => {
  it("CLAIM_CLASS_REFERENCES has the 19 documented classes (11 SDD §K seed + 8 BKL-194)", () => {
    expect(CLAIM_CLASS_REFERENCES).toHaveLength(19)
    expect(new Set(CLAIM_CLASS_REFERENCES).size).toBe(19)
  })

  it("REGISTRY_CLAIM_TYPE_REFERENCES has the 17 live runtime registry types", () => {
    expect(REGISTRY_CLAIM_TYPE_REFERENCES).toHaveLength(17)
    expect(new Set(REGISTRY_CLAIM_TYPE_REFERENCES).size).toBe(17)
  })

  it("keeps fulfillment-claimed in the vocabulary but unreferenced by any capability", () => {
    // The permanently-unearnable class (CLAUDE.md: justifiedBy is [] forever).
    // It must exist as a NAME the responder defines, and no capability may
    // ever link to it — that link would be the confabulation the guard exists
    // to clamp.
    expect(CLAIM_CLASS_REFERENCES).toContain("fulfillment-claimed")
    for (const def of CAPABILITY_DEFINITIONS) {
      expect(def.successClaimLinks ?? []).not.toContain("fulfillment-claimed")
    }
  })

  it("the two name spaces are disjoint (SDD §K — map, do not equate)", () => {
    const classes = new Set<string>(CLAIM_CLASS_REFERENCES)
    for (const type of REGISTRY_CLAIM_TYPE_REFERENCES) {
      expect(classes.has(type)).toBe(false)
    }
  })

  it("the membership predicates narrow correctly and reject foreign input", () => {
    expect(isClaimClassReference("order-placed")).toBe(true)
    expect(isClaimClassReference("PURCHASE_COMPLETED")).toBe(false)
    expect(isClaimClassReference(undefined)).toBe(false)
    expect(isClaimClassReference(42)).toBe(false)

    expect(isRegistryClaimTypeReference("PURCHASE_COMPLETED")).toBe(true)
    expect(isRegistryClaimTypeReference("purchase-completed")).toBe(false)
    expect(isRegistryClaimTypeReference(null)).toBe(false)
  })
})
