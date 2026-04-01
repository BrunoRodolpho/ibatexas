// Unit tests for the IbateXas system prompt — verify intelligence tool coverage
// and prompt synthesizer outputs for key states.

import { describe, it, expect } from "vitest"

import { SYSTEM_PROMPT } from "../system-prompt.js"
import { synthesizePrompt } from "../prompt-synthesizer.js"
import type { OrderContext } from "../machine/types.js"
import { createDefaultContext } from "../machine/order-machine.js"

describe("SYSTEM_PROMPT", () => {
  it("includes intelligence tools section", () => {
    expect(SYSTEM_PROMPT).toContain("get_customer_profile")
    expect(SYSTEM_PROMPT).toContain("get_recommendations")
  })

  it("includes all 5 intelligence tool names", () => {
    expect(SYSTEM_PROMPT).toContain("get_customer_profile")
    expect(SYSTEM_PROMPT).toContain("get_recommendations")
    expect(SYSTEM_PROMPT).toContain("get_ordered_together")
    expect(SYSTEM_PROMPT).toContain("get_also_added")
    expect(SYSTEM_PROMPT).toContain("update_preferences")
  })
})

describe("synthesizePrompt", () => {
  function buildTestContext(overrides: Partial<OrderContext> = {}): OrderContext {
    const base = createDefaultContext("whatsapp", null)
    return {
      ...base,
      items: [{ productId: "p1", variantId: "v1", name: "Costela 1kg", quantity: 1, priceInCentavos: 13500, category: "meat" }],
      totalInCentavos: 13500,
      ...overrides,
    }
  }

  it("ordering.awaiting_next prompt contains upsell suggestion when main dish present and missing side/drink", () => {
    const ctx = buildTestContext({ hasMainDish: true, hasSide: false, hasDrink: false })
    const result = synthesizePrompt("ordering.awaiting_next", ctx, "whatsapp")
    expect(result.systemPrompt).toContain("Farofa")
    expect(result.systemPrompt).toContain("Refri")
  })

  it("ordering.awaiting_next maxTokens is momentum-adjusted on WhatsApp", () => {
    // Default momentum is "high" → 0.7x multiplier: 768 * 0.7 = 538
    const ctx = buildTestContext({ hasMainDish: true, hasSide: false, hasDrink: false })
    const result = synthesizePrompt("ordering.awaiting_next", ctx, "whatsapp")
    expect(result.maxTokens).toBe(Math.round(768 * 0.7))

    // With "cooling" momentum → 1.0x multiplier: 768
    const ctxCooling = buildTestContext({ hasMainDish: true, hasSide: false, hasDrink: false, momentum: "cooling" })
    const resultCooling = synthesizePrompt("ordering.awaiting_next", ctxCooling, "whatsapp")
    expect(resultCooling.maxTokens).toBe(768)

    // With "lost" momentum → 1.2x multiplier: 768 * 1.2 = 922
    const ctxLost = buildTestContext({ hasMainDish: true, hasSide: false, hasDrink: false, momentum: "lost" })
    const resultLost = synthesizePrompt("ordering.awaiting_next", ctxLost, "whatsapp")
    expect(resultLost.maxTokens).toBe(Math.round(768 * 1.2))
  })

  it("checkout.confirming prompt contains anti-hallucination instruction", () => {
    const ctx = buildTestContext({
      fulfillment: "pickup",
      paymentMethod: "pix",
    })
    const result = synthesizePrompt("checkout.confirming", ctx, "whatsapp")
    expect(result.systemPrompt).toContain("NUNCA gere número de pedido")
    expect(result.systemPrompt).toContain("AINDA NÃO foi enviado")
  })

  it("checkout.order_placed with null orderId returns error prompt", () => {
    const ctx = buildTestContext({
      orderId: null as unknown as string,
      checkoutResult: null,
    })
    const result = synthesizePrompt("checkout.order_placed", ctx, "whatsapp")
    expect(result.systemPrompt).toContain("ERRO INTERNO")
    expect(result.systemPrompt).toContain("problema técnico")
  })

  it("post_order with null orderId returns guard prompt", () => {
    const ctx = buildTestContext({
      orderId: null as unknown as string,
      checkoutResult: null,
      pendingProduct: null,
    })
    const result = synthesizePrompt("post_order", ctx, "whatsapp")
    expect(result.systemPrompt).toContain("Nenhum pedido foi finalizado")
  })
})
