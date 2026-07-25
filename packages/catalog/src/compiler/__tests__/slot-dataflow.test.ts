// LE2-016 — pass 2: slot dataflow.
//
// One minimal broken fixture per rule the pass enforces, plus the real catalog
// as the control. The fixtures cast through `CapabilityDefinition` on purpose:
// the point of this pass is exactly the space `types.ts` cannot police — a
// catalog VALUE that reached the compiler by a widened cast, a fixture, or a
// future generator.

import { describe, expect, it } from "vitest"

import { CAPABILITY_DEFINITIONS } from "../../capability-definitions/definitions.js"
import type { CapabilityDefinition } from "../../capability-definitions/types.js"
import { runSlotDataflowPass } from "../passes/slot-dataflow.js"

function def(overrides: Record<string, unknown> = {}): CapabilityDefinition {
  return {
    kind: "order.reorder",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "identity",
    ...overrides,
  } as CapabilityDefinition
}

/** A minimal, VALID chat-tier capability — all six chat slots populated. */
function chat(overrides: Record<string, unknown> = {}): CapabilityDefinition {
  return def({
    tier: "chat",
    surfaces: ["chat"],
    auth: "guest",
    legacyNames: ["reorder"],
    description: "Repetir um pedido anterior.",
    guardRefs: [{ phase: "business", name: "executeW5Kinds" }],
    refusalCode: "order.default.deny",
    ...overrides,
  })
}

function rules(definitions: readonly CapabilityDefinition[]): string[] {
  return runSlotDataflowPass(definitions).diagnostics.map((d) => `${d.rule}:${d.field}`)
}

describe("slot-dataflow — type consistency", () => {
  it("FAILS on a slot holding the wrong primitive type", () => {
    const [d] = runSlotDataflowPass([def({ mutating: "yes" })]).diagnostics
    expect(d).toMatchObject({
      pass: "slot-dataflow",
      rule: "slot-type-mismatch",
      severity: "error",
      object: "capability:order.reorder",
      field: "mutating",
    })
    expect(d?.message).toContain("must be a boolean")
  })

  it("FAILS on a string-array slot carrying a non-string", () => {
    expect(rules([def({ successClaimLinks: ["order-placed", 42] })])).toContain(
      "slot-type-mismatch:successClaimLinks",
    )
  })

  it("FAILS on a value outside a closed enum vocabulary", () => {
    const [d] = runSlotDataflowPass([chat({ auth: "root" })]).diagnostics
    expect(d).toMatchObject({ rule: "slot-enum-violation", field: "auth" })
    expect(d?.message).toContain("CAPABILITY_AUTH_LEVELS")
    expect(rules([chat({ surfaces: ["chat", "kiosk"] })])).toContain(
      "slot-enum-violation:surfaces[1]",
    )
  })

  it("FAILS on a malformed guard-ref pair", () => {
    expect(rules([chat({ guardRefs: [{ phase: "business" }] })])).toContain(
      "malformed-guard-ref:guardRefs[0].name",
    )
  })
})

describe("slot-dataflow — required/optional coherence", () => {
  it("FAILS on a chat-tier capability missing a required slot", () => {
    const { refusalCode: _dropped, ...withoutFloor } = chat() as unknown as Record<
      string,
      unknown
    >
    const [d] = runSlotDataflowPass([
      withoutFloor as unknown as CapabilityDefinition,
    ]).diagnostics
    expect(d).toMatchObject({ rule: "missing-required-slot", field: "refusalCode" })
  })

  it("FAILS on a required slot declared blank", () => {
    expect(rules([chat({ description: "   " })])).toContain(
      "blank-required-slot:description",
    )
  })

  it("FAILS on an OPTIONAL slot declared empty (say `undefined`, not `[]`)", () => {
    const [d] = runSlotDataflowPass([def({ successClaimLinks: [] })]).diagnostics
    expect(d).toMatchObject({ rule: "empty-optional-slot", field: "successClaimLinks" })
    expect(rules([def({ plannerAdvertisedBy: [] })])).toContain(
      "empty-optional-slot:plannerAdvertisedBy",
    )
    // …including the forward-declared extraction schema, held to the same rule
    // and to nothing more (FE-1 owns its shape).
    expect(rules([def({ extractionSchema: {} })])).toContain(
      "empty-optional-slot:extractionSchema",
    )
  })

  it("accepts chat-tier `legacyNames: []` — authored data, not a hole", () => {
    // FE-T09's three order.amend.* kinds: newly-registered tools with no
    // historical name. Rejecting this would demand the fabrication the
    // authoring rules forbid.
    expect(runSlotDataflowPass([chat({ legacyNames: [] })]).diagnostics).toEqual([])
  })

  it("treats `undefined` on an unavailable slot as absence, not a declaration", () => {
    expect(runSlotDataflowPass([def({ refusalCode: undefined })]).diagnostics).toEqual([])
  })
})

describe("slot-dataflow — orphan and unknown slots", () => {
  it("FAILS on a chat-only slot declared by an identity-tier capability", () => {
    const [d] = runSlotDataflowPass([def({ refusalCode: "order.default.deny" })]).diagnostics
    expect(d).toMatchObject({ rule: "orphan-slot", field: "refusalCode" })
    expect(d?.message).toContain("IdentityCapabilityDefinition")
  })

  it("FAILS on a slot the contract has never heard of (the silent typo)", () => {
    const [d] = runSlotDataflowPass([
      chat({ refusalCodes: "order.default.deny" }),
    ]).diagnostics
    expect(d).toMatchObject({ rule: "unknown-slot", field: "refusalCodes" })
    expect(d?.message).toContain("types.ts")
  })

  it("FAILS on duplicate entries inside an array slot", () => {
    expect(rules([def({ legacyNames: ["reorder", "reorder"] })])).toContain(
      "duplicate-slot-entry:legacyNames[1]",
    )
    expect(
      rules([
        chat({
          guardRefs: [
            { phase: "business", name: "executeW5Kinds" },
            { phase: "business", name: "executeW5Kinds" },
          ],
        }),
      ]),
    ).toContain("duplicate-slot-entry:guardRefs[1]")
  })

  it("FAILS on a blank entry inside an otherwise non-empty array slot", () => {
    expect(rules([def({ legacyNames: ["reorder", " "] })])).toContain(
      "blank-slot-entry:legacyNames[1]",
    )
  })
})

describe("slot-dataflow — the real catalog is the control", () => {
  it("passes clean", () => {
    expect(runSlotDataflowPass(CAPABILITY_DEFINITIONS).diagnostics).toEqual([])
  })

  it("inspected every slot of every capability (a vacuous gate is not a gate)", () => {
    expect(runSlotDataflowPass(CAPABILITY_DEFINITIONS).checked).toBeGreaterThan(
      CAPABILITY_DEFINITIONS.length * 10,
    )
  })
})
