import { describe, expect, it } from "vitest"
import { isKnownBasisCode } from "@ibx/intent-core"
import {
  validateBufferedTextTyped,
  validateBufferedText,
} from "../validation-layer.js"

describe("Phase E — validateBufferedTextTyped (first REWRITE user)", () => {
  it("returns PASS for clean text", () => {
    const outcome = validateBufferedTextTyped(
      "Você quer mais alguma coisa?",
      "ordering.awaiting_next",
    )
    expect(outcome.kind).toBe("PASS")
    if (outcome.kind !== "PASS") return
    expect(outcome.text).toBe("Você quer mais alguma coisa?")
  })

  it("returns REWRITE when a forbidden phrase is stripped", () => {
    const outcome = validateBufferedTextTyped(
      "Pedido confirmado! Vou encaminhar agora.",
      "checkout.confirming",
    )
    expect(outcome.kind).toBe("REWRITE")
    if (outcome.kind !== "REWRITE") return
    expect(outcome.rewritten).not.toMatch(/pedido confirmado/i)
    expect(outcome.rewritten).not.toMatch(/vou encaminhar/i)
  })

  it("REWRITE basis uses a known validation code", () => {
    const outcome = validateBufferedTextTyped(
      "Pedido cancelado.",
      "post_order.idle",
    )
    if (outcome.kind !== "REWRITE") throw new Error("expected REWRITE")
    for (const b of outcome.basis) {
      expect(isKnownBasisCode(b)).toBe(true)
      expect(b.category).toBe("validation")
    }
  })

  it("REWRITE basis detail captures the state and pattern (audit-ready)", () => {
    const outcome = validateBufferedTextTyped(
      "Pedido finalizado.",
      "checkout.confirming",
    )
    if (outcome.kind !== "REWRITE") throw new Error("expected REWRITE")
    const firstBasis = outcome.basis[0]!
    expect(firstBasis.detail).toMatchObject({
      stateValue: "checkout.confirming",
    })
    expect((firstBasis.detail as Record<string, unknown>).match).toBeTypeOf(
      "string",
    )
  })

  it("legacy validateBufferedText shape still works for backward-compat callers", () => {
    const r = validateBufferedText(
      "Pedido confirmado.",
      "checkout.confirming",
    )
    expect(r.violations.length).toBeGreaterThan(0)
    expect(r.cleanText).not.toMatch(/pedido confirmado/i)
  })
})
