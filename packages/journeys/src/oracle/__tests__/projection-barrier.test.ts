// Tests for oracle/projection-barrier.ts — poll-with-backoff semantics,
// timeout diagnostics, LGPD-anonymized payload tolerance. Mock prisma
// double only (no DB — read-only-role containment is T1a-9's concern).
import { describe, it, expect } from "vitest"

import {
  awaitProjection,
  eventSeen,
  findEvents,
  hasEvent,
  isAnonymizedEventPayload,
  ProjectionBarrierTimeoutError,
  type OrderEventLogRow,
  type OrderProjectionRow,
  type ProjectionBarrierPrisma,
} from "../projection-barrier.js"

// ── Mock prisma double ────────────────────────────────────────────────────────

function projectionRow(overrides: Partial<OrderProjectionRow> = {}): OrderProjectionRow {
  return { id: "order_01", displayId: 42, version: 1, fulfillmentStatus: "pending", ...overrides }
}

function eventRow(overrides: Partial<OrderEventLogRow> = {}): OrderEventLogRow {
  return {
    id: "evt_01",
    orderId: "order_01",
    eventType: "order.placed",
    idempotencyKey: "idem-1",
    payload: { customerName: "Bruno", totalInCentavos: 8900 },
    createdAt: new Date("2026-06-12T00:00:00Z"),
    ...overrides,
  }
}

/**
 * Sequenced double: poll i returns `projections[min(i, last)]`; events are
 * filtered by `where.orderId` like the real client would.
 */
function makePrismaDouble(
  projections: Array<OrderProjectionRow | null>,
  events: OrderEventLogRow[] = [],
) {
  const calls = { findFirst: 0, findMany: 0, wheres: [] as Array<Record<string, unknown>> }
  const prisma: ProjectionBarrierPrisma = {
    orderProjection: {
      async findFirst({ where }) {
        calls.wheres.push(where)
        const index = Math.min(calls.findFirst, projections.length - 1)
        calls.findFirst += 1
        return projections[index] ?? null
      },
    },
    orderEventLog: {
      async findMany({ where }) {
        calls.findMany += 1
        return events.filter((event) => event.orderId === where["orderId"])
      },
    },
  }
  return { prisma, calls }
}

// ── awaitProjection — resolution ─────────────────────────────────────────────

describe("awaitProjection — projection bump", () => {
  it("resolves after N polls when the version bump lands, reporting elapsed + polls", async () => {
    const { prisma, calls } = makePrismaDouble([
      projectionRow({ version: 1 }),
      projectionRow({ version: 1 }),
      projectionRow({ version: 2, fulfillmentStatus: "confirmed" }),
    ])

    const result = await awaitProjection({
      prisma,
      orderId: "order_01",
      sinceVersion: 1,
      timeoutMs: 2_000,
      pollMs: 5,
    })

    expect(result.projection?.version).toBe(2)
    expect(result.polls).toBe(3)
    expect(calls.findFirst).toBe(3)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(5) // slept between polls — but never a blind sleep
    expect(result.elapsedMs).toBeLessThan(2_000)
  })

  it("resolves on the FIRST poll without sleeping when the state already landed", async () => {
    const { prisma } = makePrismaDouble([projectionRow({ version: 5 })])

    const start = Date.now()
    const result = await awaitProjection({
      prisma,
      orderId: "order_01",
      sinceVersion: 4,
      timeoutMs: 2_000,
      pollMs: 500, // would dominate elapsed if a blind pre-sleep existed
    })

    expect(result.polls).toBe(1)
    expect(Date.now() - start).toBeLessThan(400)
  })

  it("targets by filter when the order id is not known yet", async () => {
    const { prisma, calls } = makePrismaDouble(
      [null, projectionRow({ version: 2 })],
      [eventRow()],
    )

    const result = await awaitProjection({
      prisma,
      filter: { displayId: 42 },
      sinceVersion: 1,
      timeoutMs: 2_000,
      pollMs: 5,
    })

    expect(calls.wheres[0]).toEqual({ displayId: 42 })
    expect(result.projection?.id).toBe("order_01")
    // events resolved via the found projection's id
    expect(result.events).toHaveLength(1)
  })
})

// ── awaitProjection — timeout diagnostics ────────────────────────────────────

describe("awaitProjection — timeout", () => {
  it("throws the named error carrying last-seen state when the bump never lands", async () => {
    const { prisma } = makePrismaDouble(
      [projectionRow({ version: 1 })],
      [eventRow({ eventType: "order.placed" })],
    )

    const start = Date.now()
    let caught: unknown
    try {
      await awaitProjection({
        prisma,
        orderId: "order_01",
        sinceVersion: 1,
        timeoutMs: 40,
        pollMs: 5,
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ProjectionBarrierTimeoutError)
    const error = caught as ProjectionBarrierTimeoutError
    expect(error.name).toBe("ProjectionBarrierTimeoutError")
    expect(error.lastSeen?.projection?.version).toBe(1) // flake diagnosis: what WAS there
    expect(error.lastSeen?.events.map((e) => e.eventType)).toEqual(["order.placed"])
    expect(error.polls).toBeGreaterThanOrEqual(2) // polled, never blind-slept through the window
    expect(error.elapsedMs).toBeGreaterThanOrEqual(40)
    expect(Date.now() - start).toBeLessThan(2_000) // hard timeout, no runaway backoff
    expect(error.message).toContain("projection_barrier_timeout")
    expect(error.message).toContain("version>1")
    expect(error.message).toContain("order.placed")
  })

  it("reports projection=absent when the row never appeared", async () => {
    const { prisma } = makePrismaDouble([null])

    await expect(
      awaitProjection({ prisma, orderId: "order_404", sinceVersion: 0, timeoutMs: 20, pollMs: 5 }),
    ).rejects.toMatchObject({
      name: "ProjectionBarrierTimeoutError",
      lastSeen: { projection: null, events: [] },
    })
  })
})

// ── LGPD-anonymized payload tolerance ────────────────────────────────────────

describe("awaitProjection — LGPD-anonymized event payloads", () => {
  it("matches events by identity columns even after the payload is scrubbed in place", async () => {
    // anonymizeCustomer full-replaces payload with { anonymized: true };
    // orderId / eventType / idempotencyKey survive.
    const scrubbed = eventRow({
      eventType: "order.placed",
      idempotencyKey: "idem-1",
      payload: { anonymized: true },
    })
    const { prisma } = makePrismaDouble([projectionRow({ version: 1 })], [scrubbed])

    const result = await awaitProjection({
      prisma,
      orderId: "order_01",
      predicate: eventSeen({ eventType: "order.placed", orderId: "order_01" }),
      timeoutMs: 2_000,
      pollMs: 5,
    })

    expect(result.polls).toBe(1)
    expect(result.events[0]?.payload).toEqual({ anonymized: true })
    expect(isAnonymizedEventPayload(result.events[0]?.payload)).toBe(true)
  })

  it("hasEvent/findEvents never key on payload fields", () => {
    const scrubbed = eventRow({ payload: { anonymized: true } })
    const intact = eventRow({ id: "evt_02", idempotencyKey: "idem-2", eventType: "order.canceled" })

    expect(hasEvent([scrubbed, intact], { eventType: "order.placed" })).toBe(true)
    expect(hasEvent([scrubbed, intact], { eventType: "order.canceled", orderId: "order_01" })).toBe(true)
    expect(hasEvent([scrubbed], { eventType: "order.placed", idempotencyKey: "idem-1" })).toBe(true)
    expect(hasEvent([scrubbed], { eventType: "order.placed", idempotencyKey: "other" })).toBe(false)
    expect(findEvents([scrubbed, intact], { eventType: "order.placed" })).toHaveLength(1)
  })

  it("isAnonymizedEventPayload detects exactly the full-replace scrub shape", () => {
    expect(isAnonymizedEventPayload({ anonymized: true })).toBe(true)
    expect(isAnonymizedEventPayload({ anonymized: true, extra: 1 })).toBe(true)
    expect(isAnonymizedEventPayload({ anonymized: false })).toBe(false)
    expect(isAnonymizedEventPayload({ customerName: "Bruno" })).toBe(false)
    expect(isAnonymizedEventPayload(null)).toBe(false)
    expect(isAnonymizedEventPayload("anonymized")).toBe(false)
    expect(isAnonymizedEventPayload([{ anonymized: true }])).toBe(false)
  })
})

// ── Config validation ────────────────────────────────────────────────────────

describe("awaitProjection — config validation", () => {
  it("requires a target (orderId or filter)", async () => {
    const { prisma } = makePrismaDouble([null])
    await expect(awaitProjection({ prisma, sinceVersion: 1 })).rejects.toThrow(
      /provide orderId or filter/,
    )
  })

  it("requires a condition (sinceVersion or predicate)", async () => {
    const { prisma } = makePrismaDouble([null])
    await expect(awaitProjection({ prisma, orderId: "order_01" })).rejects.toThrow(
      /provide sinceVersion or predicate/,
    )
  })
})
