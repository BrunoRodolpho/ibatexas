// Unit tests for Zod schemas — validate edge cases and error messages

import { describe, it, expect } from "vitest"
import {
  CheckAvailabilityInputSchema,
  CreateReservationInputSchema,
  ModifyReservationInputSchema,
  CancelReservationInputSchema,
  GetMyReservationsInputSchema,
  JoinWaitlistInputSchema,
  SpecialRequestSchema,
  SpecialRequestType,
  ReservationStatus,
} from "../reservation.types.js"
import { SearchProductsInputSchema as ProductSearchSchema } from "../product.types.js"

// ── SearchProductsInputSchema ─────────────────────────────────────────────────

describe("SearchProductsInputSchema (product)", () => {
  it("accepts valid query", () => {
    const result = ProductSearchSchema.safeParse({ query: "costela" })
    expect(result.success).toBe(true)
  })

  it("accepts valid queries array", () => {
    const result = ProductSearchSchema.safeParse({ queries: ["costela", "brisket"] })
    expect(result.success).toBe(true)
  })

  it("rejects when both query and queries are missing", () => {
    const result = ProductSearchSchema.safeParse({ tags: ["popular"] })
    expect(result.success).toBe(false)
  })

  it("rejects query exceeding 200 chars", () => {
    const result = ProductSearchSchema.safeParse({ query: "a".repeat(201) })
    expect(result.success).toBe(false)
  })

  it("rejects queries array with more than 5 items", () => {
    const result = ProductSearchSchema.safeParse({
      queries: ["a", "b", "c", "d", "e", "f"],
    })
    expect(result.success).toBe(false)
  })

  it("accepts productType filter", () => {
    const result = ProductSearchSchema.safeParse({
      query: "camiseta",
      productType: "merchandise",
    })
    expect(result.success).toBe(true)
  })

  it("rejects invalid productType", () => {
    const result = ProductSearchSchema.safeParse({
      query: "camiseta",
      productType: "invalid",
    })
    expect(result.success).toBe(false)
  })

  it("applies limit constraints", () => {
    const tooHigh = ProductSearchSchema.safeParse({ query: "x", limit: 21 })
    expect(tooHigh.success).toBe(false)

    const tooLow = ProductSearchSchema.safeParse({ query: "x", limit: 0 })
    expect(tooLow.success).toBe(false)
  })
})

// ── CheckAvailabilityInputSchema ──────────────────────────────────────────────

describe("CheckAvailabilityInputSchema", () => {
  it("accepts valid date and partySize", () => {
    const result = CheckAvailabilityInputSchema.safeParse({
      date: "2026-01-15",
      partySize: 4,
    })
    expect(result.success).toBe(true)
  })

  it("rejects invalid date format", () => {
    const result = CheckAvailabilityInputSchema.safeParse({
      date: "15/01/2026",
      partySize: 4,
    })
    expect(result.success).toBe(false)
  })

  it("rejects partySize of 0", () => {
    const result = CheckAvailabilityInputSchema.safeParse({
      date: "2026-01-15",
      partySize: 0,
    })
    expect(result.success).toBe(false)
  })

  it("rejects partySize > 20", () => {
    const result = CheckAvailabilityInputSchema.safeParse({
      date: "2026-01-15",
      partySize: 21,
    })
    expect(result.success).toBe(false)
  })

  it("accepts optional preferredTime", () => {
    const result = CheckAvailabilityInputSchema.safeParse({
      date: "2026-01-15",
      partySize: 4,
      preferredTime: "19:30",
    })
    expect(result.success).toBe(true)
  })

  it("rejects malformed preferredTime", () => {
    const result = CheckAvailabilityInputSchema.safeParse({
      date: "2026-01-15",
      partySize: 4,
      preferredTime: "7:30 PM",
    })
    expect(result.success).toBe(false)
  })
})

// ── CreateReservationInputSchema ──────────────────────────────────────────────

describe("CreateReservationInputSchema", () => {
  it("accepts valid input with defaults", () => {
    const result = CreateReservationInputSchema.safeParse({
      customerId: "cust_01",
      timeSlotId: "slot_01",
      partySize: 4,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.specialRequests).toEqual([])  // default
    }
  })

  it("accepts specialRequests", () => {
    const result = CreateReservationInputSchema.safeParse({
      customerId: "cust_01",
      timeSlotId: "slot_01",
      partySize: 4,
      specialRequests: [{ type: "birthday" }],
    })
    expect(result.success).toBe(true)
  })

  it("rejects missing customerId", () => {
    const result = CreateReservationInputSchema.safeParse({
      timeSlotId: "slot_01",
      partySize: 4,
    })
    expect(result.success).toBe(false)
  })
})

// ── ModifyReservationInputSchema ──────────────────────────────────────────────

describe("ModifyReservationInputSchema", () => {
  it("accepts reservationId + optional changes", () => {
    const result = ModifyReservationInputSchema.safeParse({
      customerId: "cust_01",
      reservationId: "res_01",
      newPartySize: 6,
    })
    expect(result.success).toBe(true)
  })

  it("accepts without changes (no-op update)", () => {
    const result = ModifyReservationInputSchema.safeParse({
      customerId: "cust_01",
      reservationId: "res_01",
    })
    expect(result.success).toBe(true)
  })
})

// ── CancelReservationInputSchema ──────────────────────────────────────────────

describe("CancelReservationInputSchema", () => {
  it("accepts valid cancellation without reason", () => {
    const result = CancelReservationInputSchema.safeParse({
      customerId: "cust_01",
      reservationId: "res_01",
    })
    expect(result.success).toBe(true)
  })

  it("accepts cancellation with reason", () => {
    const result = CancelReservationInputSchema.safeParse({
      customerId: "cust_01",
      reservationId: "res_01",
      reason: "Mudança de planos",
    })
    expect(result.success).toBe(true)
  })

  it("rejects reason > 200 chars", () => {
    const result = CancelReservationInputSchema.safeParse({
      customerId: "cust_01",
      reservationId: "res_01",
      reason: "a".repeat(201),
    })
    expect(result.success).toBe(false)
  })
})

// ── GetMyReservationsInputSchema ──────────────────────────────────────────────

describe("GetMyReservationsInputSchema", () => {
  it("accepts with optional status filter", () => {
    const result = GetMyReservationsInputSchema.safeParse({
      customerId: "cust_01",
      status: ReservationStatus.CONFIRMED,
    })
    expect(result.success).toBe(true)
  })

  it("applies default limit of 10", () => {
    const result = GetMyReservationsInputSchema.safeParse({
      customerId: "cust_01",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.limit).toBe(10)
    }
  })

  it("rejects limit > 50", () => {
    const result = GetMyReservationsInputSchema.safeParse({
      customerId: "cust_01",
      limit: 51,
    })
    expect(result.success).toBe(false)
  })
})

// ── JoinWaitlistInputSchema ───────────────────────────────────────────────────

describe("JoinWaitlistInputSchema", () => {
  it("accepts valid waitlist input", () => {
    const result = JoinWaitlistInputSchema.safeParse({
      customerId: "cust_01",
      timeSlotId: "slot_01",
      partySize: 4,
    })
    expect(result.success).toBe(true)
  })

  it("rejects partySize 0", () => {
    const result = JoinWaitlistInputSchema.safeParse({
      customerId: "cust_01",
      timeSlotId: "slot_01",
      partySize: 0,
    })
    expect(result.success).toBe(false)
  })
})

// ── SpecialRequestSchema ──────────────────────────────────────────────────────

describe("SpecialRequestSchema", () => {
  it("accepts valid request type", () => {
    const result = SpecialRequestSchema.safeParse({
      type: SpecialRequestType.BIRTHDAY,
    })
    expect(result.success).toBe(true)
  })

  it("accepts optional notes", () => {
    const result = SpecialRequestSchema.safeParse({
      type: SpecialRequestType.ALLERGY_WARNING,
      notes: "Alergia grave a camarão",
    })
    expect(result.success).toBe(true)
  })

  it("rejects notes > 200 chars", () => {
    const result = SpecialRequestSchema.safeParse({
      type: SpecialRequestType.OTHER,
      notes: "a".repeat(201),
    })
    expect(result.success).toBe(false)
  })

  it("rejects invalid type", () => {
    const result = SpecialRequestSchema.safeParse({
      type: "invalid_type",
    })
    expect(result.success).toBe(false)
  })
})
