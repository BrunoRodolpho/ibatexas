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
  generateConversationTriggers,
  generateMutatingToolNames,
  generateToolToIntentMap,
  MIN_CONVERSATION_TRIGGERS,
  normalizeTriggerPhrasing,
} from "@ibatexas/catalog"
import type { CapabilityDefinition, CapabilityPackId } from "@ibatexas/catalog"

// ── Count assertions (ticket AC: "70 KNOWN / 18 CHAT_DRIVABLE", updated to
// 20 CHAT_DRIVABLE by FE-T09 (D-a) — the amend inversion; KNOWN 70→65 (BKL-176
// retired 5 payment.charge.*) → 63 (BKL-177 PR-A retired order.cancel.system +
// reservation.waitlist.notify) → 61 (BKL-177 PR-B retired whatsapp.message.send
// + template.send) → 62 (NEW-014 added the system-only order.fiscal.emit — NOT
// chat-drivable, so CHAT_DRIVABLE stays 20) → 63 (LE2-021 added
// order.reorder.request, the reorder-last workflow's IDENTITY-tier anchor — it
// has a registered tool but is never planner-advertised, so CHAT_DRIVABLE stays
// 20 too; see register-workflow-anchor-tools.ts on why "registered" and
// "chat-drivable" are deliberately two different facts) → 65 (LE2-023 added
// order.coupon.swap.request, the swap-for-coupon anchor, and
// order.coupon.adjust, its closed branch's target — the first is IDENTITY-tier
// and the second is WORKFLOW-SCOPED, so NEITHER is planner-advertised and
// CHAT_DRIVABLE stays 20 again) ──

describe("count assertions — 65 KNOWN / 20 CHAT_DRIVABLE pinned against the projections (FE-T21 AC, FE-T09 D-a update; BKL-176 + BKL-177 + NEW-014 + LE2-021 + LE2-023)", () => {
  it("KNOWN_INTENT_KINDS has exactly 65 kinds", () => {
    // 70 → 65 (BKL-176: 5 dead payment.charge.*) → 63 (BKL-177 PR-A: 2 kinds)
    // → 61 (BKL-177 PR-B: whatsapp.message.send + template.send) → 62
    // (NEW-014: +order.fiscal.emit) → 63 (LE2-021: +order.reorder.request) → 65
    // (LE2-023: +order.coupon.swap.request, +order.coupon.adjust).
    expect(KNOWN_INTENT_KINDS.size).toBe(65)
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

  it("the 61-kind CapabilityDefinition registry + KNOWN_INTENT_KINDS' 4 external kinds (3 pix + 1 loyalty) account for all 65", () => {
    // 66 → 61 (BKL-176: 5 dead payment.charge.*) → 59 (BKL-177 PR-A: 2 kinds)
    // → 57 (BKL-177 PR-B: 2 whatsapp kinds) → 58 (NEW-014: +order.fiscal.emit)
    // → 59 (LE2-021: +order.reorder.request) → 61 (LE2-023:
    // +order.coupon.swap.request, the swap-for-coupon anchor, and
    // +order.coupon.adjust, its closed branch's workflow-scoped target).
    expect(CAPABILITY_DEFINITIONS).toHaveLength(61)
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

// ── The conversation projection (LE2-033) ────────────────────────────────

describe("generateConversationTriggers — the registered tool roster's CUSTOMER-register side (LE2-033)", () => {
  // `generateCapabilityDescriptions` above projects the ADMIN register (what
  // an operator calls the capability). This projects the CUSTOMER register
  // (what a person asks for). The two are keyed identically and diverge only
  // in voice — which is the entire finding LE2-008 measured: recall@5 = 73.8%
  // against the admin register alone, because customers do not speak it.
  //
  // There is no external artifact to pin the VALUES against — unlike every
  // other generator in this family, the projection is net-new authored data
  // with no hand-maintained twin to drift from. So the freshness statement
  // here is about COVERAGE (the key set tracks the chat roster exactly) and
  // the content invariants live in the catalog compiler's own
  // `conversation-projection` pass, which is a build gate rather than a test.

  it("projects one phrasing list per chat-tier capability, keyed exactly like the roster", () => {
    const generated = generateConversationTriggers(CAPABILITY_DEFINITIONS)
    expect(Object.keys(generated).sort()).toEqual([...CHAT_DRIVABLE_TOOL_KINDS].sort())
  })

  it("every projected list matches its authored CapabilityDefinition.conversationTriggers exactly", () => {
    const generated = generateConversationTriggers(CAPABILITY_DEFINITIONS)
    for (const def of CAPABILITY_DEFINITIONS) {
      if (def.tier !== "chat") continue
      expect(generated[def.kind]).toEqual(def.conversationTriggers)
    }
  })

  it("clears the compiler's per-capability floor on every capability", () => {
    const generated = generateConversationTriggers(CAPABILITY_DEFINITIONS)
    for (const [kind, triggers] of Object.entries(generated)) {
      expect(triggers.length, `${kind}`).toBeGreaterThanOrEqual(MIN_CONVERSATION_TRIGGERS)
    }
  })

  it("no phrasing is claimed by two capabilities — the separation the projection exists for", () => {
    // The catalog compiler enforces this fail-closed at build time; this is
    // the same statement asserted from the consuming side, over the REAL
    // roster, so a regression is visible here too rather than only in a build
    // log. Compared under the shared normal form, not by bytes.
    const owner = new Map<string, string>()
    const collisions: string[] = []
    for (const [kind, triggers] of Object.entries(
      generateConversationTriggers(CAPABILITY_DEFINITIONS),
    )) {
      for (const phrasing of triggers) {
        const normal = normalizeTriggerPhrasing(phrasing)
        const held = owner.get(normal)
        if (held !== undefined && held !== kind) collisions.push(`"${phrasing}": ${held} vs ${kind}`)
        else owner.set(normal, kind)
      }
    }
    expect(collisions).toEqual([])
  })

  it("hand-corrupt one definition's triggers → the coverage projection diverges (the required negative direction)", () => {
    const corrupted = CAPABILITY_DEFINITIONS.map((def) =>
      def.kind === "order.item.add" && def.tier === "chat"
        ? { ...def, conversationTriggers: [] }
        : def,
    )
    const generated = generateConversationTriggers(corrupted)
    expect(generated["order.item.add"]).toEqual([])
    expect(generated["order.item.add"]).not.toEqual(
      generateConversationTriggers(CAPABILITY_DEFINITIONS)["order.item.add"],
    )
  })
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
