// harness/run-suite-cli.ts — `ibx journey run --suite` (T1b-8): the
// multi-journey sequential suite path with the suite-level dollar abort.
//
// Selection: all `status: active` journeys in the registry, in registry
// (filename-sorted) order; `--only id,id` narrows the selection (unknown or
// non-active ids fail loudly). Blocked journeys are NEVER part of a suite —
// they are the product backlog, not runnable specs.
//
// Per-journey k (T1b-4's nightly: pass^k k=4 money flows, k=1 exploratory):
//   --k <n>            default 1 — every selected journey
//   --k-money <n>      k override for the money-flow journeys list
//   --money-flows ids  the money-flow journey id list (flags, not a plan
//                      file — recorded execution choice; the nightly names
//                      its money flows explicitly)
//
// Dollar abort (the point of T1b-8): ONE DollarBudget spans the suite; each
// attempt's measured cost (llm.call driver+sut events × the checked-in
// price table) is charged after the attempt. Once cumulative spend ≥ cap
// (--budget-usd > IBX_NIGHTLY_BUDGET_USD > $50):
//   * the in-flight journey's remaining attempts report `aborted-by-budget`
//     (the shared budget inside runJourneyCli's k-loop), and
//   * every remaining journey reports `aborted-by-budget` WITHOUT running —
//     never silent truncation; the suite is RED (pass=false, nonzero exit).
// The Redis `llm:tokens` counter is NOT consulted (combined in+out total —
// kernel budget-guard input only; plan §7 new fact 24).

import { emitJourneyAborted } from "@ibatexas/tools"

import { loadJourneys, type Journey } from "../schema/index.js"
import {
  ABORTED_BY_BUDGET,
  createDollarBudget,
  renderBudgetLine,
  resolveBudgetCapUsd,
  type BudgetReport,
  type DollarBudget,
} from "./budget.js"
import { formatUsd } from "./cost.js"
import {
  abortedByBudgetAttemptReport,
  JourneyRunCliError,
  runJourneyCli,
  type JourneyRunReport,
  type RunJourneyCliOptions,
} from "./run-journey-cli.js"

// ── Report shape (the --json contract) ───────────────────────────────────────

export interface JourneySuiteReport {
  suite: true
  /** Journey ids in run order (registry order, narrowed by --only). */
  selected: string[]
  /** GREEN only when every journey passed AND nothing was budget-truncated. */
  pass: boolean
  /** RED marker: the dollar cap truncated the suite (T1b-8). */
  abortedByBudget: boolean
  budget: BudgetReport
  journeys: JourneyRunReport[]
  totalCostUsd: number
  costLine: string
}

export interface RunJourneySuiteCliOptions {
  /** Narrow the active set to these ids (unknown/non-active ids fail loudly). */
  only?: string[]
  /** Attempts per journey — ALL must pass (default 1). */
  k?: number
  /** Attempts for journeys named in `moneyFlows` (default: same as k). */
  kMoney?: number
  /** Money-flow journey ids that get `kMoney` attempts. */
  moneyFlows?: string[]
  /** Dollar cap override (--budget-usd); else IBX_NIGHTLY_BUDGET_USD; else $50. */
  budgetUsd?: number
  /** Journeys dir override (default packages/journeys/journeys/). */
  dir?: string
  /** .env.test path override (threaded to each journey run). */
  envFile?: string
  /** Runs dir override (default <repo>/runs). */
  runsDir?: string
  /** Progress sink for human output. */
  onProgress?: (line: string) => void
  /**
   * Test seam — defaults to the real `runJourneyCli`. CONTRACT: the fn
   * charges each attempt's measured cost into `options.budget` and reports
   * budget-truncated attempts itself (the real one does, via
   * runAttemptsWithBudget).
   */
  runJourneyFn?: (options: RunJourneyCliOptions) => Promise<JourneyRunReport>
  /** Env source for cap resolution (test seam; default process.env). */
  env?: NodeJS.ProcessEnv
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function requirePositiveInt(value: number, flag: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new JourneyRunCliError(`${flag} must be a positive integer (got ${String(value)})`)
  }
  return value
}

/**
 * The journey-level report for a suite entry the budget truncated BEFORE it
 * started: all k attempts reported `aborted-by-budget` — never dropped.
 */
function abortedByBudgetJourneyReport(
  journey: Journey,
  k: number,
  budget: DollarBudget,
): JourneyRunReport {
  const attempts = Array.from({ length: k }, (_, i) =>
    abortedByBudgetAttemptReport(i + 1, budget),
  )
  return {
    journey: journey.id,
    k,
    pass: false,
    status: ABORTED_BY_BUDGET,
    attempts,
    totalCostUsd: 0,
    costLine: `cost[${journey.id}]: ${ABORTED_BY_BUDGET} (${renderBudgetLine(budget)})`,
    budget: budget.snapshot(),
  }
}

/**
 * Selection: active journeys in registry order, narrowed by `--only`. Unknown
 * or non-active `--only` ids fail loudly (blocked ids name their gaps).
 */
function selectSuiteJourneys(
  registry: ReadonlyArray<Journey>,
  only: string[] | undefined,
): Journey[] {
  const active = registry.filter((j) => j.status === "active")
  if (only === undefined || only.length === 0) {
    return active
  }
  const activeIds = new Set(active.map((j) => j.id))
  for (const id of only) {
    if (!activeIds.has(id)) {
      const known = registry.find((j) => j.id === id)
      throw new JourneyRunCliError(
        known === undefined
          ? `--only ${id}: journey not found in the registry (${registry.length} loaded)`
          : `--only ${id}: journey is blocked by [${known.blocked_by.join(", ")}] — suites run active journeys only`,
      )
    }
  }
  const onlySet = new Set(only)
  return active.filter((j) => onlySet.has(j.id))
}

/**
 * Money-flow ids must exist in the registry (typos fail loudly); ids not
 * selected are tolerated (a narrowed `--only` run is still well-formed).
 */
function validateMoneyFlows(registry: ReadonlyArray<Journey>, moneyFlows: Set<string>): void {
  for (const id of moneyFlows) {
    if (!registry.some((j) => j.id === id)) {
      throw new JourneyRunCliError(`--money-flows ${id}: journey not found in the registry`)
    }
  }
}

/** Build the per-journey run options, threading through optional overrides. */
function buildRunJourneyOptions(
  journey: Journey,
  jk: number,
  budget: DollarBudget,
  onProgress: (line: string) => void,
  options: RunJourneySuiteCliOptions,
): RunJourneyCliOptions {
  return {
    journeyId: journey.id,
    k: jk,
    ...(options.dir === undefined ? {} : { dir: options.dir }),
    ...(options.envFile === undefined ? {} : { envFile: options.envFile }),
    ...(options.runsDir === undefined ? {} : { runsDir: options.runsDir }),
    onProgress,
    budget, // the SHARED accumulator — per-attempt charging happens inside
  }
}

// ── Entry point (`ibx journey run --suite` calls this) ───────────────────────

export async function runJourneySuiteCli(
  options: RunJourneySuiteCliOptions = {},
): Promise<JourneySuiteReport> {
  const k = requirePositiveInt(options.k ?? 1, "--k")
  const kMoney = options.kMoney === undefined ? k : requirePositiveInt(options.kMoney, "--k-money")
  const moneyFlows = new Set(options.moneyFlows ?? [])
  const onProgress = options.onProgress ?? (() => undefined)
  const runJourneyFn = options.runJourneyFn ?? runJourneyCli

  // ── Selection: active journeys, registry order, narrowed by --only ─────────
  const registry = await loadJourneys(options.dir)
  const selected = selectSuiteJourneys(registry, options.only)
  if (selected.length === 0) {
    throw new JourneyRunCliError("suite selected 0 active journeys — nothing to run")
  }
  validateMoneyFlows(registry, moneyFlows)

  // ── ONE budget spans the suite (the abort accumulator) ─────────────────────
  const budget = createDollarBudget(resolveBudgetCapUsd(options.budgetUsd, options.env))
  onProgress(
    `suite: ${selected.length} journey(s) [${selected.map((j) => j.id).join(", ")}] ` +
      `cap ${formatUsd(budget.capUsd)} (${budget.source})`,
  )

  const reports: JourneyRunReport[] = []
  for (const journey of selected) {
    const jk = moneyFlows.has(journey.id) ? kMoney : k

    if (budget.exceeded()) {
      // Suite-level abort: this journey never starts — reported, not dropped.
      emitJourneyAborted({
        journey: journey.id,
        runId: ABORTED_BY_BUDGET,
        reason: "dollar_cap",
        detail: renderBudgetLine(budget),
      })
      const aborted = abortedByBudgetJourneyReport(journey, jk, budget)
      reports.push(aborted)
      onProgress(`${journey.id}: ${ABORTED_BY_BUDGET} (${renderBudgetLine(budget)})`)
      continue
    }

    onProgress(`suite: ${journey.id} starting (k=${jk})`)
    const report = await runJourneyFn(
      buildRunJourneyOptions(journey, jk, budget, onProgress, options),
    )
    reports.push(report)
    onProgress(`suite: ${journey.id} ${report.pass ? "PASS" : "FAIL"} — ${renderBudgetLine(budget)}`)
  }

  const abortedByBudget = reports.some((r) => r.status === ABORTED_BY_BUDGET)
  const totalCostUsd = reports.reduce((sum, r) => sum + r.totalCostUsd, 0)
  const pass = !abortedByBudget && reports.every((r) => r.pass)
  const costLine =
    `cost[suite]: ${formatUsd(totalCostUsd)} across ${reports.length} journey(s) — ` +
    renderBudgetLine(budget)

  return {
    suite: true,
    selected: selected.map((j) => j.id),
    pass,
    abortedByBudget,
    budget: budget.snapshot(),
    journeys: reports,
    totalCostUsd,
    costLine,
  }
}
