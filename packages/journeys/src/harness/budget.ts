// harness/budget.ts — suite-level dollar budget (T1b-8).
//
// THE dollar source for the abort is the same one as the cost report:
// `llm.call` events (driver + sut) × the checked-in price table — each
// attempt's measured `costUsd` is charged against ONE shared accumulator
// after the attempt finishes. When cumulative spend ≥ cap, the remaining
// attempts of the current journey AND every remaining journey in the suite
// are reported `aborted-by-budget` (never silent truncation) and the run is
// RED (nonzero exit).
//
// Explicitly NOT the dollar source: the Redis `llm:tokens` counter — it
// stores inputTokens+outputTokens as one combined total (plan §7 new fact
// 24), which is not dollar-convertible at a $3/$15 in/out split. That
// counter remains the kernel budget-guard input only; this module never
// reads it.
//
// Cap resolution (plan §7: "Hard abort at $50/night"):
//   --budget-usd flag  >  IBX_NIGHTLY_BUDGET_USD env  >  default 50.

/** Report status stamped on budget-truncated journeys/attempts. */
export const ABORTED_BY_BUDGET = "aborted-by-budget" as const

/** Journey/attempt completion status in run reports. */
export type RunCompletionStatus = "completed" | typeof ABORTED_BY_BUDGET

/** Env default for the suite dollar cap (plan §7). */
export const NIGHTLY_BUDGET_ENV = "IBX_NIGHTLY_BUDGET_USD"

/** Hard default when neither the flag nor the env var is set (plan §7). */
export const DEFAULT_NIGHTLY_BUDGET_USD = 50

export type BudgetCapSource = "flag" | "env" | "default"

export interface ResolvedBudgetCap {
  capUsd: number
  source: BudgetCapSource
}

/** A malformed cap (flag or env) fails LOUDLY — never a silent default. */
export class BudgetConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BudgetConfigError"
  }
}

/**
 * Resolve the dollar cap: `--budget-usd` flag wins, then
 * `IBX_NIGHTLY_BUDGET_USD`, then the hard default ($50). Non-numeric or
 * non-positive values throw `BudgetConfigError`.
 */
export function resolveBudgetCapUsd(
  flagUsd?: number,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedBudgetCap {
  if (flagUsd !== undefined) {
    if (!Number.isFinite(flagUsd) || flagUsd <= 0) {
      throw new BudgetConfigError(
        `--budget-usd must be a positive number of dollars (got ${String(flagUsd)})`,
      )
    }
    return { capUsd: flagUsd, source: "flag" }
  }
  const raw = env[NIGHTLY_BUDGET_ENV]
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new BudgetConfigError(
        `${NIGHTLY_BUDGET_ENV} must be a positive number of dollars (got "${raw}")`,
      )
    }
    return { capUsd: parsed, source: "env" }
  }
  return { capUsd: DEFAULT_NIGHTLY_BUDGET_USD, source: "default" }
}

/**
 * The shared mutable accumulator: ONE instance spans the whole suite (the
 * suite runner creates it and threads it into every per-journey run, which
 * charges each attempt's measured cost into it).
 */
export class DollarBudget {
  spentUsd = 0

  constructor(
    public readonly capUsd: number,
    public readonly source: BudgetCapSource,
  ) {}

  /** Charge one attempt's measured cost (llm.call × price table). */
  charge(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.spentUsd += usd
  }

  /** True once cumulative spend reached the cap — abort everything left. */
  exceeded(): boolean {
    return this.spentUsd >= this.capUsd
  }

  /** Snapshot for run reports (`--json`). */
  snapshot(): BudgetReport {
    return { capUsd: this.capUsd, spentUsd: this.spentUsd, source: this.source }
  }
}

export interface BudgetReport {
  capUsd: number
  spentUsd: number
  source: BudgetCapSource
}

export function createDollarBudget(cap: ResolvedBudgetCap): DollarBudget {
  return new DollarBudget(cap.capUsd, cap.source)
}

/** Human progress line, e.g. `budget: $0.0571 / $50.0000 spent (default)`. */
export function renderBudgetLine(budget: DollarBudget): string {
  return (
    `budget: $${budget.spentUsd.toFixed(4)} / $${budget.capUsd.toFixed(4)} spent ` +
    `(cap source: ${budget.source})${budget.exceeded() ? " — EXCEEDED" : ""}`
  )
}
