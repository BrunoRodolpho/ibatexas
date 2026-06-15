// Tests for graphs/export.ts — the regenerate-and-diff engine behind
// `ibx graph export [--check]` (T2-4). Runs against a TEMP graphs dir +
// temp journey registry so parallel suites never touch the committed
// artifacts; the committed dir's freshness is enforced by the CLI gate
// (`ibx graph export --check` in graphs-gate.yml), not by this suite.
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  exportGraphs,
  writeImpactWindowFixture,
  GraphExportError,
  DEFAULT_GRAPHS_DIR,
  GRAPH_FILES,
  IMPACT_WINDOW_FIXTURE,
  RUN_DECISIONS_FIXTURE,
  RUN_TRACE_FIXTURE,
} from "../export.js"

let graphsDir: string
let journeysDir: string

const JOURNEY_YAML = `id: JOURNEY-903
title: export fixture
businessCase: export engine unit test
persona: Persona de teste.
channel: web
status: blocked
blocked_by: [export-test-gap]
source: graphs export test
acts:
  - kind: chat
    utterance: Oi
expects:
  - intentKind: order.cancel
    decision: REQUEST_CONFIRMATION
verify: []
`

beforeAll(async () => {
  graphsDir = await mkdtemp(join(tmpdir(), "ibx-graphs-"))
  journeysDir = await mkdtemp(join(tmpdir(), "ibx-graphs-registry-"))
  await mkdir(join(graphsDir, "fixtures"), { recursive: true })
  // Reuse the committed sanitized fixtures as generator inputs.
  for (const fixture of [RUN_TRACE_FIXTURE, RUN_DECISIONS_FIXTURE, IMPACT_WINDOW_FIXTURE]) {
    await copyFile(join(DEFAULT_GRAPHS_DIR, fixture), join(graphsDir, fixture))
  }
  await writeFile(join(journeysDir, "journey-903.yaml"), JOURNEY_YAML)
})

afterAll(async () => {
  await rm(graphsDir, { recursive: true, force: true })
  await rm(journeysDir, { recursive: true, force: true })
})

describe("exportGraphs", () => {
  it("write mode regenerates all four artifacts; check mode is then clean", async () => {
    const written = await exportGraphs({ graphsDir, journeysDir })
    expect(written.ok).toBe(true)
    expect(written.mode).toBe("write")
    expect(written.graphs.map((g) => g.status)).toEqual([
      "written",
      "written",
      "written",
      "written",
    ])
    for (const entry of written.graphs) {
      expect(entry.nodes).toBeGreaterThan(0)
    }

    const checked = await exportGraphs({ graphsDir, journeysDir, check: true })
    expect(checked.ok).toBe(true)
    expect(checked.graphs.every((g) => g.status === "clean")).toBe(true)
  })

  it("check mode detects drift when a committed graph is mutated (nonzero path)", async () => {
    await exportGraphs({ graphsDir, journeysDir })
    const target = join(graphsDir, GRAPH_FILES.capability)
    const committed = await readFile(target, "utf8")
    // The classic failure: a hand edit / stale artifact after a pack change.
    await writeFile(target, committed.replace('"version": 1', '"version": 1 '))

    const report = await exportGraphs({ graphsDir, journeysDir, check: true })
    expect(report.ok).toBe(false) // ← the CLI maps this to exit 1
    expect(report.graphs.find((g) => g.graph === "capability")?.status).toBe("drift")
    // The untouched artifacts stay clean — drift is per-graph attributable.
    expect(report.graphs.find((g) => g.graph === "impact")?.status).toBe("clean")

    await writeFile(target, committed) // restore for the following tests
  })

  it("check mode reports a deleted artifact as missing", async () => {
    await exportGraphs({ graphsDir, journeysDir })
    await rm(join(graphsDir, GRAPH_FILES.run))
    const report = await exportGraphs({ graphsDir, journeysDir, check: true })
    expect(report.ok).toBe(false)
    expect(report.graphs.find((g) => g.graph === "run")?.status).toBe("missing")
  })

  it("a registry change without regeneration drifts the journey graph", async () => {
    await exportGraphs({ graphsDir, journeysDir })
    await writeFile(
      join(journeysDir, "journey-904.yaml"),
      JOURNEY_YAML.replace("JOURNEY-903", "JOURNEY-904"),
    )
    const report = await exportGraphs({ graphsDir, journeysDir, check: true })
    expect(report.ok).toBe(false)
    expect(report.graphs.find((g) => g.graph === "journeys")?.status).toBe("drift")
    await rm(join(journeysDir, "journey-904.yaml"))
    await exportGraphs({ graphsDir, journeysDir }) // restore
  })

  it("refuses run-graph input overrides in check mode", async () => {
    await expect(
      exportGraphs({ graphsDir, journeysDir, check: true, runTracePath: "/tmp/x.jsonl" }),
    ).rejects.toThrow(GraphExportError)
  })

  it("refuses unknown graph names", async () => {
    await expect(
      exportGraphs({ graphsDir, journeysDir, only: ["nope" as never] }),
    ).rejects.toThrow(/unknown graph/)
  })

  it("only= restricts generation", async () => {
    const report = await exportGraphs({ graphsDir, journeysDir, only: ["impact"] })
    expect(report.graphs.map((g) => g.graph)).toEqual(["impact"])
  })

  it("writeImpactWindowFixture round-trips through the impact export", async () => {
    const path = await writeImpactWindowFixture(
      {
        window: { fromIso: "2026-06-12T00:00:00.000Z", toIso: "2026-06-13T00:00:00.000Z" },
        source: "unit recapture",
        excludedAgentRows: 1,
        rows: [{ intentKind: "order.cancel", decision: "EXECUTE", count: 2 }],
      },
      graphsDir,
    )
    expect(path).toBe(join(graphsDir, IMPACT_WINDOW_FIXTURE))
    const report = await exportGraphs({ graphsDir, journeysDir, only: ["impact"] })
    expect(report.ok).toBe(true)
    const impact = JSON.parse(
      await readFile(join(graphsDir, GRAPH_FILES.impact), "utf8"),
    ) as { meta: { source: string; excludedAgentRows: number } }
    expect(impact.meta.source).toBe("unit recapture")
    expect(impact.meta.excludedAgentRows).toBe(1)
  })
})
