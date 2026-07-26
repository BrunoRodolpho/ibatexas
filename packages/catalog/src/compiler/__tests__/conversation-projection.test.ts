// LE2-033 — the conversation-projection pass's LOGIC.
//
// The conformance corpus pins this pass's DIAGNOSTIC CONTRACT byte-for-byte
// (`src/conformance/`); this file asserts the rules themselves — including the
// boundaries a golden cannot express (at the floor vs one below it, folded
// equality vs byte equality) and the deliberate NON-rules that belong to
// `slot-dataflow`.

import { describe, expect, it } from "vitest"

import { CAPABILITY_DEFINITIONS } from "../../capability-definitions/definitions.js"
import {
  generateConversationTriggers,
  MIN_CONVERSATION_TRIGGERS,
  normalizeTriggerPhrasing,
} from "../../capability-definitions/conversation-triggers.js"
import type { CapabilityDefinition } from "../../capability-definitions/types.js"
import { runConversationProjectionPass } from "../passes/conversation-projection.js"
import { normalizeReference } from "../safety-markers.js"
import { normalizeDiacritics } from "../../text-normalization.js"

/** `MIN_CONVERSATION_TRIGGERS` distinct, well-formed phrasings. */
function floorTriggers(prefix = "gatilho"): string[] {
  return Array.from(
    { length: MIN_CONVERSATION_TRIGGERS },
    (_, i) => `${prefix} de teste número ${i + 1}`,
  )
}

function chat(overrides: Record<string, unknown> = {}): CapabilityDefinition {
  return {
    kind: "order.fixture",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "chat",
    surfaces: ["chat"],
    auth: "guest",
    legacyNames: ["fixture"],
    description: "Fixture.",
    conversationTriggers: floorTriggers(),
    guardRefs: [{ phase: "business", name: "executeW5Kinds" }],
    refusalCode: "order.default.deny",
    ...overrides,
  } as unknown as CapabilityDefinition
}

function rules(definitions: readonly CapabilityDefinition[]): string[] {
  return runConversationProjectionPass(definitions).diagnostics.map((d) => d.rule)
}

describe("conversation-projection — coverage floor", () => {
  it("accepts a capability sitting EXACTLY on the floor", () => {
    expect(rules([chat()])).toEqual([])
  })

  it("FAILS one phrasing below the floor", () => {
    const [d] = runConversationProjectionPass([
      chat({ conversationTriggers: floorTriggers().slice(0, -1) }),
    ]).diagnostics
    expect(d).toMatchObject({
      pass: "conversation-projection",
      rule: "insufficient-trigger-coverage",
      field: "conversationTriggers",
      object: "capability:order.fixture",
    })
    expect(d?.message).toContain(String(MIN_CONVERSATION_TRIGGERS))
  })

  it("does NOT apply the floor to a non-chat tier", () => {
    // An identity-tier capability carrying the slot at all is an ORPHAN, and
    // that is slot-dataflow's diagnostic to make — this pass must not pile a
    // second, differently-worded opinion on the same fault.
    expect(rules([chat({ tier: "identity", conversationTriggers: ["um só"] })])).toEqual([])
  })
})

describe("conversation-projection — normal form", () => {
  it.each([
    [" com espaço à esquerda", "leading or trailing whitespace"],
    ["com espaço à direita ", "leading or trailing whitespace"],
    ["com  espaço  duplo", "consecutive whitespace"],
    ["com\tuma tabulação", "control character"],
    ["!!! ???", "no letter or digit"],
  ])("FAILS %j", (bad, because) => {
    const [d] = runConversationProjectionPass([
      chat({ conversationTriggers: [...floorTriggers(), bad] }),
    ]).diagnostics
    expect(d).toMatchObject({ rule: "malformed-trigger-phrasing", reference: bad })
    expect(d?.message).toContain(because)
  })

  it("ACCEPTS uppercase — an authored example is mirrored verbatim", () => {
    // `aplica o cupom PROMO10` is mirrored from the authored extraction
    // schema. A lowercase-only rule would force a fork between the catalog's
    // copy and the schema's, which is the drift the mirror exists to prevent.
    expect(rules([chat({ conversationTriggers: [...floorTriggers(), "aplica o cupom PROMO10"] })]))
      .toEqual([])
  })

  it("ACCEPTS interrogatives and internal punctuation", () => {
    expect(
      rules([
        chat({
          conversationTriggers: [...floorTriggers(), "dá pra usar um cupom?", "fecha o pedido, por favor"],
        }),
      ]),
    ).toEqual([])
  })
})

describe("conversation-projection — duplicates within one capability", () => {
  it("FAILS on two phrasings differing only by case, accent and punctuation", () => {
    const [d] = runConversationProjectionPass([
      chat({ conversationTriggers: [...floorTriggers(), "Gatilho De Teste Número 1!"] }),
    ]).diagnostics
    expect(d).toMatchObject({
      rule: "duplicate-trigger-phrasing",
      field: `conversationTriggers[${MIN_CONVERSATION_TRIGGERS}]`,
    })
    // Names the earlier position, so the pair is findable from one line.
    expect(d?.message).toContain("conversationTriggers[0]")
  })
})

describe("conversation-projection — cross-capability collisions", () => {
  it("FAILS when two capabilities claim one phrasing, naming BOTH", () => {
    const shared = "tira a coca"
    const [d] = runConversationProjectionPass([
      chat({ kind: "order.item.remove", conversationTriggers: [...floorTriggers("a"), shared] }),
      chat({ kind: "order.amend.remove_item", conversationTriggers: [...floorTriggers("b"), shared] }),
    ]).diagnostics
    expect(d).toMatchObject({
      rule: "cross-capability-trigger-collision",
      object: "capability:order.amend.remove_item",
      reference: "capability:order.item.remove",
    })
  })

  it("collides under the NORMAL FORM, not just on identical bytes", () => {
    expect(
      rules([
        chat({ kind: "a", conversationTriggers: [...floorTriggers("a"), "tira a coca"] }),
        chat({ kind: "b", conversationTriggers: [...floorTriggers("b"), "Tira a Coça!"] }),
      ]),
    ).toEqual(["cross-capability-trigger-collision"])
  })

  it("emits ONE diagnostic per collision, not one per participant", () => {
    expect(
      rules([
        chat({ kind: "a", conversationTriggers: [...floorTriggers("a"), "mesma frase"] }),
        chat({ kind: "b", conversationTriggers: [...floorTriggers("b"), "mesma frase"] }),
        chat({ kind: "c", conversationTriggers: [...floorTriggers("c"), "mesma frase"] }),
      ]),
    ).toEqual([
      "cross-capability-trigger-collision",
      "cross-capability-trigger-collision",
    ])
  })

  it("does NOT flag one capability reusing its own phrasing across a re-run", () => {
    // The claim map is per-RUN, not module state: compiling the same catalog
    // twice must not accumulate ownership.
    const catalog = [chat()]
    expect(rules(catalog)).toEqual([])
    expect(rules(catalog)).toEqual([])
  })
})

describe("conversation-projection — structural faults belong to slot-dataflow", () => {
  it.each([
    ["absent", undefined],
    ["not an array", "quero uma coca"],
    ["an empty array", []],
  ])("stays silent when the slot is %s", (_label, value) => {
    // Not "accepts": these are real faults, reported by slot-dataflow as
    // missing-required-slot / slot-type-mismatch. This pass must not
    // double-report them. (An empty array is BELOW the floor, so it is the one
    // case that legitimately produces this pass's own coverage diagnostic.)
    const emitted = rules([chat({ conversationTriggers: value })])
    expect(emitted.every((r) => r === "insufficient-trigger-coverage")).toBe(true)
  })
})

describe("conversation-projection — the real catalog is the control", () => {
  it("passes clean", () => {
    expect(runConversationProjectionPass(CAPABILITY_DEFINITIONS).diagnostics).toEqual([])
  })

  it("inspected every authored phrasing (a vacuous gate is not a gate)", () => {
    const projection = generateConversationTriggers(CAPABILITY_DEFINITIONS)
    const authored = Object.values(projection).reduce((n, t) => n + t.length, 0)
    expect(runConversationProjectionPass(CAPABILITY_DEFINITIONS).checked).toBe(authored)
    expect(authored).toBeGreaterThan(100)
  })

  it("covers EVERY chat-tier capability, and only those", () => {
    const chatKinds = CAPABILITY_DEFINITIONS.filter((d) => d.tier === "chat").map((d) => d.kind)
    expect(Object.keys(generateConversationTriggers(CAPABILITY_DEFINITIONS)).sort()).toEqual(
      [...chatKinds].sort(),
    )
  })

  it("clears the floor on every capability, with room to spare", () => {
    for (const [kind, triggers] of Object.entries(
      generateConversationTriggers(CAPABILITY_DEFINITIONS),
    )) {
      expect(
        triggers.length,
        `${kind} carries ${triggers.length} phrasing(s)`,
      ).toBeGreaterThanOrEqual(MIN_CONVERSATION_TRIGGERS);
    }
  })
})

describe("normalizeTriggerPhrasing", () => {
  it.each([
    ["Tira a Coca!", "tira a coca"],
    ["tira  a   coca", "tira a coca"],
    ["TIRA A COÇA", "tira a coca"],
    ["  tira a coca.  ", "tira a coca"],
    ["não quero mais", "nao quero mais"],
    ["cupom PROMO10", "cupom promo10"],
  ])("folds %j to %j", (input, expected) => {
    expect(normalizeTriggerPhrasing(input)).toBe(expected)
  })

  it("is idempotent", () => {
    const once = normalizeTriggerPhrasing("Tira a Coça!  ")
    expect(normalizeTriggerPhrasing(once)).toBe(once)
  })

  it("shares its accent/case fold with the compiler's normalizeReference", () => {
    // There is ONE `normalizeDiacritics` in this package and both normalizers
    // compose it (`../../text-normalization.ts`). This pins that: a future
    // edit that re-inlines the fold in either caller — and lets the two drift
    // on what "é === e" means — fails here rather than silently.
    for (const word of ["Glúten", "COÇA", "João", "Alérgenos", "Ação"]) {
      const folded = normalizeDiacritics(word)
      expect(normalizeTriggerPhrasing(word)).toBe(folded)
      expect(normalizeReference(word)).toBe(folded)
    }
  })

  it("the two normalizers still differ where they MUST — the separator tail", () => {
    // Shared head, different tails, on purpose: identifier space folds
    // separators to `_` so a marker matches a whole segment; prose space folds
    // punctuation to spaces so words stay words. Collapsing them would break
    // one of the two callers.
    expect(normalizeReference("sem-gluten lactose")).toBe("sem_gluten_lactose")
    expect(normalizeTriggerPhrasing("sem-gluten lactose")).toBe("sem gluten lactose")
  })
})
