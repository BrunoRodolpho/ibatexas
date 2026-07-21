// read-tool-corpus/score.ts — FE-D22: the PURE scoring adapter that maps a
// read-tool corpus case + the (sanitized) read-tool call the runner captured onto
// an `AccuracyCaseResult` — the SAME schema-agnostic unit `extraction/accuracy.ts`
// (`computeAccuracyReport` / `accuracyBaseline` / `verifyAccuracyBaseline`) scores.
//
// The IMPURE half (drive the utterance through the planner surface, read
// `plan.readToolCalls`, reconstruct the sanitized input via the production
// `sanitizeReadToolInput` choke point) lives in the apps/api read-harness runner —
// journeys never imports apps/api. THIS module is pure (no IO), TDD-able with
// scripted fixtures.
//
// Scoring, per the three `expectArgs` corpus modes (schema.ts):
//   - `expectArgs: null`  — a SOUND ABSTAIN is expected: ok IFF the tool was NOT
//     called (a grounded extraction never guesses a lookup key it cannot know).
//   - `expectArgs: {}`    — an ARGLESS call is expected: ok IFF the tool was called
//     with empty sanitized args.
//   - `expectArgs: {…}`   — those exact sanitized args: ok IFF the tool was called
//     and its sanitized input deep-equals the expected args.

import { fileURLToPath } from "node:url"
import type { AccuracyCaseResult } from "../extraction/accuracy.js"
import type { ReadToolCorpusCase } from "./schema.js"

/**
 * The read-tools accuracy BASELINE file (binding path):
 * `packages/journeys/governance/read-tool-accuracy-baseline.json`. SEPARATE from
 * the mutating extraction-accuracy baseline — never mixed. Resolved relative to
 * this module so it works from both `src/` and `dist/`.
 */
export const DEFAULT_READ_TOOL_ACCURACY_BASELINE_PATH = fileURLToPath(
  new URL("../../governance/read-tool-accuracy-baseline.json", import.meta.url),
)

/**
 * The read-tools accuracy WAIVERS file (binding path):
 * `packages/journeys/governance/read-tool-accuracy-waivers.json`. Currently EMPTY
 * (`[]`) — no entries claimed while live runs are deferred. SEPARATE from the
 * mutating extraction-accuracy waivers.
 */
export const DEFAULT_READ_TOOL_ACCURACY_WAIVERS_PATH = fileURLToPath(
  new URL("../../governance/read-tool-accuracy-waivers.json", import.meta.url),
)

/** The sanitized read-tool call the runner captured for a case, or `null` when the
 *  corpus's tool was NOT called this turn (a sound abstain, or a wrong/absent call). */
export interface EmittedReadToolCall {
  readonly sanitizedInput: Record<string, unknown>
}

/**
 * Order-insensitive structural deep-equal over plain JSON tool args (objects /
 * arrays / scalars). Object key ORDER does not matter (a tool call's arg object is
 * unordered); array element order DOES (an ordered arg list). Pure.
 */
export function deepEqualArgs(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false
  }
  const aArr = Array.isArray(a)
  const bArr = Array.isArray(b)
  if (aArr || bArr) {
    if (!aArr || !bArr || a.length !== b.length) return false
    return a.every((x, i) => deepEqualArgs(x, (b as unknown[])[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao)
  const bk = Object.keys(bo)
  if (ak.length !== bk.length) return false
  return ak.every(
    (k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqualArgs(ao[k], bo[k]),
  )
}

/**
 * Score one read-tool corpus case against the (sanitized) call the runner captured.
 * `capability` on the result is the read-TOOL name (the schema-agnostic accuracy
 * key `<tool>:<caseId>`). Pure.
 */
export function scoreReadToolCase(
  tool: string,
  corpusCase: ReadToolCorpusCase,
  emitted: EmittedReadToolCall | null,
): AccuracyCaseResult {
  const base = { capability: tool, caseId: corpusCase.id, utterance: corpusCase.utterance }
  const expect = corpusCase.expectArgs

  if (expect === null) {
    // Sound-abstain case: the tool must NOT have been called.
    if (emitted === null) return { ...base, ok: true, failures: [] }
    return {
      ...base,
      ok: false,
      failures: [
        `expected a sound abstain (no ${tool} call) but the tool was called with ` +
          JSON.stringify(emitted.sanitizedInput),
      ],
    }
  }

  // A call IS expected (concrete args or `{}` argless).
  if (emitted === null) {
    return {
      ...base,
      ok: false,
      failures: [
        `expected a ${tool} call with args ${JSON.stringify(expect)} but the tool was not called`,
      ],
    }
  }

  if (deepEqualArgs(emitted.sanitizedInput, expect)) {
    return { ...base, ok: true, failures: [] }
  }
  return {
    ...base,
    ok: false,
    failures: [
      `args mismatch: expected ${JSON.stringify(expect)}, got ${JSON.stringify(emitted.sanitizedInput)}`,
    ],
  }
}
