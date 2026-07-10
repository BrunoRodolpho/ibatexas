// events/emitter.ts — structured JSONL event emitter.
//
// Home of the `IBX_EVENTS=json` convention: when the env var is set, every
// event is written to **stderr** as one JSON object per line (JSONL), so a
// run can be captured with `2> events.jsonl`. Otherwise events are consumed
// internally by registered listeners (timing/formatting/tests).
//
// History: this module started life as `packages/cli/src/lib/events.ts`
// (scenario-engine events). It moved here (T1a-1) so that BOTH planes can
// emit through one union without a workspace cycle:
//
//   - `ibx scenario` (the existing data-state engine in packages/cli)
//     keeps its `scenario.*` / `step.*` / `verify.*` / ... kinds; the cli
//     re-exports this module from `lib/events.ts` so call sites are
//     unchanged.
//   - journeys (the LLM-driven test plane, `@ibatexas/journeys`) emit the
//     `journey.*` / `act.*` / `llm.call` / `evidence.*` kinds added below.
//     Dependency direction stays one-way: journeys→tools, cli→tools —
//     never cli↔journeys.
//
// `llm.call` is the dollar source: `inputTokens` / `outputTokens` are
// REQUIRED on every emission (cost reports are computed from these events
// × the checked-in price table — plan §7). `source` splits the dollar
// report: "driver" (the persona test driver's own model calls) vs "sut"
// (the api's Conductor turns, re-emitted from TelemetryPort.emitTurn).
//
// File sink (T1a-13): when `IBX_EVENTS=json` AND `IBX_EVENTS_FILE=<path>`
// are both set, every JSONL line is ALSO appended (line-buffered,
// append-mode) to that file — the journey harness parses SUT-side events
// from it instead of scraping process logs. Unset (prod/dev) = exactly the
// previous behavior. File-write failures are swallowed: telemetry must
// never break the emitting process.

import { appendFileSync } from "node:fs"

// ── Event-kind unions ────────────────────────────────────────────────────────

/** Kinds emitted by the `ibx scenario` data-state engine (packages/cli). */
export type ScenarioEventType =
  | "scenario.start"
  | "scenario.finish"
  | "step.start"
  | "step.finish"
  | "tag.apply"
  | "verify.pass"
  | "verify.fail"
  | "verify.warn"
  | "lock.acquire"
  | "lock.release"
  | "cache.hit"
  | "cache.miss"
  | "cleanup.start"
  | "cleanup.finish"

/** Kinds emitted by the journey test plane (@ibatexas/journeys). */
export type JourneyEventType =
  | "journey.start"
  | "journey.end"
  | "journey.aborted"
  | "preflight.check"
  | "act.start"
  | "act.end"
  | "chat.turn.start"
  | "chat.turn.end"
  | "llm.call"
  | "evidence.capture"
  | "evidence.persist"

export type IbxEventType = ScenarioEventType | JourneyEventType

/** Journey act kinds (mirrors the JourneyFileSchema act discriminator). */
export type ActKindName = "chat" | "http" | "raw-envelope" | "fixture"

/** Terminal outcome of a journey / act / chat-turn. */
export type EventOutcome = "pass" | "fail" | "error"

// ── Event shapes ─────────────────────────────────────────────────────────────

/**
 * Common event shape — every field beyond `type`/`timestamp` is optional so
 * each kind carries only what it needs. Listeners receive this wide shape
 * and narrow on `type`.
 */
export interface IbxEventBase {
  type: IbxEventType
  timestamp: string
  // scenario plane
  scenario?: string
  step?: string
  /** duration in ms */
  duration?: number
  detail?: string
  // journey plane
  journey?: string
  runId?: string
  act?: string
  actKind?: ActKindName
  actIndex?: number
  outcome?: EventOutcome
  // preflight.check — which environment-handshake check this record is for
  check?: string
  // journey.aborted — machine-readable abort reason (e.g. "token_ceiling")
  reason?: string
  // chat.turn.* (T1a-5 ChatClient) — SUT conversation handle + 1-based turn no.
  sessionId?: string
  turn?: number
  // llm.call (required there — see LlmCallEvent)
  model?: string
  inputTokens?: number
  outputTokens?: number
  /** llm.call cost attribution: persona driver ("driver") vs the api under test ("sut"). */
  source?: "driver" | "sut"
  // evidence.*
  evidence?: string
}

/**
 * Legacy scenario-plane event shape, kept exactly as it was in
 * `packages/cli/src/lib/events.ts` (the cli re-exports it). Assignable to
 * `IbxEvent`, so pre-move call sites compile unchanged.
 */
export interface ScenarioEvent {
  type: ScenarioEventType
  timestamp: string
  scenario?: string
  step?: string
  duration?: number
  detail?: string
}

/**
 * `llm.call` — one event per provider round-trip. Token counts are REQUIRED:
 * they are the only input to the cost report (plan §7), so an `llm.call`
 * without them is unrepresentable at the type level.
 */
export interface LlmCallEvent extends Omit<IbxEventBase, "type"> {
  type: "llm.call"
  inputTokens: number
  outputTokens: number
}

/**
 * What `emit()` accepts: any non-`llm.call` event with the base shape, or a
 * fully-token-counted `llm.call`.
 */
export type IbxEvent =
  | (IbxEventBase & { type: Exclude<IbxEventType, "llm.call"> })
  | LlmCallEvent

// ── Internal listener support ────────────────────────────────────────────────

type EventListener = (event: IbxEventBase) => void

const listeners: EventListener[] = []

/**
 * Register an event listener (for programmatic use, e.g. tests or dashboards).
 * Returns an unsubscribe function.
 */
export function onEvent(listener: EventListener): () => void {
  listeners.push(listener)
  return () => {
    const idx = listeners.indexOf(listener)
    if (idx >= 0) listeners.splice(idx, 1)
  }
}

// ── Emit ─────────────────────────────────────────────────────────────────────

/**
 * Emit a structured event.
 *
 * - If `IBX_EVENTS=json` → writes one JSON line to stderr
 * - If additionally `IBX_EVENTS_FILE=<path>` → appends the same line to that
 *   file (append mode, line-buffered via a synchronous append — the line is
 *   durable before the emitter returns). Test-profile wiring only; unset =
 *   today's behavior. Failures are swallowed (telemetry never breaks a turn).
 * - Always dispatches to registered listeners
 */
export function emit(event: IbxEvent): void {
  // JSONL output for CI integration: ibx scenario homepage 2> events.jsonl
  if (process.env.IBX_EVENTS === "json") {
    const line = `${JSON.stringify(event)}\n`
    process.stderr.write(line)
    const file = process.env.IBX_EVENTS_FILE
    if (file !== undefined && file !== "") {
      try {
        appendFileSync(file, line)
      } catch {
        // Best-effort file sink — never let trace persistence break the caller.
      }
    }
  }

  // Dispatch to internal listeners
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // Don't let a listener crash the engine
    }
  }
}

// ── Convenience helpers — scenario plane (unchanged cli surface) ─────────────

export function emitScenarioStart(scenario: string): void {
  emit({ type: "scenario.start", timestamp: new Date().toISOString(), scenario })
}

export function emitScenarioFinish(scenario: string, duration: number): void {
  emit({ type: "scenario.finish", timestamp: new Date().toISOString(), scenario, duration })
}

export function emitStepStart(scenario: string, step: string): void {
  emit({ type: "step.start", timestamp: new Date().toISOString(), scenario, step })
}

export function emitStepFinish(scenario: string, step: string, duration: number): void {
  emit({ type: "step.finish", timestamp: new Date().toISOString(), scenario, step, duration })
}

// ── Convenience helpers — journey plane ──────────────────────────────────────

export function emitJourneyStart(journey: string, runId: string): void {
  emit({ type: "journey.start", timestamp: new Date().toISOString(), journey, runId })
}

export function emitJourneyEnd(
  journey: string,
  runId: string,
  duration: number,
  outcome: EventOutcome,
): void {
  emit({ type: "journey.end", timestamp: new Date().toISOString(), journey, runId, duration, outcome })
}

export function emitActStart(
  journey: string,
  runId: string,
  act: string,
  actKind: ActKindName,
  actIndex: number,
): void {
  emit({ type: "act.start", timestamp: new Date().toISOString(), journey, runId, act, actKind, actIndex })
}

export function emitActEnd(
  journey: string,
  runId: string,
  act: string,
  actKind: ActKindName,
  actIndex: number,
  duration: number,
  outcome: EventOutcome,
  detail?: string,
): void {
  emit({
    type: "act.end",
    timestamp: new Date().toISOString(),
    journey,
    runId,
    act,
    actKind,
    actIndex,
    duration,
    outcome,
    ...(detail === undefined ? {} : { detail }),
  })
}

/**
 * `chat.turn.start` — the ChatClient (T1a-5) is about to POST one user turn
 * to the SUT's chat surface. Turn wall-clock is the CLIENT-side llm boundary;
 * the SUT's own provider costs are measured server-side via `llm.call`.
 */
export function emitChatTurnStart(args: {
  sessionId: string
  turn: number
  journey?: string
  runId?: string
  detail?: string
}): void {
  emit({ type: "chat.turn.start", timestamp: new Date().toISOString(), ...args })
}

/**
 * `chat.turn.end` — the turn reached its terminal state (SSE `done`, an SSE
 * `error` event, or a transport failure). `duration` is the turn wall-clock
 * (ms); `detail` carries the post/stream/barrier breakdown — never secrets.
 */
export function emitChatTurnEnd(args: {
  sessionId: string
  turn: number
  duration: number
  outcome: EventOutcome
  journey?: string
  runId?: string
  detail?: string
}): void {
  emit({ type: "chat.turn.end", timestamp: new Date().toISOString(), ...args })
}

/**
 * One environment-handshake pre-flight check (T1a-10). The harness records
 * EVERY check — pass or fail — into the JSONL trace before refusing/running.
 * `detail` must never contain secret values (e.g. ANTHROPIC_API_KEY).
 */
export function emitPreflightCheck(args: {
  check: string
  outcome: "pass" | "fail"
  detail?: string
  journey?: string
  runId?: string
}): void {
  emit({ type: "preflight.check", timestamp: new Date().toISOString(), ...args })
}

/**
 * `journey.aborted` — the run attempt was cut short by a budget/guard, not
 * by an act outcome (T1a-8: the driver's per-attempt token ceiling emits
 * `reason: "token_ceiling"`; T1b-8's suite-level dollar abort emits
 * `reason: "dollar_cap"`). Emitted BEFORE the abort error propagates so the
 * JSONL trace always carries the reason.
 */
export function emitJourneyAborted(args: {
  journey: string
  runId: string
  reason: string
  detail?: string
}): void {
  emit({ type: "journey.aborted", timestamp: new Date().toISOString(), ...args })
}

/**
 * `evidence.capture` — a piece of run evidence was captured (T1a-8: the
 * test driver surfaced an entity id/handle into ctx.vars; `evidence` is the
 * var name, `detail` its value — handles/codes only, never secrets).
 */
export function emitEvidenceCapture(args: {
  evidence: string
  detail?: string
  journey?: string
  runId?: string
}): void {
  emit({ type: "evidence.capture", timestamp: new Date().toISOString(), ...args })
}

/** One provider round-trip. Token counts are required — the dollar source. */
export function emitLlmCall(args: {
  inputTokens: number
  outputTokens: number
  model?: string
  journey?: string
  runId?: string
  duration?: number
  detail?: string
  /** Cost attribution: "driver" (persona driver) vs "sut" (api Conductor turn). */
  source?: "driver" | "sut"
  /** Conversation handle (SUT-side emissions carry the TurnRecord conversationId). */
  sessionId?: string
}): void {
  emit({ type: "llm.call", timestamp: new Date().toISOString(), ...args })
}
