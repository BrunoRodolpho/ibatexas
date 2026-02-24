// Tests for join_waitlist tool
// Mock-based; no database required.
//
// Scenarios:
// - Slot not found → throws
// - Customer already on waitlist → returns existing position (idempotent)
// - Happy path → creates entry, returns position
// - Position is derived from count query

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockTimeSlotFindUnique = vi.hoisted(() => vi.fn())
const mockWaitlistFindFirst = vi.hoisted(() => vi.fn())
const mockWaitlistCreate = vi.hoisted(() => vi.fn())
const mockWaitlistCount = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    timeSlot: { findUnique: mockTimeSlotFindUnique },
    waitlist: {
      findFirst: mockWaitlistFindFirst,
      create: mockWaitlistCreate,
      count: mockWaitlistCount,
    },
  },
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import { joinWaitlist } from "../join-waitlist.js"

// ── Fixtures ───────────────────────────────────────────────────────────────────

const SLOT = {
  id: "ts_01",
  date: new Date("2026-03-15T00:00:00.000Z"),
  startTime: "19:30",
  durationMinutes: 90,
  maxCovers: 10,
  reservedCovers: 10, // fully booked
  createdAt: new Date(),
}

const BASE_INPUT = {
  customerId: "cus_01",
  timeSlotId: "ts_01",
  partySize: 2,
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("joinWaitlist", () => {
  beforeEach(() => vi.clearAllMocks())

  it("throws when time slot does not exist", async () => {
    mockTimeSlotFindUnique.mockResolvedValue(null)

    await expect(joinWaitlist(BASE_INPUT)).rejects.toThrow("Horário não encontrado")
  })

  it("returns existing position when customer is already on the waitlist", async () => {
    mockTimeSlotFindUnique.mockResolvedValue(SLOT)
    const existingEntry = {
      id: "wl_01",
      customerId: "cus_01",
      timeSlotId: "ts_01",
      partySize: 2,
      createdAt: new Date(),
      notifiedAt: null,
      expiresAt: new Date(Date.now() + 3600_000),
    }
    mockWaitlistFindFirst.mockResolvedValue(existingEntry)
    mockWaitlistCount.mockResolvedValue(2) // position = 2

    const result = await joinWaitlist(BASE_INPUT)

    expect(result.waitlistId).toBe("wl_01")
    expect(result.position).toBe(2)
    expect(result.message).toContain("já está")
    expect(mockWaitlistCreate).not.toHaveBeenCalled()
  })

  it("creates a new waitlist entry on happy path", async () => {
    mockTimeSlotFindUnique.mockResolvedValue(SLOT)
    mockWaitlistFindFirst.mockResolvedValue(null)
    const newEntry = {
      id: "wl_02",
      customerId: "cus_01",
      timeSlotId: "ts_01",
      partySize: 2,
      createdAt: new Date(),
      notifiedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    }
    mockWaitlistCreate.mockResolvedValue(newEntry)
    mockWaitlistCount.mockResolvedValue(1) // first in line

    const result = await joinWaitlist(BASE_INPUT)

    expect(result.waitlistId).toBe("wl_02")
    expect(result.position).toBe(1)
    expect(result.message).toContain("posição 1")
  })

  it("reflects correct position when others are already waiting", async () => {
    mockTimeSlotFindUnique.mockResolvedValue(SLOT)
    mockWaitlistFindFirst.mockResolvedValue(null)
    const newEntry = {
      id: "wl_05",
      customerId: "cus_01",
      timeSlotId: "ts_01",
      partySize: 2,
      createdAt: new Date(),
      notifiedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    }
    mockWaitlistCreate.mockResolvedValue(newEntry)
    mockWaitlistCount.mockResolvedValue(3) // 3rd in line

    const result = await joinWaitlist(BASE_INPUT)

    expect(result.position).toBe(3)
    expect(result.message).toContain("posição 3")
  })

  it("sets expiresAt 24 hours from now on creation", async () => {
    mockTimeSlotFindUnique.mockResolvedValue(SLOT)
    mockWaitlistFindFirst.mockResolvedValue(null)
    mockWaitlistCreate.mockResolvedValue({
      id: "wl_06",
      customerId: "cus_01",
      timeSlotId: "ts_01",
      partySize: 2,
      createdAt: new Date(),
      notifiedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    mockWaitlistCount.mockResolvedValue(1)

    await joinWaitlist(BASE_INPUT)

    const [createArg] = mockWaitlistCreate.mock.calls[0] as [{ data: { expiresAt: Date } }]
    const diffMs = createArg.data.expiresAt.getTime() - Date.now()
    // Should be ~24 hours (allow ±5 seconds for test execution)
    expect(diffMs).toBeGreaterThan(86_400_000 - 5_000)
    expect(diffMs).toBeLessThanOrEqual(86_400_000 + 5_000)
  })
})
