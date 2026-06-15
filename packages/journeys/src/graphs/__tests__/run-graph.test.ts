// Tests for graphs/run-graph.ts — acts → observed envelopes → decisions,
// built from the committed sanitized fixtures (T2-4).
import { describe, it, expect } from "vitest"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import {
  buildRunGraph,
  parseTraceJsonl,
  RunDecisionsFileSchema,
  RunTraceParseError,
} from "../run-graph.js"
import { GraphContractError, serializeGraph } from "../contract.js"
import {
  DEFAULT_GRAPHS_DIR,
  RUN_DECISIONS_FIXTURE,
  RUN_TRACE_FIXTURE,
} from "../export.js"

async function loadFixtures() {
  const traceText = await readFile(join(DEFAULT_GRAPHS_DIR, RUN_TRACE_FIXTURE), "utf8")
  const decisionsRaw = JSON.parse(
    await readFile(join(DEFAULT_GRAPHS_DIR, RUN_DECISIONS_FIXTURE), "utf8"),
  ) as unknown
  const decisions = RunDecisionsFileSchema.parse(decisionsRaw)
  return { events: parseTraceJsonl(traceText), decisions }
}

describe("parseTraceJsonl", () => {
  it("parses JSONL, skipping blank lines", () => {
    const events = parseTraceJsonl(
      '{"type":"journey.start","timestamp":"t"}\n\n{"type":"journey.end","timestamp":"t"}\n',
    )
    expect(events.map((e) => e.type)).toEqual(["journey.start", "journey.end"])
  })

  it("throws a named error on malformed lines", () => {
    expect(() => parseTraceJsonl("not json\n")).toThrow(RunTraceParseError)
    expect(() => parseTraceJsonl('{"timestamp":"t"}\n')).toThrow(/no string "type"/)
  })
})

describe("buildRunGraph (committed sanitized fixture)", () => {
  it("builds run → acts → envelopes → decisions with verify nodes", async () => {
    const { events, decisions } = await loadFixtures()
    const graph = buildRunGraph({ events, decisions })
    const byType = (t: string) => graph.nodes.filter((n) => n.type === t)

    expect(byType("run")).toHaveLength(1)
    expect(byType("act")).toHaveLength(7) // JOURNEY-001's seven acts
    expect(byType("envelope")).toHaveLength(5)
    expect(byType("verify")).toHaveLength(4)
    // EXECUTE + REQUEST_CONFIRMATION decision buckets.
    expect(byType("decision").map((n) => n.id).sort()).toEqual([
      "decision:EXECUTE",
      "decision:REQUEST_CONFIRMATION",
    ])
    const execute = graph.nodes.find((n) => n.id === "decision:EXECUTE")
    expect(execute?.meta?.count).toBe(4)
  })

  it("attributes envelopes to acts temporally, off-window ones to the run", async () => {
    const { events, decisions } = await loadFixtures()
    const graph = buildRunGraph({ events, decisions })
    const observed = graph.edges.filter((e) => e.type === "observed")
    expect(observed).toHaveLength(5)

    // Envelope 0 (checkout EXECUTE @12:00:05.2) falls inside act 4's window.
    expect(observed.find((e) => e.to === "envelope:0")?.from).toBe("act:4")
    // Envelope 1 (chat-cancel confirm @12:00:11) falls inside act 5's window.
    expect(observed.find((e) => e.to === "envelope:1")?.from).toBe("act:5")
    // Envelopes 2-4 (http cancel + inner transitions) inside act 6's window.
    expect(observed.find((e) => e.to === "envelope:2")?.from).toBe("act:6")
    expect(observed.find((e) => e.to === "envelope:4")?.from).toBe("act:6")
  })

  it("hangs envelopes outside every act window off the run node", () => {
    const graph = buildRunGraph({
      events: [
        { type: "journey.start", timestamp: "2026-06-12T00:00:00.000Z", journey: "JOURNEY-901", runId: "r-1" },
        { type: "act.start", timestamp: "2026-06-12T00:00:01.000Z", actIndex: 0, act: "a", actKind: "chat" },
        { type: "act.end", timestamp: "2026-06-12T00:00:02.000Z", actIndex: 0, act: "a", actKind: "chat", outcome: "pass", duration: 1000 },
      ],
      decisions: {
        runId: "r-1",
        journeyId: "JOURNEY-901",
        source: "test",
        decisions: [
          // Settled AFTER the act ended (verify-phase barrier row).
          { intentKind: "order.cancel", decision: "EXECUTE", at: "2026-06-12T00:00:09.000Z" },
        ],
      },
    })
    const edge = graph.edges.find((e) => e.type === "observed")
    expect(edge?.from).toBe("run:r-1")
  })

  it("refuses a decisions file from a different run", async () => {
    const { events, decisions } = await loadFixtures()
    expect(() =>
      buildRunGraph({ events, decisions: { ...decisions, runId: "another-run" } }),
    ).toThrow(GraphContractError)
  })

  it("is deterministic", async () => {
    const { events, decisions } = await loadFixtures()
    expect(serializeGraph(buildRunGraph({ events, decisions }))).toBe(
      serializeGraph(buildRunGraph({ events, decisions })),
    )
  })
})
