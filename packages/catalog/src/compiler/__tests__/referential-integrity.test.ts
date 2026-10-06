// LE2-016 — pass 1: referential integrity.
//
// The gate's value depends entirely on it being a GENUINE check (the FE-4
// freshness work's "generated-vs-generated" failure mode), so every test below
// is a deliberately-broken FIXTURE that must FAIL, with the real catalog as the
// control. The fixtures are minimal and inline — the full conformance-suite
// fixture catalogs with golden diagnostics are ticket 17.

import { describe, expect, it } from "vitest"

import { CAPABILITY_DEFINITIONS } from "../../capability-definitions/definitions.js"
import type { CapabilityDefinition } from "../../capability-definitions/types.js"
import { runReferentialIntegrityPass } from "../passes/referential-integrity.js"

/** A minimal, VALID identity-tier capability the fixtures perturb one slot of. */
function identity(overrides: Record<string, unknown> = {}): CapabilityDefinition {
  return {
    kind: "order.reorder",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "identity",
    ...overrides,
  } as CapabilityDefinition
}

describe("referential-integrity — the pass rejects a dangling reference", () => {
  it("FAILS on a claim link no vocabulary defines, naming object/slot/rule", () => {
    const result = runReferentialIntegrityPass([
      identity({ successClaimLinks: ["order-placed", "this-claim-does-not-exist"] }),
    ])

    expect(result.diagnostics).toHaveLength(1)
    const [d] = result.diagnostics
    expect(d).toMatchObject({
      pass: "referential-integrity",
      rule: "claim-reference-dangling",
      severity: "error",
      object: "capability:order.reorder",
      field: "successClaimLinks[1]",
      reference: "this-claim-does-not-exist",
    })
    expect(d?.message).toContain("CLAIM_CLASS_REFERENCES")
    // The good reference alongside it is NOT condemned — the pass discriminates
    // per-reference, never per-definition.
    expect(result.diagnostics.map((x) => x.reference)).not.toContain("order-placed")
  })

  it("FAILS on an unknown owning pack", () => {
    const result = runReferentialIntegrityPass([identity({ pack: "ibatexas/pack-desserts" })])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({
      rule: "pack-reference-dangling",
      field: "pack",
      reference: "ibatexas/pack-desserts",
    })
  })

  it("FAILS on an unknown pack in plannerAdvertisedBy, with its index", () => {
    const result = runReferentialIntegrityPass([
      identity({ plannerAdvertisedBy: ["ibatexas/pack-orders", "ibatexas/pack-ghost"] }),
    ])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({
      rule: "pack-reference-dangling",
      field: "plannerAdvertisedBy[1]",
      reference: "ibatexas/pack-ghost",
    })
  })
})

describe("referential-integrity — identity collisions (the inbound direction)", () => {
  it("FAILS on a duplicated kind, reporting BOTH claimants", () => {
    const result = runReferentialIntegrityPass([identity(), identity({ mutating: false })])
    const dupes = result.diagnostics.filter((d) => d.rule === "duplicate-capability-kind")
    expect(dupes).toHaveLength(2)
    expect(dupes[0]?.message).toContain("array positions 0, 1")
  })

  it("FAILS when two capabilities claim the same legacy tool name", () => {
    const result = runReferentialIntegrityPass([
      identity({ kind: "order.a", legacyNames: ["reorder"] }),
      identity({ kind: "order.b", legacyNames: ["reorder"] }),
    ])
    const ambiguous = result.diagnostics.filter((d) => d.rule === "ambiguous-legacy-name")
    expect(ambiguous).toHaveLength(2)
    expect(ambiguous[0]).toMatchObject({ field: "legacyNames[0]", reference: "reorder" })
    // The message names the OTHER claimant — that is what makes it actionable.
    expect(ambiguous[0]?.message).toContain("order.a, order.b")
    expect(ambiguous[0]?.message).toContain("generate-tool-to-intent-map.ts")
  })

  it("does NOT fire when one capability legitimately carries several names", () => {
    const result = runReferentialIntegrityPass([
      identity({ legacyNames: ["reorder", "repeat_order"] }),
    ])
    expect(result.diagnostics).toEqual([])
  })
})

describe("referential-integrity — the real catalog is the control", () => {
  it("passes clean", () => {
    expect(runReferentialIntegrityPass(CAPABILITY_DEFINITIONS).diagnostics).toEqual([])
  })

  it("actually checked a non-trivial number of references (a vacuous gate is not a gate)", () => {
    expect(runReferentialIntegrityPass(CAPABILITY_DEFINITIONS).checked).toBeGreaterThan(100)
  })
})
