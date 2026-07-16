import { describe, expect, it } from "vitest"

import { CHAT_DRIVABLE_TOOL_KINDS } from "../index.js"
import { CAPABILITY_DEFINITIONS, generateChatDrivableToolKinds } from "../capability-definitions/index.js"
import type { CapabilityDefinition } from "../capability-definitions/index.js"

describe("codegen-freshness gate — CHAT_DRIVABLE_TOOL_KINDS exemplar (FE-4.3)", () => {
  it("generateChatDrivableToolKinds(CAPABILITY_DEFINITIONS) reproduces the committed hand list byte-for-byte", () => {
    const generated = generateChatDrivableToolKinds(CAPABILITY_DEFINITIONS)
    // Array, not just Set, equality — CHAT_DRIVABLE_TOOL_KINDS's own doc
    // comment groups entries by pack in a specific order ("pack-orders
    // (10)", "pack-reservations (4)", …); an order regression is real
    // drift the freshness gate must catch, not something a Set comparison
    // would hide.
    expect(generated).toEqual([...CHAT_DRIVABLE_TOOL_KINDS])
  })

  it("covers exactly the hand list's cardinality (18) — a silent drop or duplicate would still diff above, this pins the count independently", () => {
    expect(CHAT_DRIVABLE_TOOL_KINDS).toHaveLength(18)
    expect(generateChatDrivableToolKinds(CAPABILITY_DEFINITIONS)).toHaveLength(18)
  })

  it("the projection is a genuine derivation (mutating+chat filter), not a copy of the hand list: a non-chat or non-mutating definition is excluded", () => {
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
    expect(generateChatDrivableToolKinds(withExtraNonChatDef)).toEqual([...CHAT_DRIVABLE_TOOL_KINDS])
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
