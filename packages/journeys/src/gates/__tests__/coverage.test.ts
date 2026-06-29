// Tests for gates/coverage.ts — the coverage gate behind `ibx journey coverage`.
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CHAT_DRIVABLE_TOOL_KINDS } from "@ibatexas/packs-composed"

import { JOURNEY_EXPECT_DECISIONS } from "../../schema/index.js"
import { STAFF_ROUTE_KINDS } from "../lint.js"
import {
  computeJourneyCoverage,
  coverageBaseline,
  coverageCellKey,
  coverageMatrixView,
  journeyPassView,
  plausibleDecisions,
  verifyCoverageBaseline,
  DEFAULT_COVERAGE_WAIVERS_PATH,
  type JourneyCoverageReport,
} from "../coverage.js"

// ── Fixture scaffolding (temp registry + waivers, no committed files) ─────────

let root: string

function journeyYaml(over: {
  id: string
  acts?: string
  expects?: string
  status?: string
  blockedBy?: string
}): string {
  return [
    `id: ${over.id}`,
    `title: coverage fixture ${over.id}`,
    "businessCase: coverage gate unit test",
    "persona: Persona de teste.",
    "channel: web",
    "acts:",
    over.acts ?? "  - kind: chat\n    goal: objetivo de teste",
    "expects:",
    ...(over.expects !== undefined ? [over.expects] : ["  []"]),
    "verify: []",
    `status: ${over.status ?? "active"}`,
    ...(over.blockedBy !== undefined ? [`blocked_by: ${over.blockedBy}`] : []),
    "source: coverage.test.ts",
  ].join("\n")
}

const CHAT_COVERED_KIND = "order.item.add"
const CHAT_REFUSED_KIND = "order.coupon.apply"
const STAFF_KIND = "reservation.checkin"

async function writeRegistry(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  // Active chat journey covering two chat cells + one unmatched system kind.
  await writeFile(
    join(dir, "journey-950.yaml"),
    journeyYaml({
      id: "JOURNEY-950",
      expects: [
        `  - intentKind: ${CHAT_COVERED_KIND}`,
        "    decision: EXECUTE",
        `  - intentKind: ${CHAT_REFUSED_KIND}`,
        "    decision: REFUSE",
        "  - intentKind: pix.charge.create", // not chat-drivable → unmatched
        "    decision: EXECUTE",
      ].join("\n"),
    }),
  )
  // Active staff-http journey covering one staff cell.
  await writeFile(
    join(dir, "journey-951.yaml"),
    journeyYaml({
      id: "JOURNEY-951",
      acts: [
        "  - kind: http",
        "    method: POST",
        "    path: /api/staff/reservations/checkin",
        "    asRole: staff",
      ].join("\n"),
      expects: [`  - intentKind: ${STAFF_KIND}`, "    decision: EXECUTE"].join("\n"),
    }),
  )
  // Quarantine candidate — claims a distinct chat cell.
  await writeFile(
    join(dir, "journey-952.yaml"),
    journeyYaml({
      id: "JOURNEY-952",
      expects: ["  - intentKind: reservation.create", "    decision: EXECUTE"].join(
        "\n",
      ),
    }),
  )
  // Blocked journey — claims but never covers.
  await writeFile(
    join(dir, "journey-953.yaml"),
    journeyYaml({
      id: "JOURNEY-953",
      status: "blocked",
      blockedBy: "[ws4]",
      expects: ["  - intentKind: order.cancel", "    decision: REFUSE"].join("\n"),
    }),
  )
  // Verify-only journey — read-only acts produce no envelopes.
  await writeFile(
    join(dir, "journey-954.yaml"),
    journeyYaml({ id: "JOURNEY-954" }),
  )
}

const WAIVERS: unknown = [
  {
    kind: "order.review.submit",
    decision: "*",
    category: "waived-unadvertised",
    reason: "registered but never advertised",
    addedAt: "2026-06-12",
  },
  {
    kind: "payment.retry",
    decision: "*",
    category: "waived-pending-WS4",
    reason: "de-advertised until WS4",
    addedAt: "2026-06-12",
  },
]

let registryDir: string
let waiversPath: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "journeys-coverage-"))
  registryDir = join(root, "registry")
  waiversPath = join(root, "waivers.json")
  await writeRegistry(registryDir)
  await writeFile(waiversPath, JSON.stringify(WAIVERS, null, 2))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function compute(
  over?: Partial<{ dir: string; waiversPath: string; quarantined: string[] }>,
): Promise<JourneyCoverageReport> {
  return computeJourneyCoverage({
    dir: registryDir,
    waiversPath,
    ...over,
  })
}

// ── Domain construction ──────────────────────────────────────────────────────

describe("coverage domain (DR-5)", () => {
  it("builds chat × decisions ∪ staff-http × decisions cells", async () => {
    const report = await compute()
    const chatCells = report.cells.filter((c) => c.surface === "chat")
    const staffCells = report.cells.filter((c) => c.surface === "staff-http")
    // All five first-party packs attach no guard metadata today → the
    // plausible set falls back to the full 6-decision set per kind.
    expect(chatCells).toHaveLength(CHAT_DRIVABLE_TOOL_KINDS.length * 6)
    expect(staffCells).toHaveLength(STAFF_ROUTE_KINDS.size * 6)
    expect(report.totals.cells).toBe(report.cells.length)
    expect(new Set(report.cells.map((c) => c.key)).size).toBe(report.cells.length)
  })

  it("falls back to the full 6-decision set while packs are metadata-opaque", () => {
    expect(plausibleDecisions(CHAT_COVERED_KIND)).toEqual([
      ...JOURNEY_EXPECT_DECISIONS,
    ])
    // Kind owned by no composed pack → full set, defensively.
    expect(plausibleDecisions("pix.charge.create")).toEqual([
      ...JOURNEY_EXPECT_DECISIONS,
    ])
  })
})

// ── Coverage marking ─────────────────────────────────────────────────────────

describe("coverage marking", () => {
  it("marks cells covered from active journeys' expects, per act surface", async () => {
    const report = await compute()
    const byKey = new Map(report.cells.map((c) => [c.key, c]))

    const executed = byKey.get(coverageCellKey("chat", CHAT_COVERED_KIND, "EXECUTE"))
    expect(executed?.state).toBe("covered")
    expect(executed?.coveredBy).toEqual(["JOURNEY-950"])

    const refused = byKey.get(coverageCellKey("chat", CHAT_REFUSED_KIND, "REFUSE"))
    expect(refused?.state).toBe("covered")

    const staff = byKey.get(coverageCellKey("staff-http", STAFF_KIND, "EXECUTE"))
    expect(staff?.state).toBe("covered")
    expect(staff?.coveredBy).toEqual(["JOURNEY-951"])

    // A staff-route kind is never a chat cell and vice versa.
    expect(byKey.has(coverageCellKey("chat", STAFF_KIND, "EXECUTE"))).toBe(false)
  })

  it("blocked journeys claim cells but never cover them", async () => {
    const report = await compute()
    const cell = report.cells.find(
      (c) => c.key === coverageCellKey("chat", "order.cancel", "REFUSE"),
    )
    expect(cell?.state).toBe("uncovered")
    expect(cell?.coveredBy).toEqual([])
    const entry = report.journeys.find((j) => j.id === "JOURNEY-953")
    expect(entry?.counted).toBe(false)
    expect(entry?.claimedCells).toContain(
      coverageCellKey("chat", "order.cancel", "REFUSE"),
    )
  })

  it("reports expects outside the matrix domain as unmatched, never dropped", async () => {
    const report = await compute()
    const entry = report.journeys.find((j) => j.id === "JOURNEY-950")
    expect(entry?.unmatchedExpects).toEqual([
      { intentKind: "pix.charge.create", decision: "EXECUTE" },
    ])
  })

  it("journey-pass view shows verify-only journeys (read-only acts, no envelopes)", async () => {
    const report = await compute()
    const view = journeyPassView(report)
    const entry = view.journeys.find((j) => j.id === "JOURNEY-954")
    expect(entry).toMatchObject({ verifyOnly: true, counted: true, claimedCells: [] })
    expect(view.journeys).toHaveLength(5)
  })
})

// ── Waivers ──────────────────────────────────────────────────────────────────

describe("waiver application", () => {
  it("applies a '*' waiver to every decision cell of the kind", async () => {
    const report = await compute()
    const waived = report.cells.filter((c) => c.kind === "order.review.submit")
    expect(waived).toHaveLength(6)
    for (const cell of waived) {
      expect(cell.state).toBe("waived-unadvertised")
      expect(cell.waiver).toMatchObject({
        category: "waived-unadvertised",
        addedAt: "2026-06-12",
      })
    }
    expect(report.totals["waived-unadvertised"]).toBe(6)
  })

  it("reports waivers matching no domain cell as dormant (WS4 kinds)", async () => {
    const report = await compute()
    expect(report.dormantWaivers).toHaveLength(1)
    expect(report.dormantWaivers[0]?.kind).toBe("payment.retry")
  })

  it("coverage beats a waiver — a covered cell never shows as waived", async () => {
    const dir = join(root, "registry-waived-covered")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "journey-960.yaml"),
      journeyYaml({
        id: "JOURNEY-960",
        expects: ["  - intentKind: order.review.submit", "    decision: REFUSE"].join(
          "\n",
        ),
      }),
    )
    const report = await compute({ dir })
    const cell = report.cells.find(
      (c) => c.key === coverageCellKey("chat", "order.review.submit", "REFUSE"),
    )
    expect(cell?.state).toBe("covered")
    // The waiver still matched the kind's other cells → not dormant.
    expect(report.dormantWaivers.map((w) => w.kind)).toEqual(["payment.retry"])
  })

  it("rejects an invalid waivers file as a problem (ok: false)", async () => {
    const badPath = join(root, "waivers-bad.json")
    await writeFile(
      badPath,
      JSON.stringify([{ kind: "order.item.add", category: "nope" }]),
    )
    const report = await compute({ waiversPath: badPath })
    expect(report.ok).toBe(false)
    expect(report.problems[0]?.code).toBe("waivers_invalid")
  })

  it("ships seeded waivers at the committed governance path", async () => {
    const report = await computeJourneyCoverage({
      dir: registryDir,
      waiversPath: DEFAULT_COVERAGE_WAIVERS_PATH,
    })
    expect(report.ok).toBe(true)
    // payment.method.switch + payment.retry are dormant until WS4 restores
    // them to the chat surface; order.review.submit waives live cells.
    expect(report.dormantWaivers.map((w) => w.kind).sort()).toEqual([
      "payment.method.switch",
      "payment.retry",
    ])
    expect(report.totals["waived-unadvertised"]).toBe(6)
  })
})

// ── Quarantine visibility ────────────────────────────────────────────────────

describe("quarantine (seam for the Phase-1b flake ledger)", () => {
  it("turns a quarantined journey's cells waived-quarantined — visible, never silently covered", async () => {
    const report = await compute({ quarantined: ["JOURNEY-952"] })
    const cell = report.cells.find(
      (c) => c.key === coverageCellKey("chat", "reservation.create", "EXECUTE"),
    )
    expect(cell?.state).toBe("waived-quarantined")
    expect(cell?.coveredBy).toEqual([])
    expect(cell?.quarantinedBy).toEqual(["JOURNEY-952"])
    expect(cell?.waiver?.reason).toContain("JOURNEY-952")
    expect(report.totals["waived-quarantined"]).toBe(1)

    const entry = report.journeys.find((j) => j.id === "JOURNEY-952")
    expect(entry).toMatchObject({ quarantined: true, counted: false })
  })

  it("keeps a cell covered when an active journey also claims it", async () => {
    const dir = join(root, "registry-quarantine-overlap")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "journey-970.yaml"),
      journeyYaml({
        id: "JOURNEY-970",
        expects: ["  - intentKind: reservation.create", "    decision: EXECUTE"].join(
          "\n",
        ),
      }),
    )
    await writeFile(
      join(dir, "journey-971.yaml"),
      journeyYaml({
        id: "JOURNEY-971",
        expects: ["  - intentKind: reservation.create", "    decision: EXECUTE"].join(
          "\n",
        ),
      }),
    )
    const report = await compute({ dir, quarantined: ["JOURNEY-971"] })
    const cell = report.cells.find(
      (c) => c.key === coverageCellKey("chat", "reservation.create", "EXECUTE"),
    )
    expect(cell?.state).toBe("covered")
    expect(cell?.coveredBy).toEqual(["JOURNEY-970"])
    expect(cell?.quarantinedBy).toEqual(["JOURNEY-971"]) // still visible
  })
})

// ── Baseline regression gate ─────────────────────────────────────────────────

describe("baseline verification (covered→uncovered fails)", () => {
  it("captures the covered cells as a sorted baseline", async () => {
    const report = await compute()
    const baseline = coverageBaseline(report)
    expect(baseline.covered).toEqual(
      [
        coverageCellKey("chat", CHAT_COVERED_KIND, "EXECUTE"),
        coverageCellKey("chat", CHAT_REFUSED_KIND, "REFUSE"),
        coverageCellKey("chat", "reservation.create", "EXECUTE"),
        coverageCellKey("staff-http", STAFF_KIND, "EXECUTE"),
      ].sort(),
    )
    expect(verifyCoverageBaseline(report, baseline).ok).toBe(true)
  })

  it("fails when a baseline-claimed cell is no longer covered", async () => {
    const report = await compute()
    const baseline = coverageBaseline(report)
    baseline.covered.push(coverageCellKey("chat", "order.cancel", "EXECUTE"))
    const result = verifyCoverageBaseline(report, baseline)
    expect(result.ok).toBe(false)
    expect(result.regressions).toEqual([
      { cell: coverageCellKey("chat", "order.cancel", "EXECUTE"), state: "uncovered" },
    ])
  })

  it("fails when a baseline-claimed cell left the domain entirely", async () => {
    const report = await compute()
    const result = verifyCoverageBaseline(report, {
      covered: ["chat:no.such.kind:EXECUTE"],
    })
    expect(result.regressions).toEqual([
      { cell: "chat:no.such.kind:EXECUTE", state: "absent" },
    ])
  })

  it("reports newly covered cells without failing until the baseline claims them", async () => {
    const report = await compute()
    const result = verifyCoverageBaseline(report, { covered: [] })
    expect(result.ok).toBe(true)
    expect(result.newlyCovered).toEqual(coverageBaseline(report).covered)
  })

  it("surfaces quarantined baseline claims without failing (flake ledger owns them)", async () => {
    const before = await compute()
    const baseline = coverageBaseline(before)
    const after = await compute({ quarantined: ["JOURNEY-952"] })
    const result = verifyCoverageBaseline(after, baseline)
    expect(result.ok).toBe(true)
    expect(result.quarantinedClaims).toEqual([
      coverageCellKey("chat", "reservation.create", "EXECUTE"),
    ])
  })
})

// ── Views + problems ─────────────────────────────────────────────────────────

describe("report shape", () => {
  it("matrix view carries cells + totals + dormant waivers", async () => {
    const report = await compute()
    const view = coverageMatrixView(report)
    expect(view.cells).toBe(report.cells)
    expect(view.totals).toBe(report.totals)
    expect(view.dormantWaivers).toBe(report.dormantWaivers)
  })

  it("an unreadable registry is a problem, not a throw", async () => {
    const report = await compute({ dir: join(root, "does-not-exist") })
    expect(report.ok).toBe(false)
    expect(report.problems[0]?.code).toBe("registry_unreadable")
  })

  it("an empty registry yields all-uncovered cells minus waivers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "journeys-coverage-empty-"))
    try {
      const report = await compute({ dir })
      expect(report.ok).toBe(true)
      expect(report.totals.covered).toBe(0)
      expect(report.totals.uncovered).toBe(
        report.totals.cells - report.totals["waived-unadvertised"],
      )
      expect(verifyCoverageBaseline(report, { covered: [] }).ok).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
