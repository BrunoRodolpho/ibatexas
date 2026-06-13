// trace.jsonl parsing + run/cost summaries for the run explorer.
// Mirrors the writer (packages/journeys/src/harness/run-journey-cli.ts):
// in-process events + the run's SUT llm.call events + verify.outcome lines.
// Cost = Σ llm.call tokens × the committed price table (per-MTok USD), split
// by event source (driver vs sut) — same arithmetic as the harness's
// attemptCost (a model id missing from the table is flagged, never $0).

import type { PriceTable, TraceEvent } from "../types"

export interface ParsedTrace {
  events: TraceEvent[]
  /** Lines that failed to parse — surfaced, never silently dropped. */
  badLines: number
}

export function parseTraceJsonl(text: string): ParsedTrace {
  const events: TraceEvent[] = []
  let badLines = 0
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as TraceEvent).type === "string"
      ) {
        events.push(parsed as TraceEvent)
      } else {
        badLines += 1
      }
    } catch {
      badLines += 1
    }
  }
  return { events, badLines }
}

// ── Run summary ──────────────────────────────────────────────────────────────

export interface RunSummary {
  journeyId: string | null
  runId: string | null
  outcome: string | null
  durationMs: number | null
  turns: number
  acts: { pass: number; fail: number }
  verifies: { pass: number; fail: number }
}

export function summarizeRun(events: TraceEvent[]): RunSummary {
  const journeyEnd = events.find((e) => e.type === "journey.end")
  const first = events.find((e) => typeof e["journey"] === "string")
  const summary: RunSummary = {
    journeyId: typeof first?.["journey"] === "string" ? first["journey"] : null,
    runId: typeof first?.["runId"] === "string" ? first["runId"] : null,
    outcome: typeof journeyEnd?.["outcome"] === "string" ? journeyEnd["outcome"] : null,
    durationMs:
      typeof journeyEnd?.["duration"] === "number" ? journeyEnd["duration"] : null,
    turns: 0,
    acts: { pass: 0, fail: 0 },
    verifies: { pass: 0, fail: 0 },
  }
  for (const e of events) {
    const pass = e["outcome"] === "pass"
    if (e.type === "chat.turn.end" && pass) summary.turns += 1
    if (e.type === "act.end") summary.acts[pass ? "pass" : "fail"] += 1
    if (e.type === "verify.outcome") summary.verifies[pass ? "pass" : "fail"] += 1
  }
  return summary
}

// ── Cost summary ─────────────────────────────────────────────────────────────

export interface CostLeg {
  calls: number
  inputTokens: number
  outputTokens: number
  /** null when any of the leg's models is missing from the price table. */
  costUsd: number | null
}

export interface CostSummary {
  driver: CostLeg
  sut: CostLeg
  totalUsd: number | null
  /** Model ids seen in llm.call events but absent from the price table. */
  unpricedModels: string[]
}

function emptyLeg(): CostLeg {
  return { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
}

export function summarizeCost(
  events: TraceEvent[],
  priceTable: PriceTable | null,
): CostSummary {
  const legs = { driver: emptyLeg(), sut: emptyLeg() }
  const unpriced = new Set<string>()

  for (const e of events) {
    if (e.type !== "llm.call") continue
    const leg = e["source"] === "sut" ? legs.sut : legs.driver
    const inputTokens = typeof e["inputTokens"] === "number" ? e["inputTokens"] : 0
    const outputTokens = typeof e["outputTokens"] === "number" ? e["outputTokens"] : 0
    leg.calls += 1
    leg.inputTokens += inputTokens
    leg.outputTokens += outputTokens

    const model = typeof e["model"] === "string" ? e["model"] : "unknown"
    const price = priceTable?.models[model]
    if (price === undefined) {
      unpriced.add(model)
      leg.costUsd = null
    } else if (leg.costUsd !== null) {
      leg.costUsd +=
        (inputTokens * price.inputUsdPerMTok + outputTokens * price.outputUsdPerMTok) /
        1e6
    }
  }

  return {
    driver: legs.driver,
    sut: legs.sut,
    totalUsd:
      legs.driver.costUsd !== null && legs.sut.costUsd !== null
        ? legs.driver.costUsd + legs.sut.costUsd
        : null,
    unpricedModels: [...unpriced].sort(),
  }
}

export function formatUsd(usd: number | null): string {
  return usd === null ? "unpriced" : `$${usd.toFixed(4)}`
}
