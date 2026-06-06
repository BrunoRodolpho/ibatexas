// Reservation service — joinWaitlistFromEnvelope tests (W7 follow-up)
//
// Validates the envelope-typed entry point:
//   1. EXECUTE path delegates to the underlying joinWaitlist executor
//      and returns the kernel-adjudicated result.
//   2. REFUSE path (invalid party size — caught by the pack's
//      validatePartySize business guard) does NOT invoke the executor.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildEnvelope } from "@adjudicate/core"
import type {
  ReservationState,
  ReservationWaitlistJoinPayload,
} from "@ibatexas/pack-reservations"

// ── Mock Prisma — hoisted ────────────────────────────────────────────────────

const mockTimeSlotFindUnique = vi.hoisted(() => vi.fn())
const mockWaitlistFindFirst = vi.hoisted(() => vi.fn())
const mockWaitlistCreate = vi.hoisted(() => vi.fn())
const mockWaitlistCount = vi.hoisted(() => vi.fn())

vi.mock("../../client.js", () => ({
  prisma: {
    timeSlot: { findUnique: mockTimeSlotFindUnique },
    waitlist: {
      findFirst: mockWaitlistFindFirst,
      create: mockWaitlistCreate,
      count: mockWaitlistCount,
    },
  },
}))

vi.mock("../../generated/prisma-client/client.js", () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  },
  PrismaReservationStatus: {},
}))

import { createReservationService } from "../reservation.service.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEnvelope(
  payload: ReservationWaitlistJoinPayload,
  taint: "UNTRUSTED" | "TRUSTED" = "UNTRUSTED",
) {
  return buildEnvelope<"reservation.waitlist.join", ReservationWaitlistJoinPayload>({
    kind: "reservation.waitlist.join",
    payload,
    nonce: "nonce-1",
    actor: { principal: "llm", sessionId: "customer:cus_01" },
    taint,
  })
}

const STATE: ReservationState = {
  ctx: {
    channel: "whatsapp",
    customerId: "cus_01",
    staffId: null,
    now: new Date("2026-04-01T12:00:00.000Z"),
  },
}

const SLOT_ROW = {
  id: "ts_01",
  date: new Date("2026-04-15T00:00:00.000Z"),
  startTime: "19:30",
  durationMinutes: 90,
  maxCovers: 10,
  reservedCovers: 10,
  createdAt: new Date(),
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ReservationService.joinWaitlistFromEnvelope", () => {
  let svc: ReturnType<typeof createReservationService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createReservationService()
  })

  it("EXECUTE: delegates to the joinWaitlist executor and surfaces the result", async () => {
    mockTimeSlotFindUnique.mockResolvedValue(SLOT_ROW)
    mockWaitlistFindFirst.mockResolvedValue(null)
    mockWaitlistCreate.mockResolvedValue({
      id: "wl_42",
      customerId: "cus_01",
      timeSlotId: "ts_01",
      partySize: 2,
      createdAt: new Date(),
      notifiedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    mockWaitlistCount.mockResolvedValue(1)

    const envelope = makeEnvelope({ timeSlotId: "ts_01", partySize: 2 })
    const outcome = await svc.joinWaitlistFromEnvelope(envelope, STATE, {
      customerId: "cus_01",
    })

    expect(outcome.decision.kind).toBe("EXECUTE")
    expect(outcome.result).toEqual({ waitlistId: "wl_42", position: 1 })
    expect(mockWaitlistCreate).toHaveBeenCalledOnce()
  })

  it("REFUSE: invalid party size — executor is NOT called", async () => {
    const envelope = makeEnvelope({ timeSlotId: "ts_01", partySize: 0 })
    const outcome = await svc.joinWaitlistFromEnvelope(envelope, STATE, {
      customerId: "cus_01",
    })

    expect(outcome.decision.kind).toBe("REFUSE")
    expect(outcome.result).toBeUndefined()
    expect(mockTimeSlotFindUnique).not.toHaveBeenCalled()
    expect(mockWaitlistCreate).not.toHaveBeenCalled()
  })
})
