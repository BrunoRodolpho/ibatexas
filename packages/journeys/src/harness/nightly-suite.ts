// harness/nightly-suite.ts — T1b-4: the NIGHTLY mode of `ibx journey run
// --suite` (`--nightly`). Composition over the T1b-8 suite runner:
//
//   load flake ledger (quarantine source of truth)
//     → SKIP quarantined journeys (reported, never silently dropped)
//     → run the suite; a journey that FAILS its first run gets exactly ONE
//       retry (the flake probe) — pass on retry = YELLOW (the journey passes
//       the night, the flaky night is recorded); fail again = RED
//     → fold outcomes into the ledger (green deletes, yellow advances the
//       consecutive-flaky-night streak, quarantining at 2; red leaves the
//       ledger untouched — issues, not quarantine, own hard failures)
//     → emit `gh issue create` payloads for RED journeys, newly-quarantined
//       journeys and a suite-level dollar abort, each carrying the
//       assignable `owner` field from the ledger.
//
// Retry spacing (`retryDelaySeconds` / `--retry-delay-seconds`): the
// order-cancel route is rate-limited 5 per 10 min per customer (D-014 —
// caps same-stack JOURNEY-001 attempts at 4/window), so a money-flow retry
// fired immediately after a k=4 first run would be rate-limit-doomed. The
// nightly workflow passes 600 so the retry starts in a fresh window; the
// budget keeps charging either way (retries spend real dollars).
//
// Ledger updates and retries happen ONLY here — the plain suite path
// (T1b-8) never reads or writes the ledger, so local/dev suite runs can
// never mutate quarantine state.

import { ABORTED_BY_BUDGET } from "./budget.js"
import {
  DEFAULT_FLAKE_LEDGER_PATH,
  flakeOwner,
  loadFlakeLedger,
  quarantinedJourneyIds,
  recordNightlyOutcome,
  saveFlakeLedger,
  type FlakeLedger,
  type NightlyOutcome,
} from "./flake-ledger.js"
import {
  JourneyRunCliError,
  runJourneyCli,
  type JourneyRunReport,
  type RunJourneyCliOptions,
} from "./run-journey-cli.js"
import { runJourneySuiteCli, type JourneySuiteReport } from "./run-suite-cli.js"
import { loadJourneys } from "../schema/index.js"

// ── Report shapes (the --nightly --json contract) ────────────────────────────

export interface NightlyJourneyOutcome {
  journey: string
  /**
   * green  = first run passed;
   * yellow = first run failed, the single retry passed (journey PASSES the
   *          night; the flaky night advances the ledger streak);
   * red    = failed twice, or budget-truncated (red never advances the
   *          streak — hard failures get an issue with an owner instead).
   */
  outcome: NightlyOutcome
  retried: boolean
  /** True when the red outcome is the suite dollar cap, not the journey. */
  abortedByBudget: boolean
  firstRun: JourneyRunReport
  retryRun?: JourneyRunReport
}

export interface NightlyLedgerReport {
  path: string
  /** True when tonight's outcomes mutated the committed ledger file. */
  changed: boolean
  quarantinedBefore: string[]
  quarantinedAfter: string[]
  /** Journeys whose entry flipped to quarantined TONIGHT. */
  newlyQuarantined: string[]
}

/** One `gh issue create` payload — the workflow step iterates these. */
export interface NightlyIssuePayload {
  journey: string
  /** Assignable owner from the flake ledger ("" = unassigned). */
  owner: string
  title: string
  body: string
}

export interface NightlySuiteReport {
  nightly: true
  /** ISO date (YYYY-MM-DD) of the night — the ledger streak key. */
  date: string
  /**
   * GREEN when at least one journey ran AND every run journey ended green
   * or yellow AND the dollar cap never truncated anything. Yellow journeys
   * PASS the night (retry-once policy); an all-quarantined registry is RED
   * (vacuous-green protection).
   */
  pass: boolean
  outcomes: NightlyJourneyOutcome[]
  /** Quarantined journeys skipped tonight (reported, never dropped). */
  quarantinedSkipped: string[]
  ledger: NightlyLedgerReport
  issues: NightlyIssuePayload[]
  /** The underlying suite report (null when zero journeys were runnable). */
  suite: JourneySuiteReport | null
}

export interface RunNightlySuiteCliOptions {
  /** Narrow the active set (quarantined ids are skipped, not errors). */
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
  /**
   * Wait this long before the single retry (default 0). The nightly
   * workflow passes 600 — the order-cancel rate-limit window (D-014).
   */
  retryDelaySeconds?: number
  /** Flake-ledger path override (default the committed governance file). */
  ledgerPath?: string
  /** Night stamp override, YYYY-MM-DD (default: today, UTC). */
  date?: string
  /** Progress sink for human output. */
  onProgress?: (line: string) => void
  /** Test seam — the per-journey runner (default runJourneyCli). */
  runJourneyFn?: (options: RunJourneyCliOptions) => Promise<JourneyRunReport>
  /** Test seam — the retry-delay sleeper. */
  sleepFn?: (ms: number) => Promise<void>
  /** Env source for cap resolution (test seam; default process.env). */
  env?: NodeJS.ProcessEnv
}

// ── The documented manual de-quarantine flow (referenced by issues) ──────────

export const DEQUARANTINE_MANUAL_COMMANDS = [
  "ibx journey run <id> --k 2 --json   # de-quarantine criterion: green twice on a manual re-run",
  "ibx journey flake --dequarantine <id>",
] as const

// ── Issue payload builders ────────────────────────────────────────────────────

function truncate(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function journeyFailureBody(outcome: NightlyJourneyOutcome, date: string, owner: string): string {
  const runs = [
    { label: "first run", report: outcome.firstRun },
    ...(outcome.retryRun !== undefined ? [{ label: "retry", report: outcome.retryRun }] : []),
  ]
  const lines = [
    `Nightly journey suite ${date}: **${outcome.journey} is RED** (failed${outcome.retried ? " twice — first run AND the single retry" : ""}).`,
    "",
    ...runs.flatMap(({ label, report }) => [
      `### ${label} (k=${report.k}, ${report.attempts.filter((a) => a.pass).length}/${report.k} green, $${report.totalCostUsd.toFixed(4)})`,
      ...report.attempts.map(
        (a) =>
          `- attempt ${a.attempt} [${a.runId}]: ${a.pass ? "PASS" : `FAIL${a.error !== undefined ? ` — ${truncate(a.error)}` : ""}`}`,
      ),
      "",
    ]),
    `Owner (flake ledger): ${owner === "" ? "UNASSIGNED — claim it by setting \`owner\` in packages/journeys/governance/flake-ledger.json" : `@${owner}`}`,
    "Trace JSONL: the `journeys-nightly` workflow-run artifacts (runs/<runId>/trace.jsonl).",
  ]
  return lines.join("\n")
}

function quarantineBody(journeyId: string, date: string, owner: string): string {
  return [
    `Nightly journey suite ${date}: **${journeyId} was QUARANTINED** after 2 consecutive flaky nights (fail-then-pass-on-retry).`,
    "",
    "While quarantined the journey is SKIPPED by the nightly suite and its coverage cells are reported `waived-quarantined`.",
    "",
    "De-quarantine (manual, green-twice criterion):",
    "```",
    ...DEQUARANTINE_MANUAL_COMMANDS,
    "```",
    `Owner (flake ledger): ${owner === "" ? "UNASSIGNED — claim it by setting \`owner\` in packages/journeys/governance/flake-ledger.json" : `@${owner}`}`,
  ].join("\n")
}

// ── Entry point (`ibx journey run --suite --nightly` calls this) ─────────────

export async function runNightlySuiteCli(
  options: RunNightlySuiteCliOptions = {},
): Promise<NightlySuiteReport> {
  const onProgress = options.onProgress ?? (() => undefined)
  const inner = options.runJourneyFn ?? runJourneyCli
  const sleepFn =
    options.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const retryDelaySeconds = options.retryDelaySeconds ?? 0
  if (!Number.isInteger(retryDelaySeconds) || retryDelaySeconds < 0) {
    throw new JourneyRunCliError(
      `--retry-delay-seconds must be a non-negative integer (got ${String(options.retryDelaySeconds)})`,
    )
  }
  const date = options.date ?? new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new JourneyRunCliError(`nightly date must be YYYY-MM-DD (got "${date}")`)
  }

  // ── Ledger: the authoritative quarantine list (malformed file = loud) ──────
  const ledgerPath = options.ledgerPath ?? DEFAULT_FLAKE_LEDGER_PATH
  const ledgerBefore = loadFlakeLedger(ledgerPath)
  const quarantinedBefore = quarantinedJourneyIds(ledgerBefore)

  // ── Selection: active (∩ --only) minus quarantined — skips REPORTED ────────
  const registry = await loadJourneys(options.dir)
  const active = registry.filter((j) => j.status === "active")
  const activeIds = new Set(active.map((j) => j.id))
  if (options.only !== undefined) {
    for (const id of options.only) {
      if (!activeIds.has(id)) {
        throw new JourneyRunCliError(
          `--only ${id}: not an active journey in the registry (${registry.length} loaded)`,
        )
      }
    }
  }
  const narrowed =
    options.only !== undefined && options.only.length > 0
      ? active.filter((j) => options.only!.includes(j.id))
      : active
  const quarantinedSet = new Set(quarantinedBefore)
  const quarantinedSkipped = narrowed.filter((j) => quarantinedSet.has(j.id)).map((j) => j.id)
  const runnable = narrowed.filter((j) => !quarantinedSet.has(j.id)).map((j) => j.id)
  for (const id of quarantinedSkipped) {
    onProgress(
      `nightly: ${id} QUARANTINED — skipped (de-quarantine: ${DEQUARANTINE_MANUAL_COMMANDS.join(" && ")})`,
    )
  }

  // Vacuous-green protection: a night that runs nothing is RED, never green.
  if (runnable.length === 0) {
    const body = [
      `Nightly journey suite ${date}: ZERO runnable journeys — `,
      quarantinedSkipped.length > 0
        ? `every selected active journey is quarantined (${quarantinedSkipped.join(", ")}).`
        : "the registry has no active journeys in the selection.",
      "",
      "A nightly that runs nothing certifies nothing (vacuous-green protection) — de-quarantine or activate journeys.",
    ].join("\n")
    return {
      nightly: true,
      date,
      pass: false,
      outcomes: [],
      quarantinedSkipped,
      ledger: {
        path: ledgerPath,
        changed: false,
        quarantinedBefore,
        quarantinedAfter: quarantinedBefore,
        newlyQuarantined: [],
      },
      issues: [
        {
          journey: "suite",
          owner: "",
          title: `[journeys-nightly] ${date}: zero runnable journeys`,
          body,
        },
      ],
      suite: null,
    }
  }

  // ── Suite run with the retry-once wrapper ───────────────────────────────────
  const sideChannel = new Map<
    string,
    { firstRun: JourneyRunReport; retryRun?: JourneyRunReport }
  >()
  const retryOnce = async (opts: RunJourneyCliOptions): Promise<JourneyRunReport> => {
    const firstRun = await inner(opts)
    // No retry when: it passed, the dollar cap truncated it, or the shared
    // suite budget is already exhausted (a retry would only report
    // aborted-by-budget attempts — noise, not signal).
    if (
      firstRun.pass ||
      firstRun.status === ABORTED_BY_BUDGET ||
      opts.budget?.exceeded() === true
    ) {
      sideChannel.set(opts.journeyId, { firstRun })
      return firstRun
    }
    onProgress(
      `nightly: ${opts.journeyId} failed — retry-once (flake probe)` +
        (retryDelaySeconds > 0
          ? ` after ${retryDelaySeconds}s (order-cancel rate-limit window, D-014)`
          : ""),
    )
    if (retryDelaySeconds > 0) await sleepFn(retryDelaySeconds * 1000)
    const retryRun = await inner(opts)
    sideChannel.set(opts.journeyId, { firstRun, retryRun })
    return retryRun
  }

  const suite = await runJourneySuiteCli({
    only: runnable,
    ...(options.k !== undefined ? { k: options.k } : {}),
    ...(options.kMoney !== undefined ? { kMoney: options.kMoney } : {}),
    ...(options.moneyFlows !== undefined ? { moneyFlows: options.moneyFlows } : {}),
    ...(options.budgetUsd !== undefined ? { budgetUsd: options.budgetUsd } : {}),
    ...(options.dir !== undefined ? { dir: options.dir } : {}),
    ...(options.envFile !== undefined ? { envFile: options.envFile } : {}),
    ...(options.runsDir !== undefined ? { runsDir: options.runsDir } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    onProgress,
    runJourneyFn: retryOnce,
  })

  // ── Outcomes (suite-level budget truncation = red, never silently lost) ────
  const outcomes: NightlyJourneyOutcome[] = suite.journeys.map((finalReport) => {
    const side = sideChannel.get(finalReport.journey)
    if (side === undefined) {
      // The suite truncated this journey BEFORE it started (dollar cap).
      return {
        journey: finalReport.journey,
        outcome: "red" as const,
        retried: false,
        abortedByBudget: true,
        firstRun: finalReport,
      }
    }
    const retried = side.retryRun !== undefined
    const passed = (side.retryRun ?? side.firstRun).pass
    const abortedByBudget = (side.retryRun ?? side.firstRun).status === ABORTED_BY_BUDGET
    const outcome: NightlyOutcome = side.firstRun.pass
      ? "green"
      : retried && passed
        ? "yellow"
        : "red"
    return {
      journey: finalReport.journey,
      outcome,
      retried,
      abortedByBudget,
      firstRun: side.firstRun,
      ...(side.retryRun !== undefined ? { retryRun: side.retryRun } : {}),
    }
  })

  // ── Ledger fold (green deletes, yellow streaks/quarantines, red no-ops) ────
  let ledger: FlakeLedger = ledgerBefore
  let changed = false
  const newlyQuarantined: string[] = []
  for (const o of outcomes) {
    // Budget-truncated journeys never RAN — their outcome says nothing about
    // flakiness, so the ledger is left alone (same stance as red).
    if (o.abortedByBudget) continue
    const result = recordNightlyOutcome(ledger, o.journey, o.outcome, date)
    ledger = result.ledger
    changed = changed || result.changed
    if (result.newlyQuarantined) newlyQuarantined.push(o.journey)
  }
  if (changed) saveFlakeLedger(ledger, ledgerPath)
  const quarantinedAfter = quarantinedJourneyIds(ledger)

  // ── Issue payloads (the workflow step runs `gh issue create` over these) ───
  const issues: NightlyIssuePayload[] = []
  for (const o of outcomes) {
    if (o.outcome !== "red" || o.abortedByBudget) continue
    const owner = flakeOwner(ledger, o.journey)
    issues.push({
      journey: o.journey,
      owner,
      title: `[journeys-nightly] ${date}: ${o.journey} RED (hard failure)`,
      body: journeyFailureBody(o, date, owner),
    })
  }
  for (const id of newlyQuarantined) {
    const owner = flakeOwner(ledger, id)
    issues.push({
      journey: id,
      owner,
      title: `[journeys-nightly] ${date}: ${id} quarantined after 2 consecutive flaky nights`,
      body: quarantineBody(id, date, owner),
    })
  }
  if (suite.abortedByBudget) {
    issues.push({
      journey: "suite",
      owner: "",
      title: `[journeys-nightly] ${date}: suite aborted-by-budget ($${suite.budget.spentUsd.toFixed(2)} >= $${suite.budget.capUsd.toFixed(2)})`,
      body: [
        `Nightly journey suite ${date}: the dollar cap truncated the run (RED).`,
        "",
        suite.costLine,
        "",
        "Truncated journeys (reported, never dropped): " +
          suite.journeys
            .filter((j) => j.status === ABORTED_BY_BUDGET)
            .map((j) => j.journey)
            .join(", "),
        "",
        "Investigate the spend before re-running — the cap is the safety net, not a knob to raise casually (plan §7).",
      ].join("\n"),
    })
  }

  const pass = suite.pass
  onProgress(
    `nightly: ${outcomes.filter((o) => o.outcome === "green").length} green / ` +
      `${outcomes.filter((o) => o.outcome === "yellow").length} yellow / ` +
      `${outcomes.filter((o) => o.outcome === "red").length} red; ` +
      `${quarantinedSkipped.length} quarantined-skipped; ledger ${changed ? "UPDATED" : "untouched"}`,
  )

  return {
    nightly: true,
    date,
    pass,
    outcomes,
    quarantinedSkipped,
    ledger: {
      path: ledgerPath,
      changed,
      quarantinedBefore,
      quarantinedAfter,
      newlyQuarantined,
    },
    issues,
    suite,
  }
}
