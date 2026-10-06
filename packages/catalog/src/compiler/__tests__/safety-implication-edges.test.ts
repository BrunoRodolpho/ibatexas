// LE2-016 — pass 3: safety-implication edges (the ratified BKL-143/123/171
// rulings as build invariants).
//
// This is the pass whose failure mode is a LIABILITY, not a broken build, so
// its tests are written the other way round from the rest: the load-bearing
// assertions are that the forbidden edges FAIL, in every spelling — including
// spellings nobody has written yet.

import { describe, expect, it } from "vitest"

import { CAPABILITY_DEFINITIONS } from "../../capability-definitions/definitions.js"
import type { CapabilityDefinition } from "../../capability-definitions/types.js"
import { runSafetyImplicationEdgesPass } from "../passes/safety-implication-edges.js"
import { normalizeReference, safetyMarkerOf } from "../safety-markers.js"

function withClaimLinks(links: readonly unknown[]): CapabilityDefinition {
  return {
    kind: "menu.item.describe",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "identity",
    successClaimLinks: links,
  } as unknown as CapabilityDefinition
}

describe("safety-implication-edges — allergen edges are compile ERRORS", () => {
  it("FAILS on a claim edge into MENU_ITEM_ALLERGENS, citing BKL-143/BKL-123", () => {
    // The registry type is a REAL member of REGISTRY_CLAIM_TYPE_REFERENCES —
    // it resolves perfectly under referential integrity and must still be
    // refused here. Resolvable is not permitted.
    const result = runSafetyImplicationEdgesPass([withClaimLinks(["MENU_ITEM_ALLERGENS"])])
    expect(result.diagnostics).toHaveLength(1)
    const [d] = result.diagnostics
    expect(d).toMatchObject({
      pass: "safety-implication-edges",
      rule: "safety-restricted-claim-edge",
      severity: "error",
      object: "capability:menu.item.describe",
      field: "successClaimLinks[0]",
      reference: "MENU_ITEM_ALLERGENS",
    })
    expect(d?.message).toContain("BKL-143")
    expect(d?.message).toContain("BKL-123")
    expect(d?.message).toContain("não contém X")
  })

  it("FAILS on the pt-BR spelling, the plural, and the camelCase form alike", () => {
    for (const reference of ["alergenos", "menu-item-allergens", "menuItemAllergens"]) {
      const result = runSafetyImplicationEdgesPass([withClaimLinks([reference])])
      expect(result.diagnostics, reference).toHaveLength(1)
    }
  })

  it("FAILS on a bounded allergen noun, and NOT on a word merely containing one", () => {
    expect(safetyMarkerOf("contains-egg")).toMatchObject({ family: "allergen", token: "egg" })
    // \bovo\b never fires inside "provolone" — the source regex's own boundary
    // discipline, transposed to identifier segments.
    expect(safetyMarkerOf("provolone-added")).toBeUndefined()
  })
})

describe("safety-implication-edges — dietary-restriction edges are compile ERRORS", () => {
  it("FAILS on a 'sem glúten' edge in any spelling, citing BKL-171", () => {
    for (const reference of ["sem_gluten", "gluten-free-list", "glutenFree", "sem-lactose"]) {
      const result = runSafetyImplicationEdgesPass([withClaimLinks([reference])])
      expect(result.diagnostics, reference).toHaveLength(1)
      expect(result.diagnostics[0]?.message, reference).toContain("BKL-171")
    }
  })

  it("routes an UNRECOGNIZED safety-marked reference conservatively to DENY", () => {
    // Neither vocabulary defines it, and it looks like an allergen assertion.
    // The conservative branch is the whole point: unknown fails CLOSED, and
    // says so under its own rule id rather than being left to the referential
    // pass to report as a mere typo.
    const [d] = runSafetyImplicationEdgesPass([
      withClaimLinks(["menu-item-allergens-v2"]),
    ]).diagnostics
    expect(d).toMatchObject({
      rule: "unrecognized-safety-marker-conservatively-denied",
      severity: "error",
      reference: "menu-item-allergens-v2",
    })
    expect(d?.message).toContain("routes conservatively to DENY")
  })
})

describe("safety-implication-edges — the pass does not over-reach", () => {
  it("leaves an ordinary claim edge alone", () => {
    expect(
      runSafetyImplicationEdgesPass([withClaimLinks(["order-placed", "pix-generated"])])
        .diagnostics,
    ).toEqual([])
  })

  it("judges the EDGE TARGET, never the capability's own name", () => {
    // A capability that WRITES a customer's self-reported allergens is the
    // ratified-SAFE behavior ("honest self-report + real staff handoff");
    // flagging its kind would invert the ruling.
    const selfReport = {
      kind: "customer.allergens.set",
      pack: "ibatexas/pack-customer-onboarding",
      mutating: true,
      tier: "identity",
    } as unknown as CapabilityDefinition
    expect(runSafetyImplicationEdgesPass([selfReport]).diagnostics).toEqual([])
  })

  it("normalizes deterministically (no locale, no diacritics, one separator)", () => {
    expect(normalizeReference("Glúten-Free.List")).toBe("gluten_free_list")
    expect(normalizeReference("MENU_ITEM_ALLERGENS")).toBe("menu_item_allergens")
  })
})

describe("safety-implication-edges — the real catalog is the control", () => {
  it("passes clean: no capability links its success to an allergen/dietary claim", () => {
    expect(runSafetyImplicationEdgesPass(CAPABILITY_DEFINITIONS).diagnostics).toEqual([])
  })

  it("classified every claim edge the catalog declares (a vacuous gate is not a gate)", () => {
    expect(runSafetyImplicationEdgesPass(CAPABILITY_DEFINITIONS).checked).toBeGreaterThan(20)
  })
})
