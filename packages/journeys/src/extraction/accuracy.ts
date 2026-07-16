// extraction/accuracy.ts — the extraction-accuracy meter's PURE core (FE-T07,
// FE-2.3/FE-2.4). Built on the `gates/coverage.ts` template (spec's Testing
// Decisions: "the coverage gate ... is the template for the extraction-
// accuracy meter"), re-keyed from coverage CELLS (`surface:kind:decision`) to
// extraction CASES (`capability:caseId`) — the corpus's atomic unit.
//
// Division of labor (mirrors coverage.ts / accuracy-runner.ts):
//   - THIS module is pure: it scores already-driven `AccuracyCaseResult[]`
//     (utterance -> ExpectPayload evaluation, computed elsewhere) into a
//     report, captures/verifies a committed baseline, and resolves waivers.
//     No I/O except reading the committed waivers file. Fully TDD-able with
//     scripted fixtures (no live model needed) — the ticket's explicit
//     instruction: "TDD for the meter's own logic (scoring, baseline
//     compare, waivers)".
//   - `accuracy-runner.ts` is the IMPURE half: drives the live model over
//     HTTP, reads back the materialized IR via the audit-reader oracle,
//     calls `evaluateExpectPayload`, and produces the `AccuracyCaseResult[]`
//     this module consumes.
//
// Quarantine (FE-2.4: "a single stochastic miss is tolerated via the
// EXISTING retry/quarantine ledger") — deliberately NOT reinvented: this
// module accepts a `quarantined` case-key list (same seam shape as
// `computeJourneyCoverage`'s `quarantined` option) fed from the SAME
// `harness/flake-ledger.ts` machinery the nightly journey suite already
// uses, pointed at a DISTINCT committed ledger file
// (`packages/journeys/governance/extraction-flake-ledger.json` — see
// `accuracy-runner.ts`'s header). `recordNightlyOutcome` / `dequarantineJourney`
// / the `ibx journey flake` CLI already operate on arbitrary string ids, so
// no new ledger code exists here — CI wiring (T08) owns feeding outcomes
// into it; this ticket only needs the read seam.

import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { INTENT_KIND_PATTERN } from "../schema/journey.js"

// ── Waivers ──────────────────────────────────────────────────────────────────

export const ACCURACY_WAIVER_CATEGORIES = [
  "waived-known-model-limitation",
  "waived-quarantined",
] as const

export type AccuracyWaiverCategory = (typeof ACCURACY_WAIVER_CATEGORIES)[number]

const AccuracyWaiverEntrySchema = z
  .object({
    capability: z.string().regex(INTENT_KIND_PATTERN),
    /** Absent ≙ `"*"` — the waiver covers every case of the capability. */
    caseId: z.union([z.string().min(1), z.literal("*")]).optional(),
    category: z.enum(ACCURACY_WAIVER_CATEGORIES),
    reason: z.string().min(1),
    /** ISO date (YYYY-MM-DD…) the waiver was granted. */
    addedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  })
  .strict()

export const AccuracyWaiversFileSchema = z.array(AccuracyWaiverEntrySchema)

export type AccuracyWaiver = z.infer<typeof AccuracyWaiverEntrySchema>

/**
 * The committed waivers file (binding path):
 * `packages/journeys/governance/extraction-accuracy-waivers.json`. Resolved
 * relative to this module so it works from both `src/` and `dist/`.
 */
export const DEFAULT_ACCURACY_WAIVERS_PATH = fileURLToPath(
  new URL("../../governance/extraction-accuracy-waivers.json", import.meta.url),
)

// ── Case results (the runner's output; this module's input) ─────────────────

/** One driven case's outcome — already evaluated against its `expectPayload`. */
export interface AccuracyCaseResult {
  capability: string
  caseId: string
  utterance: string
  ok: boolean
  /** Per-clause diagnostics from `evaluateExpectPayload` (empty when ok). */
  failures: readonly string[]
  /** Wall-clock for the drive (diagnostic; absent for scripted fixtures). */
  durationMs?: number
}

/** Stable case identity: `<capability>:<caseId>` (the baseline unit). */
export function accuracyCaseKey(capability: string, caseId: string): string {
  return `${capability}:${caseId}`
}

export type AccuracyCaseState = "passing" | "failing" | AccuracyWaiverCategory

export interface AccuracyCase {
  key: string
  capability: string
  caseId: string
  utterance: string
  state: AccuracyCaseState
  failures: readonly string[]
  durationMs?: number
  waiver: { category: AccuracyWaiverCategory; reason: string; addedAt: string | null } | null
}

export interface CapabilityAccuracy {
  capability: string
  total: number
  passing: number
  /** `passing / total`, `0` when `total === 0` (never NaN). */
  ratio: number
}

export type AccuracyProblemCode = "waivers_unreadable" | "waivers_invalid" | "duplicate_case_key"

export interface AccuracyProblem {
  code: AccuracyProblemCode
  file: string
  message: string
}

export interface AccuracyReport {
  ok: boolean
  cases: AccuracyCase[]
  byCapability: CapabilityAccuracy[]
  /** File waivers matching zero driven case (e.g. a retired corpus case). */
  dormantWaivers: AccuracyWaiver[]
  problems: AccuracyProblem[]
}

export interface ComputeAccuracyReportOptions {
  /** The driven results to score (from `accuracy-runner.ts`, or a test fixture). */
  results: readonly AccuracyCaseResult[]
  /** Waivers file override (default: the committed governance file). */
  waiversPath?: string
  /**
   * Quarantined case keys (`<capability>:<caseId>`) — the minimal seam. The
   * extraction-scoped flake ledger (via `ibx journey flake --ledger
   * <extraction-ledger-path> --list-quarantined`) owns the authoritative
   * quarantine state and supplies this list.
   */
  quarantined?: readonly string[]
}

/** Load + validate the waivers file, recording any failure as a problem. */
async function loadAccuracyWaivers(
  waiversPath: string,
  problems: AccuracyProblem[],
): Promise<AccuracyWaiver[]> {
  try {
    const raw: unknown = JSON.parse(await readFile(waiversPath, "utf8"))
    const parsed = AccuracyWaiversFileSchema.safeParse(raw)
    if (parsed.success) return parsed.data
    problems.push({
      code: "waivers_invalid",
      file: waiversPath,
      message: parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; "),
    })
    return []
  } catch (err) {
    problems.push({
      code: err instanceof SyntaxError ? "waivers_invalid" : "waivers_unreadable",
      file: waiversPath,
      message: (err as Error).message,
    })
    return []
  }
}

/** Assign one case's final state: quarantined ▸ file waiver ▸ passing/failing. */
function applyCaseState(
  entry: { ok: boolean; key: string },
  quarantinedKeys: ReadonlySet<string>,
  waiver: AccuracyWaiver | undefined,
): { state: AccuracyCaseState; waiver: AccuracyCase["waiver"] } {
  if (quarantinedKeys.has(entry.key)) {
    return {
      state: "waived-quarantined",
      waiver: {
        category: "waived-quarantined",
        reason: "quarantined (extraction flake ledger)",
        addedAt: null,
      },
    }
  }
  if (waiver !== undefined) {
    return {
      state: waiver.category,
      waiver: { category: waiver.category, reason: waiver.reason, addedAt: waiver.addedAt },
    }
  }
  return { state: entry.ok ? "passing" : "failing", waiver: null }
}

/** Tally per-capability totals over the FINAL case states (waived/quarantined count as passing — they are not a hard fail, matching coverage's `covered` semantics for waived cells is intentionally NOT mirrored here: ratio reporting counts only genuinely-passing cases, so a waiver never inflates the reported accuracy number). */
function computeCapabilityAccuracy(cases: readonly AccuracyCase[]): CapabilityAccuracy[] {
  const byCapability = new Map<string, { total: number; passing: number }>()
  for (const c of cases) {
    const entry = byCapability.get(c.capability) ?? { total: 0, passing: 0 }
    entry.total += 1
    if (c.state === "passing") entry.passing += 1
    byCapability.set(c.capability, entry)
  }
  return [...byCapability.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([capability, { total, passing }]) => ({
      capability,
      total,
      passing,
      ratio: total === 0 ? 0 : passing / total,
    }))
}

/**
 * Score a driven run into a report. Never throws on content — a broken
 * waivers file lands in `report.problems` (and a report with problems is NOT
 * trustworthy: `ok: false`); a duplicate `(capability, caseId)` pair in
 * `results` (a runner/corpus bug — the schema's own `duplicate_case_id`
 * check prevents this within one corpus file, but nothing prevents it
 * ACROSS files) is ALSO a problem, never silently last-write-wins.
 */
export async function computeAccuracyReport(
  options: ComputeAccuracyReportOptions,
): Promise<AccuracyReport> {
  const problems: AccuracyProblem[] = []
  const quarantinedKeys = new Set(options.quarantined ?? [])

  const waiversPath = options.waiversPath ?? DEFAULT_ACCURACY_WAIVERS_PATH
  const waivers = await loadAccuracyWaivers(waiversPath, problems)

  const seenKeys = new Set<string>()
  const matchedWaivers = new Set<AccuracyWaiver>()
  const cases: AccuracyCase[] = []
  for (const result of options.results) {
    const key = accuracyCaseKey(result.capability, result.caseId)
    if (seenKeys.has(key)) {
      problems.push({
        code: "duplicate_case_key",
        file: "<results>",
        message: `duplicate (capability, caseId) across the driven run: ${key}`,
      })
      continue
    }
    seenKeys.add(key)

    const waiver = waivers.find(
      (w) =>
        w.capability === result.capability &&
        (w.caseId === undefined || w.caseId === "*" || w.caseId === result.caseId),
    )
    if (waiver !== undefined) matchedWaivers.add(waiver)
    const { state, waiver: resolvedWaiver } = applyCaseState(
      { ok: result.ok, key },
      quarantinedKeys,
      waiver,
    )
    cases.push({
      key,
      capability: result.capability,
      caseId: result.caseId,
      utterance: result.utterance,
      state,
      failures: result.failures,
      ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
      waiver: resolvedWaiver,
    })
  }

  const dormantWaivers = waivers.filter((w) => !matchedWaivers.has(w))

  return {
    ok: problems.length === 0,
    cases,
    byCapability: computeCapabilityAccuracy(cases),
    dormantWaivers,
    problems,
  }
}

// ── Baseline (passing→not-passing regression gate) ──────────────────────────

export interface AccuracyBaseline {
  /** Case keys (`<capability>:<caseId>`) the baseline claims PASSING. */
  passing: string[]
}

export const AccuracyBaselineSchema = z
  .object({ passing: z.array(z.string()) })
  .strict()

/**
 * Explicit string comparator (S2871) reproducing the default
 * `Array.prototype.sort()` UTF-16 code-unit order — kept so serialized
 * baselines stay byte-identical across runs (mirrors coverage.ts).
 */
function byStringOrder(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** Capture the current passing cases as a baseline (sorted, stable). */
export function accuracyBaseline(report: AccuracyReport): AccuracyBaseline {
  return {
    passing: report.cases
      .filter((c) => c.state === "passing")
      .map((c) => c.key)
      .sort(byStringOrder),
  }
}

export interface AccuracyRegression {
  case: string
  /** Current state of the baseline-claimed case (`absent` = case retired/renamed). */
  state: AccuracyCaseState | "absent"
}

export interface AccuracyBaselineResult {
  ok: boolean
  /** Baseline-claimed cases no longer passing (and not quarantined/waived) — FAIL. */
  regressions: AccuracyRegression[]
  /** Baseline-claimed cases now `waived-quarantined` — visible, NOT failing. */
  quarantinedClaims: string[]
  /**
   * Baseline-claimed cases now covered by a NON-quarantine file waiver (e.g.
   * `waived-known-model-limitation`) — visible, NOT failing. This is the
   * ticket's "add a waiver, observe it pass" AC: a case that regressed
   * (baseline says passing, run says failing) is excused by authoring a
   * waiver for it, exactly like a quarantine excuses a flaky one.
   */
  waivedClaims: string[]
  /** Passing cases the baseline does not claim yet — reported, never failed
   *  (FE-2.4: "new capabilities are reported, not failed" — this generalizes
   *  to any new CASE, since a brand-new capability's cases are, by
   *  definition, entirely unclaimed). */
  newlyPassing: string[]
}

/**
 * Compare the current report against a committed baseline (the coverage
 * gate's EXACT tolerance policy, re-keyed to cases): a baseline-claimed
 * PASSING case that is now genuinely `failing` or `absent` is a hard
 * regression (exit nonzero in the CLI) — no fuzzy percentage-drop tolerance
 * band. A case now in ANY waiver state (`waived-quarantined` via the flake
 * ledger, or a file waiver like `waived-known-model-limitation`) is
 * surfaced but does NOT fail — the waiver/ledger is the accepted excuse.
 */
export function verifyAccuracyBaseline(
  report: AccuracyReport,
  baseline: AccuracyBaseline,
): AccuracyBaselineResult {
  const byKey = new Map(report.cases.map((c) => [c.key, c]))
  const regressions: AccuracyRegression[] = []
  const quarantinedClaims: string[] = []
  const waivedClaims: string[] = []
  const claimed = new Set(baseline.passing)

  for (const key of baseline.passing) {
    const c = byKey.get(key)
    if (c === undefined) {
      regressions.push({ case: key, state: "absent" })
    } else if (c.state === "passing") {
      // fine — still claims the baseline.
    } else if (c.state === "waived-quarantined") {
      quarantinedClaims.push(key)
    } else if ((ACCURACY_WAIVER_CATEGORIES as readonly string[]).includes(c.state)) {
      waivedClaims.push(key)
    } else {
      regressions.push({ case: key, state: c.state })
    }
  }

  const newlyPassing = report.cases
    .filter((c) => c.state === "passing" && !claimed.has(c.key))
    .map((c) => c.key)
    .sort(byStringOrder)

  return { ok: regressions.length === 0, regressions, quarantinedClaims, waivedClaims, newlyPassing }
}
