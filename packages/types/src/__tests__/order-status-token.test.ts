// BKL-150(b) — normalizeOrderStatusToken: the single-source canonicalizer that
// maps en-GB / pt-BR aliases of the fulfillment-status tokens onto the en-US
// enum the strict kernel guard reads, and leaves an unknown token verbatim so
// the guard still fails closed. Called only from the ops resolver's
// order.status.transition branch; the guard itself does no normalization.

import { describe, it, expect } from "vitest"
import { normalizeOrderStatusToken, isKnownOrderStatus } from "../order-status.js"

describe("normalizeOrderStatusToken", () => {
  it("maps the en-GB spelling 'cancelled' → 'canceled' (the headline defect)", () => {
    expect(normalizeOrderStatusToken("cancelled")).toBe("canceled")
    expect(normalizeOrderStatusToken("Cancelled")).toBe("canceled")
    expect(normalizeOrderStatusToken("  CANCELLED  ")).toBe("canceled")
  })

  it("maps the pt-BR aliases the persona teaches → the en-US enum", () => {
    expect(normalizeOrderStatusToken("cancelado")).toBe("canceled")
    expect(normalizeOrderStatusToken("cancelar")).toBe("canceled")
    expect(normalizeOrderStatusToken("confirmado")).toBe("confirmed")
    expect(normalizeOrderStatusToken("confirmar")).toBe("confirmed")
    expect(normalizeOrderStatusToken("preparando")).toBe("preparing")
    expect(normalizeOrderStatusToken("pronto")).toBe("ready")
    expect(normalizeOrderStatusToken("entregue")).toBe("delivered")
    expect(normalizeOrderStatusToken("em entrega")).toBe("in_delivery")
    expect(normalizeOrderStatusToken("em_entrega")).toBe("in_delivery")
  })

  it("is diacritic / case / whitespace insensitive on aliases", () => {
    expect(normalizeOrderStatusToken("Cancelado")).toBe("canceled")
    expect(normalizeOrderStatusToken("PRONTO")).toBe("ready")
    expect(normalizeOrderStatusToken("  em   entrega ")).toBe("in_delivery")
  })

  it("passes an already-canonical enum token through unchanged (normalizing casing)", () => {
    for (const s of ["confirmed", "preparing", "ready", "in_delivery", "delivered", "canceled"]) {
      expect(normalizeOrderStatusToken(s)).toBe(s)
    }
    expect(normalizeOrderStatusToken("Ready")).toBe("ready")
  })

  it("returns a GENUINELY UNKNOWN token verbatim (the strict guard still fails closed)", () => {
    // Not an enum value, not a known alias — must NOT be invented into a valid one.
    expect(normalizeOrderStatusToken("frobnicate")).toBe("frobnicate")
    expect(normalizeOrderStatusToken("entregando")).toBe("entregando") // not a listed alias
    expect(isKnownOrderStatus(normalizeOrderStatusToken("frobnicate"))).toBe(false)
  })

  it("every alias maps to a value the enum recognizes (no alias can point off-enum)", () => {
    for (const alias of ["cancelled", "cancelado", "pronto", "entregue", "em entrega"]) {
      expect(isKnownOrderStatus(normalizeOrderStatusToken(alias))).toBe(true)
    }
  })
})
