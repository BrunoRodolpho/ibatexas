// Tests for KitchenService (NEW-010 — the "ticket-timing" half of the kitchen
// board). Mock-based; no DB required. `now` is INJECTED so every duration is
// deterministic.
//
// Scenarios:
// - active-only filter: the query is scoped to the pre-delivery, non-terminal
//   set — delivered / canceled / in_delivery are OFF the board
// - ticketAgeMs + timeInStatusMs math against the injected `now` + mock history
// - statusSince: the LATEST transition INTO the current status wins; fallback to
//   medusaCreatedAt when there is no such history row
// - oldest-first sort (ticketAgeMs DESC, tie-break displayId ASC)
// - queueDepth counts (every active status present, zeros included)
// - negative durations clamped at 0 (clock skew: now < timestamp)
// - single history query (no N+1); empty board short-circuits the history query

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockOrderFindMany = vi.hoisted(() => vi.fn())
const mockHistoryFindMany = vi.hoisted(() => vi.fn())

vi.mock("../../client.js", () => ({
  prisma: {
    orderProjection: { findMany: mockOrderFindMany },
    orderStatusHistory: { findMany: mockHistoryFindMany },
  },
}))

// ── Import after mocks ──────────────────────────────────────────────────────

import { createKitchenService } from "../kitchen.service.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

const NOW = new Date("2026-07-04T12:00:00.000Z")
const MIN = 60_000

/** A Date `mins` minutes before NOW. */
function ago(mins: number): Date {
  return new Date(NOW.getTime() - mins * MIN)
}
/** A Date `mins` minutes AFTER NOW (clock-skew fixtures). */
function ahead(mins: number): Date {
  return new Date(NOW.getTime() + mins * MIN)
}

function item(productId: string, title: string, quantity: number, priceInCentavos: number) {
  return { productId, variantId: `${productId}-v`, title, quantity, priceInCentavos }
}

/** An OrderProjection row as returned by the board's findMany select. */
function order(
  id: string,
  displayId: number,
  fulfillmentStatus: string,
  medusaCreatedAt: Date,
  items: ReturnType<typeof item>[] = [],
) {
  return { id, displayId, fulfillmentStatus, itemsJson: items, medusaCreatedAt }
}

/** An OrderStatusHistory row as returned by the board's history findMany select. */
function hist(orderId: string, toStatus: string, createdAt: Date) {
  return { orderId, toStatus, createdAt }
}

const ACTIVE = ["pending", "confirmed", "preparing", "ready"]

// ── Tests ───────────────────────────────────────────────────────────────────

describe("KitchenService.getTickets", () => {
  let svc: ReturnType<typeof createKitchenService>

  beforeEach(() => {
    vi.clearAllMocks()
    mockHistoryFindMany.mockResolvedValue([])
    svc = createKitchenService()
  })

  it("scopes the board to the active (pre-delivery, non-terminal) set — delivered/canceled/in_delivery are OFF", async () => {
    mockOrderFindMany.mockResolvedValue([order("o1", 1, "preparing", ago(10))])

    await svc.getTickets({ now: NOW })

    const where = mockOrderFindMany.mock.calls[0][0].where
    const statusIn = where.fulfillmentStatus.in as string[]
    expect(statusIn).toEqual(ACTIVE)
    expect(statusIn).not.toContain("in_delivery")
    expect(statusIn).not.toContain("delivered")
    expect(statusIn).not.toContain("canceled")

    // The history query is scoped to the SAME active set + the active order ids.
    const hWhere = mockHistoryFindMany.mock.calls[0][0].where
    expect(hWhere.orderId.in).toEqual(["o1"])
    expect(hWhere.toStatus.in as string[]).toEqual(ACTIVE)
    // Newest-first so the first row per (orderId,status) is the latest.
    expect(mockHistoryFindMany.mock.calls[0][0].orderBy).toEqual({ createdAt: "desc" })
  })

  it("computes ticketAgeMs (now − createdAt) and timeInStatusMs (now − statusSince) with items summed", async () => {
    // Order created 30m ago, entered `preparing` 5m ago.
    mockOrderFindMany.mockResolvedValue([
      order("o1", 101, "preparing", ago(30), [item("p_a", "A", 2, 500), item("p_b", "B", 3, 700)]),
    ])
    mockHistoryFindMany.mockResolvedValue([hist("o1", "preparing", ago(5))])

    const board = await svc.getTickets({ now: NOW })

    expect(board.now).toBe(NOW.toISOString())
    expect(board.totalActive).toBe(1)
    const t = board.tickets[0]
    expect(t.orderId).toBe("o1")
    expect(t.displayId).toBe(101)
    expect(t.fulfillmentStatus).toBe("preparing")
    expect(t.itemCount).toBe(5) // 2 + 3
    expect(t.items).toHaveLength(2)
    expect(t.ticketAgeMs).toBe(30 * MIN)
    expect(t.statusSince).toBe(ago(5).toISOString())
    expect(t.timeInStatusMs).toBe(5 * MIN)
  })

  it("uses the LATEST transition into the current status (history is newest-first)", async () => {
    // Bounced ready → preparing → ready; current status `ready`. The board query
    // returns rows newest-first, so the first `ready` row (2m ago) is the latest.
    mockOrderFindMany.mockResolvedValue([order("o1", 1, "ready", ago(60))])
    mockHistoryFindMany.mockResolvedValue([
      hist("o1", "ready", ago(2)), // latest into `ready`
      hist("o1", "preparing", ago(20)),
      hist("o1", "ready", ago(40)), // earlier stint at `ready` — must be ignored
    ])

    const board = await svc.getTickets({ now: NOW })

    expect(board.tickets[0].statusSince).toBe(ago(2).toISOString())
    expect(board.tickets[0].timeInStatusMs).toBe(2 * MIN)
  })

  it("falls back to medusaCreatedAt when there is no matching history row (e.g. still at default pending)", async () => {
    mockOrderFindMany.mockResolvedValue([order("o1", 7, "pending", ago(15))])
    mockHistoryFindMany.mockResolvedValue([]) // never transitioned

    const board = await svc.getTickets({ now: NOW })

    const t = board.tickets[0]
    expect(t.statusSince).toBe(ago(15).toISOString()) // = medusaCreatedAt
    expect(t.timeInStatusMs).toBe(15 * MIN)
    expect(t.ticketAgeMs).toBe(15 * MIN)
  })

  it("ignores a history row whose toStatus is NOT the order's current status", async () => {
    // Order is at `preparing`; only a `confirmed` transition exists → fallback.
    mockOrderFindMany.mockResolvedValue([order("o1", 3, "preparing", ago(25))])
    mockHistoryFindMany.mockResolvedValue([hist("o1", "confirmed", ago(10))])

    const board = await svc.getTickets({ now: NOW })

    expect(board.tickets[0].statusSince).toBe(ago(25).toISOString()) // fallback to createdAt
    expect(board.tickets[0].timeInStatusMs).toBe(25 * MIN)
  })

  it("sorts oldest-first: ticketAgeMs DESC, tie-break displayId ASC", async () => {
    mockOrderFindMany.mockResolvedValue([
      order("o_new", 5, "pending", ago(5)),
      order("o_old", 9, "pending", ago(60)),
      order("o_tieB", 8, "confirmed", ago(20)),
      order("o_tieA", 4, "preparing", ago(20)), // same age as o_tieB → lower displayId first
    ])

    const board = await svc.getTickets({ now: NOW })

    expect(board.tickets.map((t) => t.orderId)).toEqual(["o_old", "o_tieA", "o_tieB", "o_new"])
  })

  it("computes queueDepth per active status (zeros included) in board order + totalActive", async () => {
    mockOrderFindMany.mockResolvedValue([
      order("o1", 1, "pending", ago(10)),
      order("o2", 2, "preparing", ago(9)),
      order("o3", 3, "preparing", ago(8)),
      order("o4", 4, "ready", ago(7)),
    ])

    const board = await svc.getTickets({ now: NOW })

    expect(board.queueDepth).toEqual([
      { status: "pending", count: 1 },
      { status: "confirmed", count: 0 }, // present with a 0
      { status: "preparing", count: 2 },
      { status: "ready", count: 1 },
    ])
    expect(board.totalActive).toBe(4)
    // totalActive reconciles with the queueDepth counts.
    expect(board.queueDepth.reduce((s, q) => s + q.count, 0)).toBe(board.totalActive)
  })

  it("clamps negative durations at 0 (clock skew: now before the timestamp)", async () => {
    // Order created 3m AFTER now, and its status-entry is 1m AFTER now.
    mockOrderFindMany.mockResolvedValue([order("o1", 1, "preparing", ahead(3))])
    mockHistoryFindMany.mockResolvedValue([hist("o1", "preparing", ahead(1))])

    const board = await svc.getTickets({ now: NOW })

    expect(board.tickets[0].ticketAgeMs).toBe(0)
    expect(board.tickets[0].timeInStatusMs).toBe(0)
  })

  it("tolerates a non-array itemsJson (→ empty items, itemCount 0)", async () => {
    mockOrderFindMany.mockResolvedValue([{ id: "o1", displayId: 1, fulfillmentStatus: "pending", itemsJson: null, medusaCreatedAt: ago(5) }])

    const board = await svc.getTickets({ now: NOW })

    expect(board.tickets[0].items).toEqual([])
    expect(board.tickets[0].itemCount).toBe(0)
  })

  it("returns an empty board and does NOT query history when there are no active orders", async () => {
    mockOrderFindMany.mockResolvedValue([])

    const board = await svc.getTickets({ now: NOW })

    expect(board.totalActive).toBe(0)
    expect(board.tickets).toEqual([])
    expect(board.queueDepth).toEqual([
      { status: "pending", count: 0 },
      { status: "confirmed", count: 0 },
      { status: "preparing", count: 0 },
      { status: "ready", count: 0 },
    ])
    // No active ids → the history query is short-circuited (no N+1, no empty-IN query).
    expect(mockHistoryFindMany).not.toHaveBeenCalled()
  })

  it("issues exactly ONE history query regardless of active-order count (no N+1)", async () => {
    mockOrderFindMany.mockResolvedValue([
      order("o1", 1, "preparing", ago(10)),
      order("o2", 2, "ready", ago(9)),
      order("o3", 3, "confirmed", ago(8)),
    ])
    mockHistoryFindMany.mockResolvedValue([
      hist("o1", "preparing", ago(4)),
      hist("o2", "ready", ago(3)),
      hist("o3", "confirmed", ago(2)),
    ])

    await svc.getTickets({ now: NOW })

    expect(mockOrderFindMany).toHaveBeenCalledTimes(1)
    expect(mockHistoryFindMany).toHaveBeenCalledTimes(1)
  })

  it("defaults `now` to the wall clock when not injected", async () => {
    mockOrderFindMany.mockResolvedValue([order("o1", 1, "pending", new Date(Date.now() - 2 * MIN))])

    const before = Date.now()
    const board = await svc.getTickets()
    const after = Date.now()

    const boardNow = new Date(board.now).getTime()
    expect(boardNow).toBeGreaterThanOrEqual(before)
    expect(boardNow).toBeLessThanOrEqual(after)
    expect(board.tickets[0].ticketAgeMs).toBeGreaterThanOrEqual(0)
  })
})
