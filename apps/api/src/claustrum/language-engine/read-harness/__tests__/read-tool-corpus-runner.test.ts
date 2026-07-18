// FE-D22 — the in-process read-tool calibration runner, driven by a SCRIPTED
// ModelProvider double (no live model, no DB/network). Proves the three expectArgs
// modes end-to-end, the sanitizeReadToolInput reconstruction, and the report/baseline
// round-trip. The LIVE mode is the same runner with the real provider (deferred).

import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core"
import {
  accuracyBaseline,
  computeAccuracyReport,
  verifyAccuracyBaseline,
} from "@ibatexas/journeys"
import {
  reportReadToolAccuracy,
  runReadToolCorpus,
} from "./read-tool-corpus-runner.js"

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url))
// Empty read-tools waivers (matches the committed governance file — no entries).
const EMPTY_WAIVERS = fileURLToPath(
  new URL(
    "../../../../../../../packages/journeys/governance/read-tool-accuracy-waivers.json",
    import.meta.url,
  ),
)

type ToolCalls = Completion["toolCalls"]

/** A ModelProvider that returns canned tool-calls keyed by the utterance found in
 *  the request (the utterance text always appears in the serialized request). */
function scriptedModel(byUtterance: ReadonlyArray<readonly [string, ToolCalls]>): ModelProvider {
  return {
    async complete(req: CompletionRequest): Promise<Completion> {
      const serialized = JSON.stringify(req)
      const hit = byUtterance.find(([utt]) => serialized.includes(utt))
      const toolCalls = hit?.[1] ?? []
      return {
        model: "scripted",
        stopReason: (toolCalls?.length ?? 0) > 0 ? "tool_use" : "end_turn",
        text: "",
        toolCalls,
        inputTokens: 1,
        outputTokens: 1,
      }
    },
    stream() {
      throw new Error("unused")
    },
    async embed() {
      return []
    },
  }
}

const MODEL = scriptedModel([
  // concrete args — the model emits orderReference PLUS a forbidden orderId + a bogus
  // field; sanitizeReadToolInput must strip everything but the authored orderReference.
  [
    "qual o status do pedido 42 por favor",
    [
      {
        id: "tc1",
        name: "check_order_status",
        input: { orderReference: "IBX-42", orderId: "ord_secret_internal", bogus: 1 },
      },
    ],
  ],
  // sound-abstain-ok — no tool call.
  ["e o andamento entao", []],
  // sound-abstain-violated — the model WRONGLY calls the tool.
  ["me fala logo isso ai", [{ id: "tc2", name: "check_order_status", input: {} }]],
  // argless — get_my_reservations authors no fields → sanitized args {}.
  ["quais sao minhas reservas cadastradas", [{ id: "tc3", name: "get_my_reservations", input: {} }]],
])

describe("runReadToolCorpus — the three expectArgs modes + sanitization", () => {
  it("scores each case correctly and reconstructs sanitized args", async () => {
    const results = await runReadToolCorpus({ model: MODEL, corpusDir: FIXTURE_DIR })
    const byKey = new Map(results.map((r) => [`${r.capability}:${r.caseId}`, r]))

    // concrete: the forbidden orderId + bogus field were stripped → args match.
    const concrete = byKey.get("check_order_status:concrete-with-sanitization")
    expect(concrete?.ok).toBe(true)

    // sound abstain honored (no call) → ok.
    expect(byKey.get("check_order_status:sound-abstain-ok")?.ok).toBe(true)

    // abstain VIOLATED (the model called the tool) → fail.
    const violated = byKey.get("check_order_status:sound-abstain-violated")
    expect(violated?.ok).toBe(false)
    expect(violated?.failures[0]).toContain("sound abstain")

    // argless call → sanitized {} matches expectArgs {} → ok.
    expect(byKey.get("get_my_reservations:argless-ok")?.ok).toBe(true)
  })

  it("proves the sanitization strip directly: an unauthored/forbidden field never survives", async () => {
    // A DIFFERENT expectation for the same utterance: if the runner did NOT sanitize,
    // the emitted args would carry orderId/bogus and fail a strict deep-equal. It
    // passes above ONLY because sanitizeReadToolInput reduced them to {orderReference}.
    const results = await runReadToolCorpus({ model: MODEL, corpusDir: FIXTURE_DIR })
    const concrete = results.find((r) => r.caseId === "concrete-with-sanitization")
    expect(concrete?.ok).toBe(true)
    expect(concrete?.failures).toEqual([])
  })
})

describe("reportReadToolAccuracy — report + baseline round-trip", () => {
  it("captures a fresh baseline that then verifies clean (no regressions)", async () => {
    const results = await runReadToolCorpus({ model: MODEL, corpusDir: FIXTURE_DIR })
    const report = await computeAccuracyReport({ results, waiversPath: EMPTY_WAIVERS })
    expect(report.ok).toBe(true) // no governance problems

    const fresh = accuracyBaseline(report)
    // The 3 passing cases are claimed; the failing one is NOT.
    expect(fresh.passing).toEqual([
      "check_order_status:concrete-with-sanitization",
      "check_order_status:sound-abstain-ok",
      "get_my_reservations:argless-ok",
    ])
    expect(verifyAccuracyBaseline(report, fresh).ok).toBe(true)
  })

  it("a baseline that claims a now-failing case regresses (ok=false)", async () => {
    const results = await runReadToolCorpus({ model: MODEL, corpusDir: FIXTURE_DIR })
    const report = await computeAccuracyReport({ results, waiversPath: EMPTY_WAIVERS })
    const stale = { passing: ["check_order_status:sound-abstain-violated"] }
    const verdict = verifyAccuracyBaseline(report, stale)
    expect(verdict.ok).toBe(false)
    expect(verdict.regressions.map((r) => r.case)).toContain("check_order_status:sound-abstain-violated")
  })

  it("reportReadToolAccuracy against the COMMITTED (empty) baseline: report ok, no regressions, new cases merely reported", async () => {
    const outcome = await reportReadToolAccuracy({ model: MODEL, corpusDir: FIXTURE_DIR })
    expect(outcome.report.ok).toBe(true)
    // committed baseline is empty → nothing claimed → no regressions; passing cases
    // surface as newlyPassing (reported, never failed).
    expect(outcome.baselineResult.ok).toBe(true)
    expect(outcome.baselineResult.regressions).toEqual([])
    expect(outcome.baselineResult.newlyPassing.length).toBeGreaterThan(0)
  })

  it("runs a per-case seeding hook (dry-run stub) before driving", async () => {
    const seeded: string[] = []
    await runReadToolCorpus({
      model: MODEL,
      corpusDir: FIXTURE_DIR,
      beforeCase: ({ tool, corpusCase }) => {
        seeded.push(`${tool}:${corpusCase.id}`)
      },
    })
    expect(seeded).toContain("check_order_status:concrete-with-sanitization")
    expect(seeded).toContain("get_my_reservations:argless-ok")
  })
})
