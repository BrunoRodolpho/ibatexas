// harness/cost.ts — dollar conversion for journey runs (T1a-13).
//
// THE dollar source is `llm.call` events (required inputTokens/outputTokens
// — plan §7): the persona driver's calls are captured in-process
// (source:"driver", stamped with the runId), and the SUT's Conductor turns
// are re-emitted by the api's TelemetryPort and appended to IBX_EVENTS_FILE
// (source:"sut", stamped with the chat sessionId). Conversion runs through
// the CHECKED-IN price table (packages/journeys/governance/price-table.json,
// USD per MTok — Sonnet 4.6 $3 in / $15 out, plan §7):
//
//   costUsd = Σ (inputTokens × inputUsdPerMTok + outputTokens × outputUsdPerMTok) / 1e6
//
// A model id missing from the table throws `PriceTableError` — a cost report
// must fail loudly, never silently price a model at $0.

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { IbxEventBase } from "@ibatexas/tools"

/** The checked-in price table home (same anchor idiom as DEFAULT_JOURNEYS_DIR). */
export const DEFAULT_PRICE_TABLE_PATH = fileURLToPath(
  new URL("../../governance/price-table.json", import.meta.url),
)

export class PriceTableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PriceTableError"
  }
}

export interface ModelPrice {
  inputUsdPerMTok: number
  outputUsdPerMTok: number
}

export interface PriceTable {
  models: Record<string, ModelPrice>
}

export function loadPriceTable(path: string = DEFAULT_PRICE_TABLE_PATH): PriceTable {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (err) {
    throw new PriceTableError(`price table unreadable at ${path}: ${(err as Error).message}`)
  }
  const models = (raw as { models?: unknown }).models
  if (typeof models !== "object" || models === null) {
    throw new PriceTableError(`price table at ${path} has no "models" map`)
  }
  for (const [id, price] of Object.entries(models as Record<string, unknown>)) {
    const p = price as Partial<ModelPrice>
    if (typeof p.inputUsdPerMTok !== "number" || typeof p.outputUsdPerMTok !== "number") {
      throw new PriceTableError(
        `price table entry "${id}" must carry numeric inputUsdPerMTok + outputUsdPerMTok`,
      )
    }
  }
  return { models: models as Record<string, ModelPrice> }
}

// ── Cost aggregation over llm.call events ────────────────────────────────────

export interface LlmCallLike {
  model?: string
  inputTokens: number
  outputTokens: number
}

export interface TokenSplit {
  in: number
  out: number
}

export interface CostSide {
  calls: number
  tokens: TokenSplit
  costUsd: number
}

export interface AttemptCost {
  driver: CostSide
  sut: CostSide
  totalUsd: number
}

function priceFor(table: PriceTable, model: string | undefined): ModelPrice {
  if (model === undefined || model === "") {
    throw new PriceTableError("llm.call event carries no model id — cannot price the call")
  }
  const price = table.models[model]
  if (price === undefined) {
    throw new PriceTableError(
      `model "${model}" is not in the checked-in price table ` +
        `(packages/journeys/governance/price-table.json) — add it before pricing runs`,
    )
  }
  return price
}

export function costOfCalls(table: PriceTable, calls: readonly LlmCallLike[]): CostSide {
  let inputTokens = 0
  let outputTokens = 0
  let usd = 0
  for (const call of calls) {
    const price = priceFor(table, call.model)
    inputTokens += call.inputTokens
    outputTokens += call.outputTokens
    usd += (call.inputTokens * price.inputUsdPerMTok + call.outputTokens * price.outputUsdPerMTok) / 1e6
  }
  return { calls: calls.length, tokens: { in: inputTokens, out: outputTokens }, costUsd: usd }
}

export function attemptCost(
  table: PriceTable,
  driverCalls: readonly LlmCallLike[],
  sutCalls: readonly LlmCallLike[],
): AttemptCost {
  const driver = costOfCalls(table, driverCalls)
  const sut = costOfCalls(table, sutCalls)
  return { driver, sut, totalUsd: driver.costUsd + sut.costUsd }
}

// ── SUT event-file parsing (IBX_EVENTS_FILE JSONL) ───────────────────────────

/**
 * Parse `llm.call {source:"sut"}` events out of the IBX_EVENTS_FILE JSONL,
 * keeping only events whose `sessionId` is in `sessionIds` (the run's chat
 * conversation handles — fresh UUIDs, so stale lines from earlier runs are
 * inert). Unparseable lines are skipped (the file is append-shared).
 */
export function readSutLlmCalls(
  eventsFilePath: string,
  sessionIds: ReadonlySet<string>,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): IbxEventBase[] {
  let raw: string
  try {
    raw = readFile(eventsFilePath)
  } catch {
    return [] // absent file = the SUT emitted nothing (surfaced as zero SUT cost)
  }
  const calls: IbxEventBase[] = []
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue
    let event: IbxEventBase
    try {
      event = JSON.parse(line) as IbxEventBase
    } catch {
      continue
    }
    if (event.type !== "llm.call") continue
    if (event.source !== "sut") continue
    if (event.sessionId === undefined || !sessionIds.has(event.sessionId)) continue
    calls.push(event)
  }
  return calls
}

// ── Cost-line rendering (English — dev/CI output) ────────────────────────────

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`
}

export function renderCostLine(label: string, cost: AttemptCost): string {
  return (
    `cost[${label}]: total ${formatUsd(cost.totalUsd)} ` +
    `(driver ${formatUsd(cost.driver.costUsd)} in=${cost.driver.tokens.in} out=${cost.driver.tokens.out} calls=${cost.driver.calls}; ` +
    `sut ${formatUsd(cost.sut.costUsd)} in=${cost.sut.tokens.in} out=${cost.sut.tokens.out} calls=${cost.sut.calls})`
  )
}
