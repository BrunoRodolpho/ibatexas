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
// × the checked-in price table — plan §7).

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
  | "act.start"
  | "act.end"
  | "llm.call"
  | "evidence.capture"
  | "evidence.persist"

export type IbxEventType = ScenarioEventType | JourneyEventType

/** Journey act kinds (mirrors the JourneyFileSchema act discriminator). */
export type ActKindName = "chat" | "http" | "fixture"

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
  outcome?: "pass" | "fail" | "error"
  // llm.call (required there — see LlmCallEvent)
  model?: string
  inputTokens?: number
  outputTokens?: number
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
 * - Always dispatches to registered listeners
 */
export function emit(event: IbxEvent): void {
  // JSONL output for CI integration: ibx scenario homepage 2> events.jsonl
  if (process.env.IBX_EVENTS === "json") {
    process.stderr.write(`${JSON.stringify(event)}\n`)
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
  outcome: "pass" | "fail" | "error",
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
  outcome: "pass" | "fail" | "error",
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
    ...(detail !== undefined ? { detail } : {}),
  })
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
}): void {
  emit({ type: "llm.call", timestamp: new Date().toISOString(), ...args })
}
