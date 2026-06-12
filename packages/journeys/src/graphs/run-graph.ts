// graphs/run-graph.ts — derived run graph (T2-4).
//
//   acts → observed envelopes → decisions
//
// Inputs (the generator is pure given them):
//   * a run's `trace.jsonl` (the JSONL the harness writes to
//     `runs/<runId>/trace.jsonl` — journey.*/act.*/chat.turn.*/llm.call/
//     verify.outcome events, @ibatexas/tools emitter shapes);
//   * the run's observed kernel decisions — live runs recover them from
//     `sim_runs`/`intent_audit` via the T1b-5 hashed-sessionId join; the
//     committed artifact uses a checked-in SANITIZED decisions fixture
//     (graphs/fixtures/run-decisions.json — synthetic ids, real shape).
//
// Envelope→act attribution is temporal: an envelope whose `at` falls inside
// an act's [act.start, act.end] window hangs off that act; envelopes outside
// every act window (e.g. rows landed during the verify-phase settle barrier)
// hang off the run node directly — never dropped.
//
// The COMMITTED artifact (`graphs/run-fixture.json`) is generated from the
// checked-in sample trace, NEVER from live data (run traces are gitignored
// and may carry per-run identifiers).

import { z } from "zod"

import {
  INTENT_KIND_PATTERN,
  JOURNEY_EXPECT_DECISIONS,
  type JsonValue,
} from "../schema/index.js"
import {
  finalizeGraph,
  GraphContractError,
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
} from "./contract.js"

// ── Trace parsing ────────────────────────────────────────────────────────────

/** Loose trace-event view — the emitter's wide shape, narrowed by `type`. */
export interface RunTraceEvent {
  type: string
  timestamp: string
  [key: string]: unknown
}

export class RunTraceParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RunTraceParseError"
  }
}

/** Parse trace JSONL text. Blank lines are skipped; bad JSON throws. */
export function parseTraceJsonl(text: string): RunTraceEvent[] {
  const events: RunTraceEvent[] = []
  const lines = text.split("\n")
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed === "") return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new RunTraceParseError(`trace line ${i + 1} is not valid JSON`)
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof (parsed as { type?: unknown }).type !== "string"
    ) {
      throw new RunTraceParseError(`trace line ${i + 1} has no string "type"`)
    }
    events.push(parsed as RunTraceEvent)
  })
  return events
}

// ── Decisions input (the sim_runs/intent_audit join, or its fixture) ─────────

export const RunDecisionsFileSchema = z
  .object({
    comment: z.union([z.string(), z.array(z.string())]).optional(),
    runId: z.string().min(1),
    journeyId: z.string().min(1),
    /** Provenance label (e.g. "sanitized fixture" / "sim_runs join"). */
    source: z.string().min(1),
    decisions: z.array(
      z
        .object({
          intentKind: z.string().regex(INTENT_KIND_PATTERN),
          decision: z.enum(JOURNEY_EXPECT_DECISIONS),
          /** ISO recorded_at of the audit row. */
          at: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict()

export type RunDecisionsFile = z.infer<typeof RunDecisionsFileSchema>

// ── Builder ──────────────────────────────────────────────────────────────────

interface ActWindow {
  index: number
  name: string
  kind: string
  startedAt: string | null
  endedAt: string | null
  outcome: string | null
  durationMs: number | null
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * Build the run graph from parsed trace events + the run's observed kernel
 * decisions. Pure. Throws `GraphContractError` when the decisions file's
 * runId disagrees with the trace's (mixing two runs is always a bug).
 */
export function buildRunGraph(args: {
  events: ReadonlyArray<RunTraceEvent>
  decisions: RunDecisionsFile
}): GraphDocument {
  const { events, decisions } = args

  const journeyStart = events.find((e) => e.type === "journey.start")
  const traceRunId = str(journeyStart?.runId)
  if (traceRunId !== null && traceRunId !== decisions.runId) {
    throw new GraphContractError(
      `run-graph input mismatch: trace runId "${traceRunId}" != decisions runId "${decisions.runId}"`,
    )
  }
  const runId = decisions.runId
  const journeyId = str(journeyStart?.journey) ?? decisions.journeyId
  const journeyEnd = events.find((e) => e.type === "journey.end")

  // ── Acts (paired act.start/act.end by actIndex) ───────────────────────────
  const acts = new Map<number, ActWindow>()
  for (const event of events) {
    if (event.type !== "act.start" && event.type !== "act.end") continue
    const index = num(event.actIndex)
    if (index === null) continue
    const window =
      acts.get(index) ??
      ({
        index,
        name: str(event.act) ?? `act-${index + 1}`,
        kind: str(event.actKind) ?? "unknown",
        startedAt: null,
        endedAt: null,
        outcome: null,
        durationMs: null,
      } satisfies ActWindow)
    if (event.type === "act.start") {
      window.startedAt = event.timestamp
    } else {
      window.endedAt = event.timestamp
      window.outcome = str(event.outcome)
      window.durationMs = num(event.duration)
    }
    acts.set(index, window)
  }

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const runNodeId = `run:${runId}`

  const turns = events.filter(
    (e) => e.type === "chat.turn.end" && e.outcome === "pass",
  ).length
  nodes.push({
    id: runNodeId,
    type: "run",
    label: `${journeyId} run ${runId}`,
    meta: {
      runId,
      journeyId,
      outcome: str(journeyEnd?.outcome),
      durationMs: num(journeyEnd?.duration),
      turns,
      events: events.length,
      decisionsSource: decisions.source,
    },
  })

  for (const act of [...acts.values()].sort((a, b) => a.index - b.index)) {
    const actNodeId = `act:${act.index}`
    nodes.push({
      id: actNodeId,
      type: "act",
      label: act.name,
      meta: {
        index: act.index,
        kind: act.kind,
        outcome: act.outcome,
        durationMs: act.durationMs,
      },
    })
    edges.push({ from: runNodeId, to: actNodeId, type: "has-act", meta: { index: act.index } })
  }

  // ── Envelopes → decisions ─────────────────────────────────────────────────
  const decisionCounts = new Map<string, number>()
  const ordered = [...decisions.decisions].sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
  )
  ordered.forEach((decision, seq) => {
    const envelopeNodeId = `envelope:${seq}`
    nodes.push({
      id: envelopeNodeId,
      type: "envelope",
      label: decision.intentKind,
      meta: { seq, intentKind: decision.intentKind, decision: decision.decision, at: decision.at },
    })
    decisionCounts.set(
      decision.decision,
      (decisionCounts.get(decision.decision) ?? 0) + 1,
    )

    // Temporal attribution: inside an act's [start, end] window → that act;
    // otherwise (settle-barrier rows etc.) directly off the run node.
    const owner = [...acts.values()].find(
      (act) =>
        act.startedAt !== null &&
        act.endedAt !== null &&
        decision.at >= act.startedAt &&
        decision.at <= act.endedAt,
    )
    edges.push({
      from: owner !== undefined ? `act:${owner.index}` : runNodeId,
      to: envelopeNodeId,
      type: "observed",
    })
    edges.push({
      from: envelopeNodeId,
      to: `decision:${decision.decision}`,
      type: "decided",
    })
  })

  for (const [decisionKind, count] of decisionCounts) {
    nodes.push({
      id: `decision:${decisionKind}`,
      type: "decision",
      label: decisionKind,
      meta: { count },
    })
  }

  // ── Verify outcomes (the trace's verify.outcome records) ─────────────────
  let verifySeq = 0
  for (const event of events) {
    if (event.type !== "verify.outcome") continue
    const invariant = str(event.invariant) ?? "unknown"
    const verifyNodeId = `verify:${verifySeq}:${invariant}`
    verifySeq += 1
    nodes.push({
      id: verifyNodeId,
      type: "verify",
      label: invariant,
      meta: {
        invariant,
        outcome: str(event.outcome),
        detail: str(event.detail),
      } as Record<string, JsonValue>,
    })
    edges.push({ from: runNodeId, to: verifyNodeId, type: "verified" })
  }

  return finalizeGraph({
    version: 1,
    graph: "run",
    meta: {
      runId,
      journeyId,
      acts: acts.size,
      envelopes: ordered.length,
      verifyOutcomes: verifySeq,
      decisionsSource: decisions.source,
    },
    nodes,
    edges,
  })
}
