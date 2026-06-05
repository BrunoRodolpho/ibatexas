// Tests for lib/clean.ts — registry-driven cleanup.
// Mocks Prisma + a pg client; never touches a real DB.
import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  cleanDomainTables,
  cleanReferenceTables,
  truncateRawTables,
  countRawTables,
} from "../lib/clean.js"
import { DOMAIN_DELETE_ORDER, DOMAIN_REFERENCE } from "../lib/db-tables.js"
import type { PgClientLike } from "../lib/sql-migrate.js"

// ── Mock Prisma — built from the registry so it never drifts ──────────────────

function makeMockPrisma() {
  const callOrder: string[] = []
  const obj: Record<string, unknown> = {}
  for (const name of [...DOMAIN_DELETE_ORDER, ...DOMAIN_REFERENCE]) {
    obj[name] = {
      deleteMany: vi.fn().mockImplementation(async () => {
        callOrder.push(name)
        return { count: 0 }
      }),
      count: vi.fn().mockResolvedValue(0),
    }
  }
  obj.__callOrder = callOrder
  return obj
}

// ── cleanDomainTables ─────────────────────────────────────────────────────────

describe("cleanDomainTables", () => {
  let mockPrisma: ReturnType<typeof makeMockPrisma>

  beforeEach(() => {
    mockPrisma = makeMockPrisma()
    vi.clearAllMocks()
  })

  it("deletes from every registered domain table", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cleanDomainTables(mockPrisma as any)
    for (const name of DOMAIN_DELETE_ORDER) {
      expect((mockPrisma[name] as { deleteMany: ReturnType<typeof vi.fn> }).deleteMany).toHaveBeenCalled()
    }
  })

  it("does NOT touch reference/config tables", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cleanDomainTables(mockPrisma as any)
    for (const name of DOMAIN_REFERENCE) {
      expect((mockPrisma[name] as { deleteMany: ReturnType<typeof vi.fn> }).deleteMany).not.toHaveBeenCalled()
    }
  })

  it("deletes children before parents (FK-safe order)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cleanDomainTables(mockPrisma as any)
    const order = mockPrisma.__callOrder as string[]
    const before = (child: string, parent: string) =>
      expect(order.indexOf(child)).toBeLessThan(order.indexOf(parent))

    before("reservationTable", "reservation")
    before("reservationTable", "table")
    before("address", "customer")
    before("customerPreferences", "customer")
    before("loyaltyAccount", "customer")
    before("conversationMessage", "conversation")
    before("paymentStatusHistory", "payment")
    before("orderStatusHistory", "orderProjection")
    before("timeSlot", "table")
  })

  it("propagates errors from deleteMany", async () => {
    ;(mockPrisma.reservationTable as { deleteMany: ReturnType<typeof vi.fn> }).deleteMany.mockRejectedValueOnce(
      new Error("FK violation"),
    )
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cleanDomainTables(mockPrisma as any),
    ).rejects.toThrow("FK violation")
  })
})

describe("cleanReferenceTables", () => {
  it("deletes from every reference table", async () => {
    const mockPrisma = makeMockPrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cleanReferenceTables(mockPrisma as any)
    for (const name of DOMAIN_REFERENCE) {
      expect((mockPrisma[name] as { deleteMany: ReturnType<typeof vi.fn> }).deleteMany).toHaveBeenCalled()
    }
  })
})

// ── Raw-SQL helpers (kernel / claustrum) ──────────────────────────────────────

interface Call {
  text: string
  params?: ReadonlyArray<unknown>
}

function makeMockPg(existing: string[]) {
  const calls: Call[] = []
  const query = vi.fn(async (text: string, params?: ReadonlyArray<unknown>) => {
    calls.push({ text, params })
    if (text.includes("to_regclass")) {
      const t = String(params?.[0] ?? "")
      return { rows: [{ reg: existing.includes(t) ? t : null }], rowCount: 1 }
    }
    if (text.includes("count(*)")) {
      return { rows: [{ n: 5 }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
  return { client: { query } as PgClientLike, calls, query }
}

describe("truncateRawTables", () => {
  it("truncates only existing tables, in one statement", async () => {
    const h = makeMockPg(["intent_audit"]) // governance_events not provisioned yet
    const truncated = await truncateRawTables(h.client, ["intent_audit", "governance_events"])

    expect(truncated).toEqual(["intent_audit"])
    const truncCalls = h.calls.filter((c) => c.text.startsWith("TRUNCATE"))
    expect(truncCalls).toHaveLength(1)
    expect(truncCalls[0].text).toContain('"intent_audit"')
    expect(truncCalls[0].text).not.toContain("governance_events")
    expect(truncCalls[0].text).toContain("RESTART IDENTITY")
  })

  it("issues no TRUNCATE when nothing is provisioned", async () => {
    const h = makeMockPg([])
    const truncated = await truncateRawTables(h.client, ["intent_audit"])
    expect(truncated).toEqual([])
    expect(h.calls.some((c) => c.text.startsWith("TRUNCATE"))).toBe(false)
  })
})

describe("countRawTables", () => {
  it("reports counts for existing tables and exists:false otherwise", async () => {
    const h = makeMockPg(["intent_audit"])
    const rows = await countRawTables(h.client, ["intent_audit", "audit_outcomes"])
    expect(rows).toEqual([
      { name: "intent_audit", count: 5, exists: true },
      { name: "audit_outcomes", count: 0, exists: false },
    ])
  })
})
