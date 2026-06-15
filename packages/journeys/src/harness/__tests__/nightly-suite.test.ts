// Tests for the T1b-4 nightly suite mode: retry-once = yellow (journey
// passes the night, flaky night recorded), quarantine skip (reported, never
// dropped) + the all-quarantined RED night, ledger folding (green deletes,
// 2nd consecutive yellow quarantines, red/budget no-ops), `gh issue create`
// payloads for red + newly-quarantined + budget-abort, and the retry-delay
// seam (D-014 order-cancel rate-limit spacing).
//
// Unit plane: the per-journey runner is stubbed (no stack, no tokens); the
// REAL selection, retry, ledger and issue logic runs over a fixture registry
// dir and a temp ledger file.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { validateJourney, type Journey } from "../../schema/index.js"
import {
  FLAKE_LEDGER_VERSION,
  loadFlakeLedger,
  type FlakeLedger,
} from "../flake-ledger.js"
import { runNightlySuiteCli } from "../nightly-suite.js"
import {
  JourneyRunCliError,
  type JourneyAttemptReport,
  type JourneyRunReport,
  type RunJourneyCliOptions,
} from "../run-journey-cli.js"

// ── Fixtures (same idiom as suite-budget.test.ts) ────────────────────────────

function makeJourney(id: string, status: "active" | "blocked" = "active"): Journey {
  const result = validateJourney({
    id,
    title: `Nightly fixture ${id}`,
    businessCase: "Exercise the nightly flake policy.",
    persona: "Cliente de teste.",
    channel: "web",
    status,
    blocked_by: status === "blocked" ? ["some-gap"] : [],
    source: "T1b-4 unit test",
    acts: [{ kind: "chat", name: "talk", goal: "Fazer um pedido." }],
    expects: [],
    verify: [],
  })
  if (!result.ok) throw new Error(`fixture journey invalid: ${JSON.stringify(result.errors)}`)
  return result.journey
}

function attemptReport(attempt: number, pass: boolean, costUsd = 0.05): JourneyAttemptReport {
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
    ...(pass ? {} : { error: "verify failed: audit.trajectory.exact" }),
  }
}

function journeyReport(
  options: RunJourneyCliOptions,
  pass: boolean,
  costUsd = 0.05,
): JourneyRunReport {
  const k = options.k ?? 1
  const attempts = Array.from({ length: k }, (_, i) =>
    attemptReport(i + 1, pass, costUsd / k),
  )
  options.budget?.charge(costUsd)
  return {
    journey: options.journeyId,
    k,
    pass,
    status: "completed",
    attempts,
    totalCostUsd: costUsd,
    costLine: `cost[total]: $${costUsd.toFixed(4)}`,
    budget: options.budget!.snapshot(),
  }
}

/**
 * Stub runner: per-journey scripted outcomes — an array of booleans consumed
 * one per run (first run, then the retry). Records every call.
 */
function scriptedRunner(script: Record<string, boolean[]>, calls: string[]) {
  return async (options: RunJourneyCliOptions): Promise<JourneyRunReport> => {
    calls.push(options.journeyId)
    const remaining = script[options.journeyId]
    if (remaining === undefined || remaining.length === 0) {
      throw new Error(`unscripted run for ${options.journeyId}`)
    }
    return journeyReport(options, remaining.shift()!)
  }
}

function writeFixtureRegistry(journeys: Journey[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ibx-nightly-test-"))
  for (const j of journeys) {
    writeFileSync(join(dir, `${j.id}.yaml`), JSON.stringify(j))
  }
  return dir
}

function writeLedger(dir: string, ledger: FlakeLedger): string {
  const path = join(dir, "flake-ledger.json")
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`)
  return path
}

const EMPTY_LEDGER: FlakeLedger = { version: FLAKE_LEDGER_VERSION, journeys: {} }

const DATE = "2026-06-12"

let registryDir: string
let ledgerDir: string

beforeEach(() => {
  ledgerDir = mkdtempSync(join(tmpdir(), "ibx-nightly-ledger-"))
})

afterEach(() => {
  rmSync(registryDir, { recursive: true, force: true })
  rmSync(ledgerDir, { recursive: true, force: true })
})

describe("runNightlySuiteCli — outcomes + ledger + issues", () => {
  it("all green: pass, no retries, ledger file untouched, zero issues", async () => {
    registryDir = writeFixtureRegistry([makeJourney("JOURNEY-001"), makeJourney("JOURNEY-009")])
    const ledgerPath = writeLedger(ledgerDir, EMPTY_LEDGER)
    const before = statSync(ledgerPath).mtimeMs
    const raw = readFileSync(ledgerPath, "utf-8")
    const calls: string[] = []

    const report = await runNightlySuiteCli({
      dir: registryDir,
      ledgerPath,
      date: DATE,
      runJourneyFn: scriptedRunner({ "JOURNEY-001": [true], "JOURNEY-009": [true] }, calls),
    })

    expect(report.pass).toBe(true)
    expect(calls).toEqual(["JOURNEY-001", "JOURNEY-009"])
    expect(report.outcomes.map((o) => o.outcome)).toEqual(["green", "green"])
    expect(report.outcomes.every((o) => !o.retried)).toBe(true)
    expect(report.issues).toEqual([])
    expect(report.ledger.changed).toBe(false)
    // Byte-identical file — an all-green night produces zero commit noise.
    expect(readFileSync(ledgerPath, "utf-8")).toBe(raw)
    expect(statSync(ledgerPath).mtimeMs).toBe(before)
  })

  it("fail-then-pass = YELLOW: journey passes the night, streak-1 ledger entry, no issue", async () => {
    registryDir = writeFixtureRegistry([makeJourney("JOURNEY-001")])
    const ledgerPath = writeLedger(ledgerDir, EMPTY_LEDGER)
    const calls: string[] = []
    const sleeps: number[] = []

    const report = await runNightlySuiteCli({
      dir: registryDir,
      ledgerPath,
      date: DATE,
      retryDelaySeconds: 600,
      sleepFn: async (ms) => {
        sleeps.push(ms)
      },
      runJourneyFn: scriptedRunner({ "JOURNEY-001": [false, true] }, calls),
    })

    expect(report.pass).toBe(true) // yellow PASSES the night
    expect(calls).toEqual(["JOURNEY-001", "JOURNEY-001"])
    expect(sleeps).toEqual([600_000]) // D-014 rate-limit spacing before the retry
    expect(report.outcomes[0]).toMatchObject({
      journey: "JOURNEY-001",
      outcome: "yellow",
      retried: true,
    })
    expect(report.suite?.pass).toBe(true) // the retry report is the suite's final
    expect(report.issues).toEqual([])
    expect(report.ledger.changed).toBe(true)
    const ledger = loadFlakeLedger(ledgerPath)
    expect(ledger.journeys["JOURNEY-001"]).toMatchObject({
      status: "flaky",
      consecutiveFlakyNights: 1,
      firstSeen: DATE,
      lastFlakyNight: DATE,
      owner: "",
    })
  })

  it("fail-twice = RED: night fails, ledger NOT advanced, gh-issue payload with owner", async () => {
    registryDir = writeFixtureRegistry([makeJourney("JOURNEY-001")])
    // Pre-existing flaky entry with an owner — red must NOT advance the
    // streak (no quarantine via hard failures), but the issue carries the owner.
    const ledgerPath = writeLedger(ledgerDir, {
      version: FLAKE_LEDGER_VERSION,
      journeys: {
        "JOURNEY-001": {
          journey: "JOURNEY-001",
          firstSeen: "2026-06-11",
          owner: "bnocesar",
          status: "flaky",
          consecutiveFlakyNights: 1,
          lastFlakyNight: "2026-06-11",
        },
      },
    })
    const calls: string[] = []

    const report = await runNightlySuiteCli({
      dir: registryDir,
      ledgerPath,
      date: DATE,
      runJourneyFn: scriptedRunner({ "JOURNEY-001": [false, false] }, calls),
    })

    expect(report.pass).toBe(false)
    expect(calls).toEqual(["JOURNEY-001", "JOURNEY-001"])
    expect(report.outcomes[0]).toMatchObject({ outcome: "red", retried: true })
    expect(report.ledger.changed).toBe(false)
    expect(loadFlakeLedger(ledgerPath).journeys["JOURNEY-001"]?.consecutiveFlakyNights).toBe(1)
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]).toMatchObject({ journey: "JOURNEY-001", owner: "bnocesar" })
    expect(report.issues[0]!.title).toContain("RED")
    expect(report.issues[0]!.body).toContain("@bnocesar")
    expect(report.issues[0]!.body).toContain("verify failed")
  })

  it("2nd consecutive flaky night QUARANTINES: ledger flips + quarantine issue", async () => {
    registryDir = writeFixtureRegistry([makeJourney("JOURNEY-001")])
    const ledgerPath = writeLedger(ledgerDir, {
      version: FLAKE_LEDGER_VERSION,
      journeys: {
        "JOURNEY-001": {
          journey: "JOURNEY-001",
          firstSeen: "2026-06-11",
          owner: "",
          status: "flaky",
          consecutiveFlakyNights: 1,
          lastFlakyNight: "2026-06-11",
        },
      },
    })

    const report = await runNightlySuiteCli({
      dir: registryDir,
      ledgerPath,
      date: DATE,
      runJourneyFn: scriptedRunner({ "JOURNEY-001": [false, true] }, []),
    })

    expect(report.pass).toBe(true) // tonight is still yellow — quarantine starts TOMORROW
    expect(report.ledger.newlyQuarantined).toEqual(["JOURNEY-001"])
    expect(report.ledger.quarantinedAfter).toEqual(["JOURNEY-001"])
    const entry = loadFlakeLedger(ledgerPath).journeys["JOURNEY-001"]!
    expect(entry.status).toBe("quarantined")
    expect(entry.quarantinedAt).toBe(DATE)
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]!.title).toContain("quarantined")
    expect(report.issues[0]!.body).toContain("ibx journey flake --dequarantine")
  })

  it("quarantined journeys are SKIPPED (reported) and never run", async () => {
    registryDir = writeFixtureRegistry([makeJourney("JOURNEY-001"), makeJourney("JOURNEY-009")])
    const ledgerPath = writeLedger(ledgerDir, {
      version: FLAKE_LEDGER_VERSION,
      journeys: {
        "JOURNEY-001": {
          journey: "JOURNEY-001",
          firstSeen: "2026-06-10",
          owner: "",
          status: "quarantined",
          consecutiveFlakyNights: 2,
          lastFlakyNight: "2026-06-11",
          quarantinedAt: "2026-06-11",
        },
      },
    })
    const calls: string[] = []

    const report = await runNightlySuiteCli({
      dir: registryDir,
      ledgerPath,
      date: DATE,
      runJourneyFn: scriptedRunner({ "JOURNEY-009": [true] }, calls),
    })

    expect(calls).toEqual(["JOURNEY-009"]) // the quarantined journey never ran
    expect(report.quarantinedSkipped).toEqual(["JOURNEY-001"])
    expect(report.pass).toBe(true)
    expect(report.ledger.changed).toBe(false)
  })

  it("ALL journeys quarantined = RED night with a zero-runnable issue (vacuous-green protection)", async () => {
    registryDir = writeFixtureRegistry([makeJourney("JOURNEY-001")])
    const ledgerPath = writeLedger(ledgerDir, {
      version: FLAKE_LEDGER_VERSION,
      journeys: {
        "JOURNEY-001": {
          journey: "JOURNEY-001",
          firstSeen: "2026-06-10",
          owner: "",
          status: "quarantined",
          consecutiveFlakyNights: 2,
          lastFlakyNight: "2026-06-11",
          quarantinedAt: "2026-06-11",
        },
      },
    })

    const report = await runNightlySuiteCli({
      dir: registryDir,
      ledgerPath,
      date: DATE,
      runJourneyFn: scriptedRunner({}, []),
    })

    expect(report.pass).toBe(false)
    expect(report.suite).toBeNull()
    expect(report.quarantinedSkipped).toEqual(["JOURNEY-001"])
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]!.title).toContain("zero runnable")
  })

  it("budget-truncated journeys: no retry, no ledger advance, ONE suite-level issue", async () => {
    registryDir = writeFixtureRegistry([makeJourney("JOURNEY-001"), makeJourney("JOURNEY-009")])
    const ledgerPath = writeLedger(ledgerDir, EMPTY_LEDGER)
    const calls: string[] = []

    const report = await runNightlySuiteCli({
      dir: registryDir,
      ledgerPath,
      date: DATE,
      budgetUsd: 0.05,
      runJourneyFn: async (options) => {
        calls.push(options.journeyId)
        // First journey burns the whole cap; the suite truncates the rest.
        return journeyReport(options, true, 0.05)
      },
    })

    // JOURNEY-009 never reached the runner — suite-level dollar abort.
    expect(calls).toEqual(["JOURNEY-001"])
    expect(report.pass).toBe(false)
    expect(report.suite?.abortedByBudget).toBe(true)
    const truncated = report.outcomes.find((o) => o.journey === "JOURNEY-009")!
    expect(truncated).toMatchObject({ outcome: "red", abortedByBudget: true, retried: false })
    // No per-journey issue for budget truncation — one suite-level issue.
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]!.journey).toBe("suite")
    expect(report.issues[0]!.title).toContain("aborted-by-budget")
    expect(report.issues[0]!.body).toContain("JOURNEY-009")
    // The ledger never moves on budget truncation.
    expect(report.ledger.changed).toBe(false)
  })

  it("a failed run does NOT retry when the shared budget is already exhausted", async () => {
    registryDir = writeFixtureRegistry([makeJourney("JOURNEY-001")])
    const ledgerPath = writeLedger(ledgerDir, EMPTY_LEDGER)
    const calls: string[] = []

    const report = await runNightlySuiteCli({
      dir: registryDir,
      ledgerPath,
      date: DATE,
      budgetUsd: 0.01,
      runJourneyFn: async (options) => {
        calls.push(options.journeyId)
        return journeyReport(options, false, 0.05) // fails AND exhausts the cap
      },
    })

    expect(calls).toEqual(["JOURNEY-001"]) // no retry — it would only report noise
    expect(report.pass).toBe(false)
    expect(report.outcomes[0]).toMatchObject({ outcome: "red", retried: false })
  })

  it("rejects unknown --only ids and bad retry delays loudly", async () => {
    registryDir = writeFixtureRegistry([makeJourney("JOURNEY-001")])
    const ledgerPath = writeLedger(ledgerDir, EMPTY_LEDGER)
    await expect(
      runNightlySuiteCli({
        dir: registryDir,
        ledgerPath,
        date: DATE,
        only: ["JOURNEY-404"],
        runJourneyFn: scriptedRunner({}, []),
      }),
    ).rejects.toThrow(JourneyRunCliError)
    await expect(
      runNightlySuiteCli({
        dir: registryDir,
        ledgerPath,
        date: DATE,
        retryDelaySeconds: -1,
        runJourneyFn: scriptedRunner({}, []),
      }),
    ).rejects.toThrow(/retry-delay-seconds/)
  })
})
