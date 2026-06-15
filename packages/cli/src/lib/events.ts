// lib/events.ts — structured event emitter for scenario execution.
// Events go to stderr as JSON when IBX_EVENTS=json.
// Otherwise events are consumed internally by the engine for timing/formatting.

// ── Types ────────────────────────────────────────────────────────────────────

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

export interface ScenarioEvent {
  type: ScenarioEventType
  timestamp: string
  scenario?: string
  step?: string
  duration?: number
  detail?: string
}

// ── Internal listener support ────────────────────────────────────────────────

type EventListener = (event: ScenarioEvent) => void

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
 * Emit a structured scenario event.
 *
 * - If `IBX_EVENTS=json` → writes JSON to stderr
 * - Always dispatches to registered listeners
 */
export function emit(event: ScenarioEvent): void {
  // JSON output for CI integration: ibx scenario homepage 2> events.jsonl
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

// ── Convenience helpers ──────────────────────────────────────────────────────

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
