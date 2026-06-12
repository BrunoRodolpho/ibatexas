// runner/run-journey.ts — small sequential journey runner skeleton.
//
// Executes a journey's acts strictly in order against INJECTED act
// executors and emits `journey.*` / `act.*` events through the shared
// emitter in `@ibatexas/tools` (JSONL on stderr under `IBX_EVENTS=json`).
//
// The executors are implemented by later tasks and injected here:
//   chat    → ChatClient + test-driver loop (T1a-5 / T1a-8)
//   http    → authFixture-backed HTTP client (T1a-4)
//   fixture → seed-helper dispatch — PRECONDITIONS ONLY (schema governance)
//
// This runner is deliberately NOT the cli's `runPipeline` (the `ibx
// scenario` data-state engine stays untouched — journeys ≠ scenarios).

import { randomUUID } from "node:crypto"
import {
  emitActEnd,
  emitActStart,
  emitJourneyEnd,
  emitJourneyStart,
} from "@ibatexas/tools"

import type {
  ChatAct,
  FixtureAct,
  HttpAct,
  Journey,
  JourneyAct,
  JsonValue,
} from "../schema/index.js"

// ── Contracts ────────────────────────────────────────────────────────────────

export interface JourneyRunContext {
  journeyId: string
  runId: string
  /**
   * Mutable variable bag shared across acts. The test driver surfaces
   * entity references here by HANDLE only — never raw Medusa ids
   * (the schema lint rejects them in YAML; executors must not reintroduce
   * them as journey inputs).
   */
  vars: Record<string, unknown>
  /** The journey's variant params (read-only). */
  params: Readonly<Record<string, JsonValue>>
}

export interface ActExecutionResult {
  ok: boolean
  detail?: string
}

export type ActExecutor<A extends JourneyAct> = (
  act: A,
  ctx: JourneyRunContext,
) => Promise<ActExecutionResult | void>

/** Injected per-kind executors — implemented by later Phase-1a tasks. */
export interface ActExecutors {
  chat: ActExecutor<ChatAct>
  http: ActExecutor<HttpAct>
  fixture: ActExecutor<FixtureAct>
}

export type ActOutcome = "pass" | "fail" | "error"

export interface ActRunRecord {
  index: number
  name: string
  kind: JourneyAct["kind"]
  outcome: ActOutcome
  durationMs: number
  detail?: string
}

export interface JourneyRunResult {
  journeyId: string
  runId: string
  ok: boolean
  acts: ActRunRecord[]
  /** Set when an executor threw (outcome "error") or an act failed. */
  error?: string
}

/** Thrown when a `status: blocked` journey is run without `allowBlocked`. */
export class JourneyBlockedError extends Error {
  constructor(journey: Journey) {
    super(
      `journey_blocked: ${journey.id} is blocked by [${journey.blocked_by.join(", ")}] — pass allowBlocked to force`,
    )
    this.name = "JourneyBlockedError"
  }
}

export interface RunJourneyOptions {
  /** Fixed run id (defaults to a fresh UUID). */
  runId?: string
  /** Pre-seeded ctx.vars. */
  vars?: Record<string, unknown>
  /** Run a `status: blocked` journey anyway (debugging only). */
  allowBlocked?: boolean
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function executeAct(
  act: JourneyAct,
  ctx: JourneyRunContext,
  executors: ActExecutors,
): Promise<ActExecutionResult | void> {
  switch (act.kind) {
    case "chat":
      return executors.chat(act, ctx)
    case "http":
      return executors.http(act, ctx)
    case "fixture":
      return executors.fixture(act, ctx)
  }
}

/**
 * Run a journey's acts sequentially. Fail-fast: the first failing/throwing
 * act stops the run. Never throws for act-level failures — returns a
 * result; throws only `JourneyBlockedError` for blocked journeys.
 */
export async function runJourney(
  journey: Journey,
  executors: ActExecutors,
  opts: RunJourneyOptions = {},
): Promise<JourneyRunResult> {
  if (journey.status === "blocked" && opts.allowBlocked !== true) {
    throw new JourneyBlockedError(journey)
  }

  const runId = opts.runId ?? randomUUID()
  const ctx: JourneyRunContext = {
    journeyId: journey.id,
    runId,
    vars: opts.vars ?? {},
    params: journey.params ?? {},
  }

  const records: ActRunRecord[] = []
  let runError: string | undefined
  const journeyStart = Date.now()
  emitJourneyStart(journey.id, runId)

  for (const [index, act] of journey.acts.entries()) {
    const name = act.name ?? `act-${index + 1}:${act.kind}`
    emitActStart(journey.id, runId, name, act.kind, index)
    const actStart = Date.now()

    let outcome: ActOutcome
    let detail: string | undefined
    try {
      const result = await executeAct(act, ctx, executors)
      outcome = result === undefined || result.ok ? "pass" : "fail"
      detail = result?.detail
    } catch (err) {
      outcome = "error"
      detail = (err as Error).message
      runError = detail
    }

    const durationMs = Date.now() - actStart
    emitActEnd(journey.id, runId, name, act.kind, index, durationMs, outcome, detail)
    records.push({ index, name, kind: act.kind, outcome, durationMs, ...(detail !== undefined ? { detail } : {}) })

    if (outcome !== "pass") break // sequential + fail-fast
  }

  const ok = records.length === journey.acts.length && records.every((r) => r.outcome === "pass")
  emitJourneyEnd(journey.id, runId, Date.now() - journeyStart, ok ? "pass" : runError !== undefined ? "error" : "fail")

  return {
    journeyId: journey.id,
    runId,
    ok,
    acts: records,
    ...(runError !== undefined
      ? { error: runError }
      : !ok
        ? { error: records.at(-1)?.detail ?? "act_failed" }
        : {}),
  }
}
