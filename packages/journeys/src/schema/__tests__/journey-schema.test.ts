// Tests for schema/journey.ts — JourneyFileSchema v1 + named-error mapping.
import { describe, it, expect } from "vitest"

import {
  JourneyFileSchema,
  JOURNEY_EXPECT_DECISIONS,
  validateJourney,
  type JourneySchemaError,
} from "../journey.js"

/** A fully valid journey document (the baseline every bad-case mutates). */
function validDoc(): Record<string, unknown> {
  return {
    id: "JOURNEY-001",
    title: "Authenticated customer places and cancels an order",
    businessCase: "Checkout and cancel are the revenue-critical paths.",
    persona: "Cliente autenticado que quer jantar costela no sábado.",
    channel: "web",
    status: "active",
    blocked_by: [],
    source: "docs/agents/plan-v2.md §5 T1a-12",
    params: { productHandle: "costela-bovina-defumada" },
    acts: [
      { kind: "fixture", seed: "seedCustomer", params: { phone: "+5511999990001" } },
      { kind: "chat", goal: "Montar um pedido e finalizar o checkout." },
      { kind: "http", method: "GET", path: "/api/me", asRole: "customer" },
    ],
    expects: [
      { intentKind: "order.checkout.create", decision: "EXECUTE" },
      { intentKind: "order.cancel", decision: "EXECUTE" },
    ],
    verify: [{ invariant: "order.goal-state", args: { status: "canceled" } }],
  }
}

function codesOf(data: unknown): string[] {
  const result = validateJourney(data)
  if (result.ok) return []
  return result.errors.map((e) => e.code)
}

describe("JourneyFileSchema — valid documents", () => {
  it("accepts a fully valid journey", () => {
    const result = validateJourney(validDoc())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.journey.id).toBe("JOURNEY-001")
      expect(result.journey.acts).toHaveLength(3)
      expect(result.journey.blocked_by).toEqual([])
    }
  })

  it("accepts a blocked journey with blocked_by reasons", () => {
    const doc = {
      ...validDoc(),
      id: "JOURNEY-003",
      status: "blocked",
      blocked_by: ["handoff-port-noop", "chat-confirmation-resume"],
    }
    expect(validateJourney(doc).ok).toBe(true)
  })

  it("accepts every kernel decision kind in expects", () => {
    for (const decision of JOURNEY_EXPECT_DECISIONS) {
      const doc = {
        ...validDoc(),
        expects: [{ intentKind: "order.checkout.create", decision }],
      }
      expect(validateJourney(doc).ok).toBe(true)
    }
  })

  it("defaults blocked_by to [] when omitted", () => {
    const doc = validDoc()
    delete doc.blocked_by
    const result = validateJourney(doc)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.journey.blocked_by).toEqual([])
  })
})

describe("JourneyFileSchema — named errors", () => {
  it("rejects a bad decision enum with invalid_decision", () => {
    const doc = {
      ...validDoc(),
      expects: [{ intentKind: "order.checkout.create", decision: "ALLOW" }],
    }
    expect(codesOf(doc)).toContain("invalid_decision")
  })

  it("rejects an unknown act kind with unknown_act_kind", () => {
    const doc = {
      ...validDoc(),
      acts: [{ kind: "nats", subject: "order.placed" }],
    }
    expect(codesOf(doc)).toContain("unknown_act_kind")
  })

  it("rejects a raw prod_ id in act params with raw_medusa_id", () => {
    const doc = {
      ...validDoc(),
      acts: [
        { kind: "fixture", seed: "seedCart", params: { product: "prod_01HXYZABCDEF" } },
        { kind: "chat", goal: "Continuar o pedido." },
      ],
    }
    expect(codesOf(doc)).toContain("raw_medusa_id")
  })

  it("rejects variant_/cart_ ids nested deep in journey params", () => {
    // Realistic id tails (Medusa ids are 26-char ULIDs; the pattern requires
    // ≥8 alphanumerics after the underscore — T1a-13 sharpening).
    const byVariant = {
      ...validDoc(),
      params: { nested: { list: ["variant_01HXYZABCDEF"] } },
    }
    expect(codesOf(byVariant)).toContain("raw_medusa_id")

    const byCartKey = { ...validDoc(), params: { cart_01HXYZABCDEF: true } }
    expect(codesOf(byCartKey)).toContain("raw_medusa_id")
  })

  it("does NOT flag API field NAMES like variant_id / cart_id (T1a-13)", () => {
    // The storefront line-items route's body field is literally `variant_id`
    // — a field name, not an id literal. The ≥8-alphanumeric tail keeps the
    // lint hot for ids while letting these through.
    const doc = {
      ...validDoc(),
      acts: [
        {
          kind: "http",
          method: "POST",
          path: "/api/cart/:cartId/line-items",
          asRole: "customer",
          body: { variant_id: ":variantId", quantity: 1 },
        },
        { kind: "chat", goal: "Continuar o pedido." },
      ],
    }
    expect(codesOf(doc)).not.toContain("raw_medusa_id")
  })

  it("does NOT flag handles or words merely containing 'cart'", () => {
    const doc = {
      ...validDoc(),
      params: {
        productHandle: "costela-bovina-defumada",
        text: "adicione ao carrinho a costela", // 'cart' substring but no id literal
        shoppingcart_note: "ok", // prefixed — not a raw id boundary
      },
    }
    expect(validateJourney(doc).ok).toBe(true)
  })

  it("rejects a malformed id with invalid_journey_id", () => {
    expect(codesOf({ ...validDoc(), id: "JOURNEY-1" })).toContain("invalid_journey_id")
    expect(codesOf({ ...validDoc(), id: "J-001" })).toContain("invalid_journey_id")
  })

  it("rejects an unknown channel with invalid_channel", () => {
    expect(codesOf({ ...validDoc(), channel: "telegram" })).toContain("invalid_channel")
  })

  it("rejects blocked without blocked_by (blocked_without_reason)", () => {
    const doc = { ...validDoc(), status: "blocked", blocked_by: [] }
    expect(codesOf(doc)).toContain("blocked_without_reason")
  })

  it("rejects active with blockers (active_with_blockers)", () => {
    const doc = { ...validDoc(), status: "active", blocked_by: ["ws4"] }
    expect(codesOf(doc)).toContain("active_with_blockers")
  })

  it("rejects a chat act with neither utterance nor goal", () => {
    const doc = { ...validDoc(), acts: [{ kind: "chat" }] }
    expect(codesOf(doc)).toContain("chat_act_missing_text")
  })

  it("rejects a malformed intentKind shape", () => {
    const doc = {
      ...validDoc(),
      expects: [{ intentKind: "OrderCheckout", decision: "EXECUTE" }],
    }
    const result = validateJourney(doc)
    expect(result.ok).toBe(false)
  })

  it("rejects unknown top-level keys (strict mode catches YAML typos)", () => {
    const doc = { ...validDoc(), expcts: [] }
    expect(validateJourney(doc).ok).toBe(false)
  })

  it("rejects empty acts", () => {
    expect(validateJourney({ ...validDoc(), acts: [] }).ok).toBe(false)
  })

  it("names errors with path strings", () => {
    const result = validateJourney({
      ...validDoc(),
      expects: [{ intentKind: "order.checkout.create", decision: "ALLOW" }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const err = result.errors.find((e: JourneySchemaError) => e.code === "invalid_decision")
      expect(err?.path).toBe("expects.0.decision")
    }
  })

  it("safeParse surface stays available for raw zod consumers", () => {
    expect(JourneyFileSchema.safeParse(validDoc()).success).toBe(true)
  })
})
