// Tests for the T1b-8 suite-level dollar abort: cap resolution
// (--budget-usd > IBX_NIGHTLY_BUDGET_USD > $50), the budget-aware k-loop
// (runAttemptsWithBudget), and the multi-journey suite path
// (runJourneySuiteCli) — a low cap aborts after the first attempt with the
// remainder reported `aborted-by-budget` (RED, never silent truncation);
// a normal cap completes everything.
//
// Unit plane: the attempt/journey runners are stubbed (no stack, no
// tokens); the REAL aggregation, charging, abort and report logic runs.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { onEvent, type IbxEventBase } from "@ibatexas/tools"

import { validateJourney, type Journey } from "../../schema/index.js"
import {
  ABORTED_BY_BUDGET,
  BudgetConfigError,
  createDollarBudget,
  DEFAULT_NIGHTLY_BUDGET_USD,
  NIGHTLY_BUDGET_ENV,
  resolveBudgetCapUsd,
} from "../budget.js"
import {
  runAttemptsWithBudget,
  JourneyRunCliError,
  type JourneyAttemptReport,
  type JourneyRunReport,
  type RunJourneyCliOptions,
} from "../run-journey-cli.js"
import { runJourneySuiteCli } from "../run-suite-cli.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeJourney(id: string, status: "active" | "blocked" = "active"): Journey {
  const result = validateJourney({
    id,
    title: `Suite fixture ${id}`,
    businessCase: "Exercise the suite dollar abort.",
    persona: "Cliente de teste.",
    channel: "web",
    status,
    blocked_by: status === "blocked" ? ["some-gap"] : [],
    source: "T1b-8 unit test",
    acts: [{ kind: "chat", name: "talk", goal: "Fazer um pedido." }],
    expects: [],
    verify: [],
  })
  if (!result.ok) throw new Error(`fixture journey invalid: ${JSON.stringify(result.errors)}`)
  return result.journey
}

function completedAttempt(attempt: number, costUsd: number, pass = true): JourneyAttemptReport {
  return {
    attempt,
    runId: `run-${attempt}`,
    pass,
    status: "completed",
    certifying: true,
    turns: 3,
    costUsd,
    driverCostUsd: costUsd / 2,
    sutCostUsd: costUsd / 2,
    driverTokens: { in: 100, out: 50 },
    sutTokens: { in: 100, out: 50 },
    durationMs: 1000,
    tracePath: "",
    costLine: `cost[attempt ${attempt}]: total $${costUsd.toFixed(4)}`,
  }
}

/**
 * A stub journey runner honoring the T1b-8 contract: charges each attempt's
 * measured cost into the SHARED options.budget and stops attempting once the
 * cap is exceeded (mirrors runAttemptsWithBudget inside the real
 * runJourneyCli — here re-used directly so the real loop logic is under test
 * even on the suite path).
 */
function stubJourneyRunner(costPerAttemptUsd: number, calls: RunJourneyCliOptions[]) {
  return async (options: RunJourneyCliOptions): Promise<JourneyRunReport> => {
    calls.push(options)
    const budget = options.budget!
    const { attempts, abortedByBudget } = await runAttemptsWithBudget({
      journeyId: options.journeyId,
      k: options.k ?? 1,
      budget,
      runAttempt: async (attempt) => completedAttempt(attempt, costPerAttemptUsd),
    })
    return {
      journey: options.journeyId,
      k: options.k ?? 1,
      pass: attempts.length === (options.k ?? 1) && attempts.every((a) => a.pass),
      status: abortedByBudget ? ABORTED_BY_BUDGET : "completed",
      attempts,
      totalCostUsd: attempts.reduce((s, a) => s + a.costUsd, 0),
      costLine: "cost[total]: stub",
      budget: budget.snapshot(),
    }
  }
}

// loadJourneys reads the real registry dir — point the suite at a fixture
// dir instead (fixture YAMLs in a temp dir; YAML is a JSON superset).
function writeFixtureRegistry(journeys: Journey[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ibx-suite-test-"))
  for (const j of journeys) {
    // Journey objects are JSON-serializable and YAML is a JSON superset.
    writeFileSync(join(dir, `${j.id}.yaml`), JSON.stringify(j))
  }
  return dir
}

// ── Cap resolution ───────────────────────────────────────────────────────────

describe("resolveBudgetCapUsd — flag > env > default 50", () => {
  it("defaults to $50 when neither flag nor env is set", () => {
    expect(resolveBudgetCapUsd(undefined, {})).toEqual({
      capUsd: DEFAULT_NIGHTLY_BUDGET_USD,
      source: "default",
    })
    expect(DEFAULT_NIGHTLY_BUDGET_USD).toBe(50)
  })

  it("reads IBX_NIGHTLY_BUDGET_USD when no flag is given", () => {
    expect(resolveBudgetCapUsd(undefined, { [NIGHTLY_BUDGET_ENV]: "12.5" })).toEqual({
      capUsd: 12.5,
      source: "env",
    })
  })

  it("the --budget-usd flag wins over the env var", () => {
    expect(resolveBudgetCapUsd(3, { [NIGHTLY_BUDGET_ENV]: "12.5" })).toEqual({
      capUsd: 3,
      source: "flag",
    })
  })

  it("malformed values fail LOUDLY (never a silent default)", () => {
    expect(() => resolveBudgetCapUsd(undefined, { [NIGHTLY_BUDGET_ENV]: "abc" })).toThrow(
      BudgetConfigError,
    )
    expect(() => resolveBudgetCapUsd(undefined, { [NIGHTLY_BUDGET_ENV]: "0" })).toThrow(
      BudgetConfigError,
    )
    expect(() => resolveBudgetCapUsd(-1, {})).toThrow(BudgetConfigError)
    expect(() => resolveBudgetCapUsd(Number.NaN, {})).toThrow(BudgetConfigError)
  })
})

// ── Budget-aware k-loop (the --k loop abort) ─────────────────────────────────

describe("runAttemptsWithBudget — per-attempt dollar abort", () => {
  let events: IbxEventBase[]
  let unsub: () => void

  beforeEach(() => {
    events = []
    unsub = onEvent((e) => events.push(e))
  })

  afterEach(() => unsub())

  it("a low cap aborts after the first attempt; the remainder is reported aborted-by-budget", async () => {
    const budget = createDollarBudget({ capUsd: 0.04, source: "flag" })
    let ran = 0
    const { attempts, abortedByBudget } = await runAttemptsWithBudget({
      journeyId: "JOURNEY-001",
      k: 3,
      budget,
      runAttempt: async (attempt) => {
        ran += 1
        return completedAttempt(attempt, 0.05) // 0.05 >= cap 0.04 after attempt 1
      },
    })

    expect(ran).toBe(1) // only the first attempt actually ran
    expect(abortedByBudget).toBe(true)
    expect(attempts).toHaveLength(3) // NEVER silent truncation
    expect(attempts[0]!.status).toBe("completed")
    expect(attempts[1]!.status).toBe(ABORTED_BY_BUDGET)
    expect(attempts[2]!.status).toBe(ABORTED_BY_BUDGET)
    expect(attempts[1]!.pass).toBe(false) // aborted = RED
    expect(attempts[1]!.error).toContain(ABORTED_BY_BUDGET)
    expect(attempts[1]!.error).toContain("cap")
    expect(budget.spentUsd).toBeCloseTo(0.05)

    // journey.aborted emitted ONCE with the T1b-8 reason.
    const aborted = events.filter((e) => e.type === "journey.aborted")
    expect(aborted).toHaveLength(1)
    expect(aborted[0]!.reason).toBe("dollar_cap")
    expect(aborted[0]!.journey).toBe("JOURNEY-001")
  })

  it("a normal cap completes all attempts (no abort, no aborted records)", async () => {
    const budget = createDollarBudget({ capUsd: 50, source: "default" })
    const { attempts, abortedByBudget } = await runAttemptsWithBudget({
      journeyId: "JOURNEY-001",
      k: 3,
      budget,
      runAttempt: async (attempt) => completedAttempt(attempt, 0.05),
    })

    expect(abortedByBudget).toBe(false)
    expect(attempts).toHaveLength(3)
    expect(attempts.every((a) => a.status === "completed" && a.pass)).toBe(true)
    expect(budget.spentUsd).toBeCloseTo(0.15)
    expect(events.filter((e) => e.type === "journey.aborted")).toHaveLength(0)
  })
})

// ── Suite path (`ibx journey run --suite`) ───────────────────────────────────

describe("runJourneySuiteCli — multi-journey suite with the dollar abort", () => {
  let dir: string
  let events: IbxEventBase[]
  let unsub: () => void

  beforeEach(() => {
    dir = writeFixtureRegistry([
      makeJourney("JOURNEY-001"),
      makeJourney("JOURNEY-002"),
      makeJourney("JOURNEY-003", "blocked"),
      makeJourney("JOURNEY-005"),
    ])
    events = []
    unsub = onEvent((e) => events.push(e))
  })

  afterEach(() => {
    unsub()
    rmSync(dir, { recursive: true, force: true })
  })

  it("low cap: aborts the suite RED after the first journey's first attempt; remaining journeys + attempts reported aborted-by-budget", async () => {
    const calls: RunJourneyCliOptions[] = []
    const report = await runJourneySuiteCli({
      dir,
      k: 2,
      budgetUsd: 0.04, // first attempt costs 0.06 → cap hit immediately
      env: {},
      runJourneyFn: stubJourneyRunner(0.06, calls),
    })

    // RED run, machine-readable in --json.
    expect(report.pass).toBe(false)
    expect(report.abortedByBudget).toBe(true)
    expect(report.budget).toEqual({ capUsd: 0.04, spentUsd: expect.closeTo(0.06, 5), source: "flag" })

    // All 3 ACTIVE journeys are in the report — never silent truncation.
    expect(report.selected).toEqual(["JOURNEY-001", "JOURNEY-002", "JOURNEY-005"])
    expect(report.journeys).toHaveLength(3)

    // Journey 1 ran attempt 1, then its k-loop remainder aborted.
    const [j1, j2, j3] = report.journeys as [JourneyRunReport, JourneyRunReport, JourneyRunReport]
    expect(j1.status).toBe(ABORTED_BY_BUDGET)
    expect(j1.pass).toBe(false)
    expect(j1.attempts.map((a) => a.status)).toEqual(["completed", ABORTED_BY_BUDGET])

    // Journeys 2 + 3 never started — every attempt reported aborted.
    for (const j of [j2, j3]) {
      expect(j.status).toBe(ABORTED_BY_BUDGET)
      expect(j.pass).toBe(false)
      expect(j.attempts).toHaveLength(2) // k=2, both reported
      expect(j.attempts.every((a) => a.status === ABORTED_BY_BUDGET && !a.pass)).toBe(true)
    }

    // The runner was invoked for journey 1 ONLY (no spend after the cap).
    expect(calls.map((c) => c.journeyId)).toEqual(["JOURNEY-001"])

    // journey.aborted (dollar_cap) emitted for the truncated work.
    const aborted = events.filter((e) => e.type === "journey.aborted" && e.reason === "dollar_cap")
    expect(aborted.map((e) => e.journey)).toEqual(["JOURNEY-001", "JOURNEY-002", "JOURNEY-005"])

    // Blocked journeys are never part of a suite.
    expect(report.journeys.some((j) => j.journey === "JOURNEY-003")).toBe(false)
  })

  it("normal cap (default $50): the whole suite completes green", async () => {
    const calls: RunJourneyCliOptions[] = []
    const report = await runJourneySuiteCli({
      dir,
      env: {}, // no IBX_NIGHTLY_BUDGET_USD → default $50
      runJourneyFn: stubJourneyRunner(0.06, calls),
    })

    expect(report.pass).toBe(true)
    expect(report.abortedByBudget).toBe(false)
    expect(report.budget.capUsd).toBe(DEFAULT_NIGHTLY_BUDGET_USD)
    expect(report.budget.source).toBe("default")
    expect(report.journeys.every((j) => j.status === "completed" && j.pass)).toBe(true)
    expect(calls.map((c) => c.journeyId)).toEqual(["JOURNEY-001", "JOURNEY-002", "JOURNEY-005"])
    expect(report.totalCostUsd).toBeCloseTo(0.18)
    expect(events.filter((e) => e.type === "journey.aborted")).toHaveLength(0)
  })

  it("--only narrows the selection; --k-money applies to the money-flow list", async () => {
    const calls: RunJourneyCliOptions[] = []
    const report = await runJourneySuiteCli({
      dir,
      only: ["JOURNEY-001", "JOURNEY-005"],
      k: 1,
      kMoney: 4,
      moneyFlows: ["JOURNEY-001"],
      env: {},
      runJourneyFn: stubJourneyRunner(0.01, calls),
    })

    expect(report.selected).toEqual(["JOURNEY-001", "JOURNEY-005"])
    expect(calls.find((c) => c.journeyId === "JOURNEY-001")?.k).toBe(4)
    expect(calls.find((c) => c.journeyId === "JOURNEY-005")?.k).toBe(1)
    expect(report.pass).toBe(true)
  })

  it("--only with a blocked or unknown id fails loudly", async () => {
    const runJourneyFn = stubJourneyRunner(0.01, [])
    await expect(
      runJourneySuiteCli({ dir, only: ["JOURNEY-003"], env: {}, runJourneyFn }),
    ).rejects.toThrow(JourneyRunCliError)
    await expect(
      runJourneySuiteCli({ dir, only: ["JOURNEY-999"], env: {}, runJourneyFn }),
    ).rejects.toThrow(/not found/)
  })

  it("one shared budget spans journeys: the cap can trip mid-suite, not just mid-journey", async () => {
    const calls: RunJourneyCliOptions[] = []
    // 0.05/attempt, cap 0.09: journey 1 completes (spent 0.05), journey 2's
    // single attempt completes (spent 0.10 >= 0.09) → journey 3 aborts.
    const report = await runJourneySuiteCli({
      dir,
      k: 1,
      budgetUsd: 0.09,
      env: {},
      runJourneyFn: stubJourneyRunner(0.05, calls),
    })

    expect(calls.map((c) => c.journeyId)).toEqual(["JOURNEY-001", "JOURNEY-002"])
    const statuses = report.journeys.map((j) => j.status)
    expect(statuses).toEqual(["completed", "completed", ABORTED_BY_BUDGET])
    expect(report.pass).toBe(false) // truncation = RED even with green completions
    expect(report.abortedByBudget).toBe(true)
    expect(report.budget.spentUsd).toBeCloseTo(0.1)
  })
})
