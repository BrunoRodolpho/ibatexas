// extraction/committed-governance.test.ts — FE-T08: validates the REAL,
// COMMITTED extraction-accuracy governance artifacts (not scripted
// fixtures) end to end. This is the vitest-side half of the certifying,
// per-commit gate — it rides the EXISTING required `check` CI job via
// `pnpm test` (turbo), no new CI wiring needed for these specific checks.
// The `ibx journey extraction-consistency` CLI command (packages/cli)
// re-runs an EQUIVALENT check as an explicitly NAMED CI step (matching the
// F11/F12/ERDS-055/056/057 convention) — deliberately redundant: this repo
// already treats two independent implementations of the same governance
// check as a feature (each can catch a bug the other has), not waste.
//
// Corpus self-validity (schema-valid, parses) already has its own pin:
// `load.test.ts`'s "loads the REAL committed corpus... without errors".
// What's NEW here: the committed WAIVERS file had no test validating it at
// all (a real gap — `accuracy.test.ts` only ever exercises TEMP waiver
// fixtures), and nothing cross-referenced the committed BASELINE against
// the committed CORPUS.

import { describe, expect, it } from "vitest"
import { computeAccuracyReport, type AccuracyBaseline } from "../accuracy.js"
import { loadExtractionCorpus } from "../load.js"
import { checkBaselineAgainstCorpus } from "../static-gate.js"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const BASELINE_PATH = fileURLToPath(
  new URL("../../../governance/extraction-accuracy-baseline.json", import.meta.url),
)

async function loadCommittedBaseline(): Promise<AccuracyBaseline> {
  return JSON.parse(await readFile(BASELINE_PATH, "utf8")) as AccuracyBaseline
}

describe("committed extraction-accuracy governance artifacts (FE-T08 certifying gate)", () => {
  it("the committed waivers file (extraction-accuracy-waivers.json) parses and validates — a run driven with ZERO results still reports ok (no waivers_unreadable/waivers_invalid problem)", async () => {
    // An empty `results` set can never trigger duplicate_case_key or
    // isolation_degraded — so any problem this produces can ONLY come from
    // the waivers file itself, isolating exactly what this test claims to check.
    const report = await computeAccuracyReport({ results: [] })
    expect(report.problems).toEqual([])
    expect(report.ok).toBe(true)
  })

  it("the committed baseline file (extraction-accuracy-baseline.json) is valid JSON shaped {passing: string[]}", async () => {
    const baseline = await loadCommittedBaseline()
    expect(Array.isArray(baseline.passing)).toBe(true)
    expect(baseline.passing.length).toBeGreaterThan(0)
  })

  it("every case the committed baseline claims 'passing' still exists in the committed corpus — no orphaned claims (a rename/removal without a baseline update)", async () => {
    const [baseline, corpus] = await Promise.all([loadCommittedBaseline(), loadExtractionCorpus()])
    const result = checkBaselineAgainstCorpus(baseline, corpus)
    expect(result.orphanedBaselineClaims).toEqual([])
    expect(result.ok).toBe(true)
  })
})
