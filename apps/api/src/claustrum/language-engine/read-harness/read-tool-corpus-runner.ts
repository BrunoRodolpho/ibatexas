// read-harness/read-tool-corpus-runner.ts — FE-D22: the IN-PROCESS read-tool
// extraction-calibration runner.
//
// T07's extraction-accuracy meter scores the express_intent AUDIT SIDECAR
// (AuditRecord.metadata.languageEngine) — but reads NEVER adjudicate, so a read-tool
// call produces no AuditRecord to score. This runner closes that gap WITHOUT a new
// capture seam: it drives each read-tool corpus utterance through the REAL planner
// surface (`createIbatexasPlanner.propose`) with an INJECTED ModelProvider, reads the
// emitted `plan.readToolCalls`, and reconstructs the sanitized args via the SAME
// production choke point the wire uses (`sanitizeReadToolInput`). No HTTP, no
// VictoriaLogs, no hook in the planner source.
//
// Scoring reuses the schema-agnostic `extraction/accuracy.ts` machinery
// (`computeAccuracyReport` / `accuracyBaseline` / `verifyAccuracyBaseline`) via the
// pure `scoreReadToolCase` adapter — keyed `<readTool>:<caseId>`, with a SEPARATE
// read-tools baseline + waivers file (packages/journeys/governance/, never mixed
// with the mutating extraction baseline).
//
// TOOL VISIBILITY (the load-bearing wiring): a model tool-call is only recorded in
// `plan.readToolCalls` when its name is in the turn's `visibleReadTools`
// (ibatexas-planner.ts). The runner therefore constructs the planner with a capability
// planner that makes EVERY corpus tool visible — a controlled surface (cross-tool
// confusion is measurable: an utterance for `check_order_status` must not call
// `get_payment_status`). The model still sees each tool's REAL authored schema
// (buildToolSurface pulls READ_TOOL_SCHEMAS_BY_NAME), so the extraction is faithful.
//
// ── LIVE INVOCATION RECIPE (deferred — owner skip-live) ────────────────────────
// The unit deliverable drives a SCRIPTED ModelProvider (see the __tests__). A LIVE
// calibration run is the SAME `runReadToolCorpus` with the real provider:
//
//   const model = createOllamaProvider(...)            // the real 4B port
//   const outcome = await reportReadToolAccuracy({
//     model,
//     // order/payment corpora need a real owned order — seed it dry-run-capably:
//     beforeCase: async ({ tool }) => {
//       if (tool === "check_order_status" || tool === "get_payment_status") {
//         await seedOwnedOrder({ customerId: LIVE_CUSTOMER, dryRun: false })  // live window only
//       }
//     },
//   })
//   // 2-CLEAN-PASS rule stands: only after two clean live passes may
//   // read-tool-accuracy-baseline.json gain entries (none are claimed now).
//
// No live run is performed here and NO baseline entries are claimed.

import { readFile } from "node:fs/promises"
import type { CapabilityPlanner } from "@adjudicate/core/llm"
import type { CognitiveState, ModelProvider } from "@claustrum/core"
import {
  AccuracyBaselineSchema,
  DEFAULT_READ_TOOL_ACCURACY_BASELINE_PATH,
  DEFAULT_READ_TOOL_ACCURACY_WAIVERS_PATH,
  accuracyBaseline,
  computeAccuracyReport,
  loadReadToolCorpus,
  scoreReadToolCase,
  verifyAccuracyBaseline,
  type AccuracyBaseline,
  type AccuracyBaselineResult,
  type AccuracyCaseResult,
  type AccuracyReport,
  type ReadToolCorpusCase,
  type ReadToolCorpusFile,
} from "@ibatexas/journeys"
import { createIbatexasPlanner } from "../../ibatexas-planner.js"
import { sanitizeReadToolInput } from "../read-tool-schemas.js"

/** The dry-run-capable per-case seeding hook (live window: e.g. `seedOwnedOrder`). */
export type ReadHarnessBeforeCase = (ctx: {
  readonly tool: string
  readonly corpusCase: ReadToolCorpusCase
}) => void | Promise<void>

export interface RunReadToolCorpusOptions {
  /** The LLM port — a scripted double in unit tests, the real provider live. */
  readonly model: ModelProvider
  readonly modelId?: string
  /** Corpus dir override (default: the committed packages/journeys/read-tool-corpus). */
  readonly corpusDir?: string
  /**
   * Capability planners for the drive. Default: a single planner exposing EVERY
   * corpus tool (so any tested read-tool call is recorded). Inject the production
   * set for a state-gated live surface.
   */
  readonly capabilityPlanners?: ReadonlyArray<CapabilityPlanner<unknown, unknown>>
  /** Per-case seeding hook (order/payment corpora need a real owned order live). */
  readonly beforeCase?: ReadHarnessBeforeCase
}

/** A capability planner that makes exactly `readTools` visible (no intents). */
function readToolSurfacePlanner(
  readTools: readonly string[],
): CapabilityPlanner<unknown, unknown> {
  return {
    plan: () => ({ visibleReadTools: [...readTools], allowedIntents: [] }),
  }
}

/** Build the per-case CognitiveState (utterance + optional preceding context). */
function toCognitiveState(file: ReadToolCorpusFile, corpusCase: ReadToolCorpusCase): CognitiveState {
  return {
    perception: {
      text: corpusCase.utterance,
      channel: "web",
      receivedAt: "2026-07-18T00:00:00.000Z",
    },
    memory: {} as CognitiveState["memory"],
    retrieval: {} as CognitiveState["retrieval"],
    ...(corpusCase.precedingContext === undefined
      ? {}
      : { workingMemory: corpusCase.precedingContext }),
    tenantId: "read-harness",
    locale: "pt-BR",
    conversationId: `read-harness:${file.tool}`,
    turnId: `${file.tool}:${corpusCase.id}`,
  }
}

/**
 * Drive every read-tool corpus case through the planner + score it. Returns the
 * per-case `AccuracyCaseResult[]` the meter consumes. IMPURE (the model drive); the
 * scoring is delegated to the pure `scoreReadToolCase`.
 */
export async function runReadToolCorpus(
  opts: RunReadToolCorpusOptions,
): Promise<AccuracyCaseResult[]> {
  const corpora = await loadReadToolCorpus(opts.corpusDir)
  const readTools = [...new Set(corpora.map((f) => f.tool))]
  const capabilityPlanners = opts.capabilityPlanners ?? [readToolSurfacePlanner(readTools)]
  const planner = createIbatexasPlanner({
    model: opts.model,
    modelId: opts.modelId ?? "read-harness",
    capabilityPlanners,
  })

  const results: AccuracyCaseResult[] = []
  for (const file of corpora) {
    for (const corpusCase of file.cases) {
      if (opts.beforeCase !== undefined) await opts.beforeCase({ tool: file.tool, corpusCase })
      const startedAt = Date.now()
      const plan = await planner.propose(toCognitiveState(file, corpusCase))
      const call = (plan.readToolCalls ?? []).find((c) => c.name === file.tool)
      const emitted =
        call === undefined
          ? null
          : { sanitizedInput: sanitizeReadToolInput(file.tool, call.input) }
      const result = scoreReadToolCase(file.tool, corpusCase, emitted)
      results.push({ ...result, durationMs: Date.now() - startedAt })
    }
  }
  return results
}

export interface ReadToolAccuracyOutcome {
  readonly results: readonly AccuracyCaseResult[]
  readonly report: AccuracyReport
  readonly baselineResult: AccuracyBaselineResult
  /** The passing set captured from THIS run (for a `--update-baseline`-style CLI). */
  readonly freshBaseline: AccuracyBaseline
}

async function loadReadToolBaseline(path: string): Promise<AccuracyBaseline> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"))
  return AccuracyBaselineSchema.parse(raw)
}

/**
 * Run the corpus, score into a report (against the SEPARATE read-tools waivers),
 * and verify it against the committed read-tools baseline. The report/baseline
 * round-trip the meter's discipline: `report.ok` false ⟹ a governance problem; a
 * baseline regression ⟹ `baselineResult.ok` false.
 */
export async function reportReadToolAccuracy(
  opts: RunReadToolCorpusOptions & { readonly baselinePath?: string; readonly waiversPath?: string },
): Promise<ReadToolAccuracyOutcome> {
  const results = await runReadToolCorpus(opts)
  const report = await computeAccuracyReport({
    results,
    waiversPath: opts.waiversPath ?? DEFAULT_READ_TOOL_ACCURACY_WAIVERS_PATH,
  })
  const baseline = await loadReadToolBaseline(
    opts.baselinePath ?? DEFAULT_READ_TOOL_ACCURACY_BASELINE_PATH,
  )
  return {
    results,
    report,
    baselineResult: verifyAccuracyBaseline(report, baseline),
    freshBaseline: accuracyBaseline(report),
  }
}
