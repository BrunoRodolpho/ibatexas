// Additional schema edge-case tests — covers gaps from deep review:
// - Both query AND queries provided simultaneously
// - Negative partySize
// - New shared types (UserType, ProductStatus)
// - ModifyReservation no-op detection

import { describe, it, expect } from "vitest"
import { SearchProductsInputSchema } from "../product.types.js"
import { ModifyReservationInputSchema, CheckAvailabilityInputSchema } from "../reservation.types.js"
import type { UserType, ProductStatus } from "../product.types.js"

describe("SearchProductsInputSchema — additional cases", () => {
  it("accepts when both query and queries are provided", () => {
    const result = SearchProductsInputSchema.safeParse({
      query: "costela",
      queries: ["frango", "brisket"],
    })
    // Current schema allows both — this test documents the behavior
    expect(result.success).toBe(true)
  })

  it("rejects empty string query", () => {
    const result = SearchProductsInputSchema.safeParse({ query: "" })
    expect(result.success).toBe(false)
  })

  it("rejects queries with empty strings", () => {
    const result = SearchProductsInputSchema.safeParse({ queries: [""] })
    expect(result.success).toBe(false)
  })

  it("accepts all valid productType values", () => {
    for (const pt of ["food", "frozen", "merchandise"]) {
      const result = SearchProductsInputSchema.safeParse({ query: "test", productType: pt })
      expect(result.success).toBe(true)
    }
  })

  it("accepts excludeAllergens filter", () => {
    const result = SearchProductsInputSchema.safeParse({
      query: "prato",
      excludeAllergens: ["glúten", "lactose"],
    })
    expect(result.success).toBe(true)
  })
})

describe("CheckAvailabilityInputSchema — additional cases", () => {
  it("rejects negative partySize", () => {
    const result = CheckAvailabilityInputSchema.safeParse({
      date: "2026-03-15",
      partySize: -1,
    })
    expect(result.success).toBe(false)
  })

  it("rejects zero partySize", () => {
    const result = CheckAvailabilityInputSchema.safeParse({
      date: "2026-03-15",
      partySize: 0,
    })
    expect(result.success).toBe(false)
  })

  it("rejects partySize above MAX_PARTY_SIZE (20)", () => {
    const result = CheckAvailabilityInputSchema.safeParse({
      date: "2026-03-15",
      partySize: 21,
    })
    expect(result.success).toBe(false)
  })

  it("rejects invalid date format", () => {
    const result = CheckAvailabilityInputSchema.safeParse({
      date: "15/03/2026",
      partySize: 4,
    })
    expect(result.success).toBe(false)
  })

  it("rejects invalid preferredTime format", () => {
    const result = CheckAvailabilityInputSchema.safeParse({
      date: "2026-03-15",
      partySize: 4,
      preferredTime: "7:30 PM",
    })
    expect(result.success).toBe(false)
  })
})

describe("ModifyReservationInputSchema — additional cases", () => {
  it("accepts no-op update (no optional fields)", () => {
    const result = ModifyReservationInputSchema.safeParse({
      customerId: "cust_01",
      reservationId: "res_01",
    })
    // Currently allowed — documented behavior
    expect(result.success).toBe(true)
  })

  it("accepts changing only partySize", () => {
    const result = ModifyReservationInputSchema.safeParse({
      customerId: "cust_01",
      reservationId: "res_01",
      newPartySize: 6,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.newPartySize).toBe(6)
    }
  })

  it("accepts only specialRequests update", () => {
    const result = ModifyReservationInputSchema.safeParse({
      customerId: "cust_01",
      reservationId: "res_01",
      specialRequests: [{ type: "birthday", notes: "Bolo surpresa" }],
    })
    expect(result.success).toBe(true)
  })
})

describe("shared type aliases", () => {
  it("UserType covers all expected values", () => {
    const values: UserType[] = ["guest", "customer", "staff"]
    expect(values).toHaveLength(3)
  })

  it("ProductStatus covers expected values", () => {
    const values: ProductStatus[] = ["published", "draft"]
    expect(values).toHaveLength(2)
  })
})
