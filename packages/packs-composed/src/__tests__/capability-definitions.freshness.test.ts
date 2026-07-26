import { describe, expect, it } from "vitest"

import { CAPABILITY_DEFINITIONS, generateChatDrivableToolKinds } from "@ibatexas/catalog"
import type { CapabilityDefinition } from "@ibatexas/catalog"

// FE-4 CONTRACT (FE-T26) — RETIRED-AS-TAUTOLOGICAL: this describe block
// used to be titled "codegen-freshness gate — CHAT_DRIVABLE_TOOL_KINDS
// exemplar (FE-4.3)" and carried two tests comparing
// `generateChatDrivableToolKinds(CAPABILITY_DEFINITIONS)` against the
// hand-authored `CHAT_DRIVABLE_TOOL_KINDS` (`../index.js`) byte-for-byte
// and by cardinality. This ticket repointed `CHAT_DRIVABLE_TOOL_KINDS`
// itself to literally BE `generateChatDrivableToolKinds(CAPABILITY_
// DEFINITIONS)` — the two sides of both comparisons are now the identical
// expression, so they always pass by construction and prove nothing
// (FE-4.3's own "generated-vs-generated" tautology, the exact failure
// mode the spec warned CONTRACT could introduce). Retired rather than left
// vacuously passing. The surviving independent check for this data is
// `apps/api/src/__tests__/chat-drivable-roster-drift.test.ts`'s "mirrors
// the live registered roster exactly (both directions)" test, which
// compares the (now-generated) constant against `listIbatexasToolPacks()`
// — the REAL registered DI tool container, a genuine runtime
// materialization this repoint never touched. Recorded in docs/
// architecture/design/fe4-drift-gates.md.
//
// The one test from that block that was NEVER tautological — it tests the
// generator FUNCTION's filtering behavior directly, independent of what
// CHAT_DRIVABLE_TOOL_KINDS's own source happens to be — survives below,
// adjusted to compare two direct generator calls instead of referencing
// the constant.
describe("generateChatDrivableToolKinds — filter behavior (FE-4.3)", () => {
  it("is a genuine derivation (mutating+chat filter), not an identity pass-through: a non-chat or non-mutating definition is excluded", () => {
    const baseline = generateChatDrivableToolKinds(CAPABILITY_DEFINITIONS)
    const withExtraNonChatDef: readonly CapabilityDefinition[] = [
      ...CAPABILITY_DEFINITIONS,
      {
        kind: "product.availability.set",
        pack: "ibatexas/pack-ops",
        mutating: true,
        tier: "chat",
        surfaces: ["staff", "ops"],
        auth: "staff",
        legacyNames: [],
        description: "test fixture — staff-only, must not appear in the chat projection",
        guardRefs: [],
        refusalCode: "ops.default.deny",
      },
      {
        kind: "get_cart",
        pack: "ibatexas/pack-orders",
        mutating: false,
        tier: "chat",
        surfaces: ["chat"],
        auth: "guest",
        legacyNames: [],
        description: "test fixture — read-only, must not appear in the MUTATING chat projection",
        guardRefs: [],
        refusalCode: "order.default.deny",
      },
    ]
    expect(generateChatDrivableToolKinds(withExtraNonChatDef)).toEqual(baseline)
  })

  it("pins the real projection's cardinality (20, post-FE-T09 D-a: 18→20) — a silent drop or duplicate in CAPABILITY_DEFINITIONS would change this", () => {
    expect(generateChatDrivableToolKinds(CAPABILITY_DEFINITIONS)).toHaveLength(20)
  })
})

describe("extractionSchema — forward-declared, gates nothing (FE-4.1/FE-1)", () => {
  it("is undefined on every instance authored in this EXPAND step", () => {
    for (const def of CAPABILITY_DEFINITIONS) {
      expect(def.extractionSchema).toBeUndefined()
    }
  })

  it("populating it does not change the freshness projection's output (behaviorally proves it gates nothing)", () => {
    const before = generateChatDrivableToolKinds(CAPABILITY_DEFINITIONS)
    const withSchemas: readonly CapabilityDefinition[] = CAPABILITY_DEFINITIONS.map((def) => ({
      ...def,
      extractionSchema: { type: "object", properties: {}, __fixture: "FE-1 would populate this" },
    }))
    const after = generateChatDrivableToolKinds(withSchemas)
    expect(after).toEqual(before)
  })
})
