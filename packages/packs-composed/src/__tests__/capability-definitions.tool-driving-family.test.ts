// FE-T21 — FE-4 MIGRATE 2: tool/driving family generators.
//
// Four named targets, three NEW generators (CHAT_DRIVABLE_TOOL_KINDS is
// FE-T19's exemplar, absorbed here via count assertions, not duplicated):
//   1. CHAT_DRIVABLE_TOOL_KINDS   — generateChatDrivableToolKinds (FE-T19,
//                                   unchanged) — count-pinned below.
//   2. Registered tool roster    — the CAPABILITY-KEY side IS
//                                   CHAT_DRIVABLE_TOOL_KINDS (capability
//                                   === intentKind, RC-A1 Phase A); the
//                                   VALUE side (pt-BR descriptions) is
//                                   generateCapabilityDescriptions — its
//                                   freshness test compares directly
//                                   against the real, EXPORTED
//                                   IBATEXAS_CAPABILITY_DESCRIPTIONS
//                                   (register-ibatexas-tool-packs.ts:400)
//                                   in apps/api/src/__tests__/chat-
//                                   drivable-roster-drift.test.ts
//                                   (extended, not a new file) — packages
//                                   cannot import apps/api.
//   3. Per-pack tool→intent maps — generateToolToIntentMap, vs each pack's
//                                   real exported `*_TOOL_TO_INTENT`.
//   4. Mutating classification   — generateMutatingToolNames, vs each
//                                   pack's real exported `*_TOOLS.MUTATING`
//                                   (the MUTATING half only — READ_ONLY is
//                                   out of scope, capabilities model
//                                   mutations, not reads).

import { describe, expect, it } from "vitest"

import { KNOWN_INTENT_KINDS } from "@ibatexas/intent-kinds"
import { CUSTOMER_ONBOARDING_TOOL_TO_INTENT, CUSTOMER_ONBOARDING_TOOLS } from "@ibatexas/pack-customer-onboarding"
import { ORDER_TOOL_TO_INTENT, ORDER_TOOLS } from "@ibatexas/pack-orders"
import { PAYMENT_TOOL_TO_INTENT, PAYMENT_TOOLS } from "@ibatexas/pack-payments"
import { RESERVATION_TOOL_TO_INTENT, RESERVATION_TOOLS } from "@ibatexas/pack-reservations"
import { WHATSAPP_TOOL_TO_INTENT, WHATSAPP_TOOLS } from "@ibatexas/pack-whatsapp"

import { CHAT_DRIVABLE_TOOL_KINDS } from "../index.js"
import {
  CAPABILITY_DEFINITIONS,
  generateCapabilityDescriptions,
  generateChatDrivableToolKinds,
  generateMutatingToolNames,
  generateToolToIntentMap,
} from "../capability-definitions/index.js"
import type { CapabilityDefinition, CapabilityPackId } from "../capability-definitions/index.js"

// ── Count assertions (ticket AC: "70 KNOWN / 18 CHAT_DRIVABLE", updated to
// 20 CHAT_DRIVABLE by FE-T09 (D-a) — the amend inversion) ─────────

describe("count assertions — 70 KNOWN / 20 CHAT_DRIVABLE pinned against the projections (FE-T21 AC, FE-T09 D-a update)", () => {
  it("KNOWN_INTENT_KINDS has exactly 70 kinds", () => {
    expect(KNOWN_INTENT_KINDS.size).toBe(70)
  })

  it("CHAT_DRIVABLE_TOOL_KINDS has exactly 20 kinds, and generateChatDrivableToolKinds(CAPABILITY_DEFINITIONS) reproduces it byte-for-byte", () => {
    expect(CHAT_DRIVABLE_TOOL_KINDS).toHaveLength(20)
    const generated = generateChatDrivableToolKinds(CAPABILITY_DEFINITIONS)
    expect(generated).toHaveLength(20)
    expect(generated).toEqual([...CHAT_DRIVABLE_TOOL_KINDS])
  })

  it('the chat-drivable count JSDoc is fresh: packs-composed/src/index.ts documents 20, matching the real array length (FE-T09 D-a)', async () => {
    // Read-the-source-as-text check (not just the runtime value, which
    // trivially has length 20) — the ticket's AC is specifically about the
    // DOC COMMENT having drifted from the real count in the past (fixed as
    // part of FE-T19's PR #245 rider; re-verified after FE-T09's 18→20
    // change). Verified here so a future edit that reintroduces a stale
    // "18" anywhere near the export is caught.
    const fs = await import("node:fs/promises")
    const url = await import("node:url")
    const path = url.fileURLToPath(new URL("../index.ts", import.meta.url))
    const source = await fs.readFile(path, "utf-8")
    expect(source).toContain("The 20 chat-drivable")
    expect(source).not.toMatch(/The 18 chat-drivable/)
  })

  it("the 66-kind CapabilityDefinition registry + KNOWN_INTENT_KINDS' 4 external kinds (3 pix + 1 loyalty) account for all 70", () => {
    expect(CAPABILITY_DEFINITIONS).toHaveLength(66)
  })
})

// ── Registered tool roster — capability descriptions (value side) ───────

describe("generateCapabilityDescriptions — the registered tool roster's VALUE side (FE-T21)", () => {
  it("projects exactly 20 pt-BR descriptions, one per chat-tier capability", () => {
    const generated = generateCapabilityDescriptions(CAPABILITY_DEFINITIONS)
    expect(Object.keys(generated)).toHaveLength(20)
    for (const kind of CHAT_DRIVABLE_TOOL_KINDS) {
      expect(generated).toHaveProperty(kind)
      expect(typeof generated[kind]).toBe("string")
      expect(generated[kind]!.length).toBeGreaterThan(0)
    }
  })

  it("every projected description matches its authored CapabilityDefinition.description exactly", () => {
    const generated = generateCapabilityDescriptions(CAPABILITY_DEFINITIONS)
    for (const def of CAPABILITY_DEFINITIONS) {
      if (def.tier !== "chat") continue
      expect(generated[def.kind]).toBe(def.description)
    }
  })

  // The cross-boundary freshness test — a direct `toEqual` against the
  // real, EXPORTED `IBATEXAS_CAPABILITY_DESCRIPTIONS`
  // (register-ibatexas-tool-packs.ts:400) — lives in apps/api/src/
  // __tests__/chat-drivable-roster-drift.test.ts (extended, not a new
  // file): packages/packs-composed cannot import apps/api.
})

// ── Per-pack tool→intent maps ────────────────────────────────────────────

describe("codegen-freshness gate — per-pack tool→intent maps (FE-T21)", () => {
  const CASES: ReadonlyArray<{
    pack: CapabilityPackId
    hand: Readonly<Record<string, string>>
  }> = [
    { pack: "ibatexas/pack-orders", hand: ORDER_TOOL_TO_INTENT },
    { pack: "ibatexas/pack-reservations", hand: RESERVATION_TOOL_TO_INTENT },
    { pack: "ibatexas/pack-customer-onboarding", hand: CUSTOMER_ONBOARDING_TOOL_TO_INTENT },
    { pack: "ibatexas/pack-payments", hand: PAYMENT_TOOL_TO_INTENT },
    { pack: "ibatexas/pack-whatsapp", hand: WHATSAPP_TOOL_TO_INTENT },
  ]

  for (const { pack, hand } of CASES) {
    it(`${pack}: reproduces its *_TOOL_TO_INTENT map byte-for-byte (${Object.keys(hand).length} entries)`, () => {
      const generated = generateToolToIntentMap(CAPABILITY_DEFINITIONS, pack)
      expect(generated).toEqual(hand)
    })
  }

  it("pack-payments' map has 3 entries, not 1 — the two de-advertised identity-tier exceptions are correctly included", () => {
    const generated = generateToolToIntentMap(CAPABILITY_DEFINITIONS, "ibatexas/pack-payments")
    expect(Object.keys(generated)).toHaveLength(3)
    expect(generated["switch_payment_method"]).toBe("payment.method.switch")
    expect(generated["retry_payment"]).toBe("payment.retry")
    expect(generated["regenerate_pix"]).toBe("payment.pix.regenerate")
  })

  it("hand-corrupt one definition's legacyNames → the freshness diff fails (the ticket's required negative direction)", () => {
    const corrupted: readonly CapabilityDefinition[] = CAPABILITY_DEFINITIONS.map((def) =>
      def.kind === "order.item.add" && def.tier === "chat"
        ? { ...def, legacyNames: ["THIS_TOOL_NAME_IS_WRONG"] }
        : def,
    )
    const generated = generateToolToIntentMap(corrupted, "ibatexas/pack-orders")
    expect(generated).not.toEqual(ORDER_TOOL_TO_INTENT)
    expect(generated["THIS_TOOL_NAME_IS_WRONG"]).toBe("order.item.add")
    expect(generated["add_to_cart"]).toBeUndefined()
  })
})

// ── Per-pack mutating tool-name classification ───────────────────────────

describe("codegen-freshness gate — per-pack MUTATING tool-name classification (FE-T21)", () => {
  it("ibatexas/pack-orders: reproduces ORDER_TOOLS.MUTATING as a set (11 entries, incl. the un-kind-mapped 'reorder')", () => {
    const generated = generateMutatingToolNames(CAPABILITY_DEFINITIONS, "ibatexas/pack-orders", ["reorder"])
    expect(new Set(generated)).toEqual(ORDER_TOOLS.MUTATING)
  })

  it("ibatexas/pack-reservations: reproduces RESERVATION_TOOLS.MUTATING as a set (4 entries)", () => {
    const generated = generateMutatingToolNames(CAPABILITY_DEFINITIONS, "ibatexas/pack-reservations")
    expect(new Set(generated)).toEqual(RESERVATION_TOOLS.MUTATING)
  })

  it("ibatexas/pack-customer-onboarding: reproduces CUSTOMER_ONBOARDING_TOOLS.MUTATING as a set (2 entries)", () => {
    const generated = generateMutatingToolNames(CAPABILITY_DEFINITIONS, "ibatexas/pack-customer-onboarding")
    expect(new Set(generated)).toEqual(CUSTOMER_ONBOARDING_TOOLS.MUTATING)
  })

  it("ibatexas/pack-payments: reproduces PAYMENT_TOOLS.MUTATING as a set (3 entries — the two de-advertised kinds included via legacyNames)", () => {
    const generated = generateMutatingToolNames(CAPABILITY_DEFINITIONS, "ibatexas/pack-payments")
    expect(new Set(generated)).toEqual(PAYMENT_TOOLS.MUTATING)
  })

  it("ibatexas/pack-whatsapp: reproduces WHATSAPP_TOOLS.MUTATING as a set (4 entries, incl. the 3 un-kind-mapped subscriber-only tool names)", () => {
    const generated = generateMutatingToolNames(CAPABILITY_DEFINITIONS, "ibatexas/pack-whatsapp", [
      "send_whatsapp_message",
      "send_whatsapp_template",
      "handover_whatsapp_session",
    ])
    expect(new Set(generated)).toEqual(WHATSAPP_TOOLS.MUTATING)
  })

  it("without the extraToolNames input, orders' and whatsapp's projections are genuine SUBSETS of the real MUTATING sets — proving 'reorder' and the 3 whatsapp names are truly not derivable from CapabilityDefinition alone", () => {
    const ordersWithoutExtras = new Set(generateMutatingToolNames(CAPABILITY_DEFINITIONS, "ibatexas/pack-orders"))
    expect(ordersWithoutExtras.has("reorder")).toBe(false)
    expect(ordersWithoutExtras.size).toBe(ORDER_TOOLS.MUTATING.size - 1)

    const whatsappWithoutExtras = new Set(generateMutatingToolNames(CAPABILITY_DEFINITIONS, "ibatexas/pack-whatsapp"))
    expect(whatsappWithoutExtras.has("send_whatsapp_message")).toBe(false)
    expect(whatsappWithoutExtras.size).toBe(WHATSAPP_TOOLS.MUTATING.size - 3)
  })
})
