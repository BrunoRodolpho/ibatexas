// extraction/accuracy.test.ts — the extraction-accuracy meter's pure core
// (FE-T07). TDD per the ticket's own instruction: scoring, baseline compare,
// and waivers are exercised with SCRIPTED fixtures — no live model, no HTTP,
// no DB. The live-driven half (accuracy-runner.ts) is proven by the recorded
// live run in the PR report, not by these unit tests.

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  accuracyBaseline,
  accuracyCaseKey,
  computeAccuracyReport,
  verifyAccuracyBaseline,
  type AccuracyCaseResult,
} from "../accuracy.js"

// A committed-but-empty waivers file, shared by every test that doesn't care
// about waiver content — mirrors coverage.ts's own strict posture (an
// UNREADABLE waivers file is a `problem`/`ok:false`, never silently treated
// as empty; see the dedicated "unreadable" test below for THAT behavior).
let emptyWaiversDir: string
let EMPTY_WAIVERS_PATH: string
beforeAll(async () => {
  emptyWaiversDir = await mkdtemp(join(tmpdir(), "accuracy-empty-waivers-"))
  EMPTY_WAIVERS_PATH = join(emptyWaiversDir, "waivers.json")
  await writeFile(EMPTY_WAIVERS_PATH, "[]")
})
afterAll(async () => {
  await rm(emptyWaiversDir, { recursive: true, force: true })
})

function result(overrides: Partial<AccuracyCaseResult> & Pick<AccuracyCaseResult, "capability" | "caseId" | "ok">): AccuracyCaseResult {
  return {
    utterance: "utterance",
    failures: [],
    ...overrides,
  }
}

describe("accuracyCaseKey", () => {
  it("joins capability and caseId with a colon", () => {
    expect(accuracyCaseKey("order.status.transition", "case-1")).toBe(
      "order.status.transition:case-1",
    )
  })
})

describe("computeAccuracyReport — scoring", () => {
  it("marks a passing result 'passing' and a failing result 'failing'", async () => {
    const report = await computeAccuracyReport({
      results: [
        result({ capability: "order.status.transition", caseId: "a", ok: true }),
        result({
          capability: "order.status.transition",
          caseId: "b",
          ok: false,
          failures: ["extractionIR.payload.newStatus: expected \"ready\", got \"confirmed\""],
        }),
      ],
      waiversPath: EMPTY_WAIVERS_PATH,
    })
    expect(report.ok).toBe(true)
    const byId = new Map(report.cases.map((c) => [c.caseId, c]))
    expect(byId.get("a")?.state).toBe("passing")
    expect(byId.get("b")?.state).toBe("failing")
    expect(byId.get("b")?.failures).toHaveLength(1)
  })

  it("computes per-capability totals/passing/ratio, sorted by capability", async () => {
    const report = await computeAccuracyReport({
      results: [
        result({ capability: "order.status.transition", caseId: "a", ok: true }),
        result({ capability: "order.status.transition", caseId: "b", ok: true }),
        result({ capability: "order.status.transition", caseId: "c", ok: false }),
        result({ capability: "aaa.first.capability", caseId: "x", ok: true }),
      ],
      waiversPath: EMPTY_WAIVERS_PATH,
    })
    expect(report.byCapability).toEqual([
      { capability: "aaa.first.capability", total: 1, passing: 1, ratio: 1 },
      { capability: "order.status.transition", total: 3, passing: 2, ratio: 2 / 3 },
    ])
  })

  it("never divides by zero: an empty result set yields no capability rows (not NaN)", async () => {
    const report = await computeAccuracyReport({ results: [], waiversPath: EMPTY_WAIVERS_PATH })
    expect(report.byCapability).toEqual([])
  })

  it("flags a duplicate (capability, caseId) pair across results as a problem, never silent last-write-wins", async () => {
    const report = await computeAccuracyReport({
      results: [
        result({ capability: "order.status.transition", caseId: "dup", ok: true }),
        result({ capability: "order.status.transition", caseId: "dup", ok: false }),
      ],
      waiversPath: EMPTY_WAIVERS_PATH,
    })
    expect(report.ok).toBe(false)
    expect(report.problems.map((p) => p.code)).toContain("duplicate_case_key")
    // Only the FIRST occurrence is scored — the second is dropped, not merged.
    expect(report.cases).toHaveLength(1)
  })
})

describe("computeAccuracyReport — waivers", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "accuracy-waivers-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function waiversFile(content: unknown): Promise<string> {
    const path = join(dir, "waivers.json")
    await writeFile(path, JSON.stringify(content))
    return path
  }

  it("a case-specific waiver overrides a failing result to its waiver category", async () => {
    const waiversPath = await waiversFile([
      {
        capability: "order.status.transition",
        caseId: "flaky-case",
        category: "waived-known-model-limitation",
        reason: "documented ambiguity in the paraphrase",
        addedAt: "2026-07-16",
      },
    ])
    const report = await computeAccuracyReport({
      results: [result({ capability: "order.status.transition", caseId: "flaky-case", ok: false })],
      waiversPath,
    })
    const c = report.cases[0]!
    expect(c.state).toBe("waived-known-model-limitation")
    expect(c.waiver).toEqual({
      category: "waived-known-model-limitation",
      reason: "documented ambiguity in the paraphrase",
      addedAt: "2026-07-16",
    })
    // A waiver never inflates the reported ratio — it's not counted as passing.
    expect(report.byCapability[0]).toMatchObject({ passing: 0, total: 1 })
  })

  it("a wildcard caseId ('*' or absent) waiver covers every case of the capability", async () => {
    const waiversPath = await waiversFile([
      {
        capability: "order.status.transition",
        category: "waived-known-model-limitation",
        reason: "capability-wide waiver, no caseId",
        addedAt: "2026-07-16",
      },
    ])
    const report = await computeAccuracyReport({
      results: [
        result({ capability: "order.status.transition", caseId: "a", ok: false }),
        result({ capability: "order.status.transition", caseId: "b", ok: false }),
      ],
      waiversPath,
    })
    expect(report.cases.every((c) => c.state === "waived-known-model-limitation")).toBe(true)
  })

  it("a waiver matching zero driven case is reported as dormant, never an error", async () => {
    const waiversPath = await waiversFile([
      {
        capability: "order.status.transition",
        caseId: "retired-case",
        category: "waived-known-model-limitation",
        reason: "case removed from the corpus",
        addedAt: "2026-07-16",
      },
    ])
    const report = await computeAccuracyReport({
      results: [result({ capability: "order.status.transition", caseId: "a", ok: true })],
      waiversPath,
    })
    expect(report.ok).toBe(true)
    expect(report.dormantWaivers).toHaveLength(1)
    expect(report.dormantWaivers[0]?.caseId).toBe("retired-case")
  })

  it("an unreadable waivers file is a problem (ok:false), never silently empty", async () => {
    const report = await computeAccuracyReport({
      results: [result({ capability: "order.status.transition", caseId: "a", ok: true })],
      waiversPath: join(dir, "does-not-exist.json"),
    })
    expect(report.ok).toBe(false)
    expect(report.problems.map((p) => p.code)).toContain("waivers_unreadable")
  })

  it("a malformed (schema-invalid) waivers file is a problem", async () => {
    const waiversPath = await waiversFile([{ capability: "not a dotted kind!", category: "bogus" }])
    const report = await computeAccuracyReport({
      results: [result({ capability: "order.status.transition", caseId: "a", ok: true })],
      waiversPath,
    })
    expect(report.ok).toBe(false)
    expect(report.problems.map((p) => p.code)).toContain("waivers_invalid")
  })
})

describe("computeAccuracyReport — quarantine seam", () => {
  it("a quarantined case key overrides a failing result to waived-quarantined, and never counts toward passing", async () => {
    const report = await computeAccuracyReport({
      results: [result({ capability: "order.status.transition", caseId: "flaky", ok: false })],
      waiversPath: EMPTY_WAIVERS_PATH,
      quarantined: [accuracyCaseKey("order.status.transition", "flaky")],
    })
    expect(report.cases[0]?.state).toBe("waived-quarantined")
    expect(report.byCapability[0]).toMatchObject({ passing: 0, total: 1 })
  })

  it("quarantine takes precedence over a file waiver (both present)", async () => {
    const report = await computeAccuracyReport({
      results: [result({ capability: "order.status.transition", caseId: "flaky", ok: false })],
      waiversPath: EMPTY_WAIVERS_PATH,
      quarantined: [accuracyCaseKey("order.status.transition", "flaky")],
    })
    expect(report.cases[0]?.waiver?.category).toBe("waived-quarantined")
  })
})

describe("accuracyBaseline + verifyAccuracyBaseline", () => {
  it("captures exactly the passing case keys, sorted", async () => {
    const report = await computeAccuracyReport({
      results: [
        result({ capability: "order.status.transition", caseId: "b", ok: true }),
        result({ capability: "order.status.transition", caseId: "a", ok: true }),
        result({ capability: "order.status.transition", caseId: "c", ok: false }),
      ],
      waiversPath: EMPTY_WAIVERS_PATH,
    })
    expect(accuracyBaseline(report)).toEqual({
      passing: ["order.status.transition:a", "order.status.transition:b"],
    })
  })

  it("passes with no regressions when every baseline-claimed case still passes", async () => {
    const report = await computeAccuracyReport({
      results: [result({ capability: "order.status.transition", caseId: "a", ok: true })],
      waiversPath: EMPTY_WAIVERS_PATH,
    })
    const baseline = accuracyBaseline(report)
    const verify = verifyAccuracyBaseline(report, baseline)
    expect(verify).toEqual({
      ok: true,
      regressions: [],
      quarantinedClaims: [],
      waivedClaims: [],
      newlyPassing: [],
    })
  })

  it("FAILS on a baseline-claimed case that now fails (the schema-regression AC)", async () => {
    const baseline = { passing: ["order.status.transition:a"] }
    const report = await computeAccuracyReport({
      results: [
        result({
          capability: "order.status.transition",
          caseId: "a",
          ok: false,
          failures: ["extractionIR.payload.newStatus: expected \"ready\", got \"confirmed\""],
        }),
      ],
      waiversPath: EMPTY_WAIVERS_PATH,
    })
    const verify = verifyAccuracyBaseline(report, baseline)
    expect(verify.ok).toBe(false)
    expect(verify.regressions).toEqual([{ case: "order.status.transition:a", state: "failing" }])
  })

  it("FAILS on a baseline-claimed case that is now absent from the run (retired/renamed, never silently dropped)", async () => {
    const baseline = { passing: ["order.status.transition:removed-case"] }
    const report = await computeAccuracyReport({
      results: [result({ capability: "order.status.transition", caseId: "a", ok: true })],
      waiversPath: EMPTY_WAIVERS_PATH,
    })
    const verify = verifyAccuracyBaseline(report, baseline)
    expect(verify.ok).toBe(false)
    expect(verify.regressions).toEqual([{ case: "order.status.transition:removed-case", state: "absent" }])
  })

  it("does NOT fail on a baseline-claimed case that is now waived-quarantined — surfaced, not failed (the flake ledger owns it)", async () => {
    const baseline = { passing: ["order.status.transition:flaky"] }
    const report = await computeAccuracyReport({
      results: [result({ capability: "order.status.transition", caseId: "flaky", ok: false })],
      waiversPath: EMPTY_WAIVERS_PATH,
      quarantined: [accuracyCaseKey("order.status.transition", "flaky")],
    })
    const verify = verifyAccuracyBaseline(report, baseline)
    expect(verify.ok).toBe(true)
    expect(verify.quarantinedClaims).toEqual(["order.status.transition:flaky"])
  })

  it("does NOT fail on a newly-passing case the baseline doesn't claim yet (the waiver AC: add a waiver, observe it pass)", async () => {
    const baseline = { passing: [] as string[] }
    const report = await computeAccuracyReport({
      results: [result({ capability: "order.status.transition", caseId: "a", ok: true })],
      waiversPath: EMPTY_WAIVERS_PATH,
    })
    const verify = verifyAccuracyBaseline(report, baseline)
    expect(verify.ok).toBe(true)
    expect(verify.newlyPassing).toEqual(["order.status.transition:a"])
  })

  it("passes when a baseline-claimed case is now waived-known-model-limitation via a NEW waiver (the waiver AC end-to-end)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "accuracy-waiver-ac-"))
    try {
      const waiversPath = join(dir, "waivers.json")
      await writeFile(
        waiversPath,
        JSON.stringify([
          {
            capability: "order.status.transition",
            caseId: "a",
            category: "waived-known-model-limitation",
            reason: "added to unblock a known non-deterministic paraphrase",
            addedAt: "2026-07-16",
          },
        ]),
      )
      const baseline = { passing: ["order.status.transition:a"] }
      // Without the waiver this would be a hard regression (schema drift);
      // WITH the waiver, the same failing result passes the baseline gate.
      const report = await computeAccuracyReport({
        results: [result({ capability: "order.status.transition", caseId: "a", ok: false })],
        waiversPath,
      })
      const verify = verifyAccuracyBaseline(report, baseline)
      expect(verify.ok).toBe(true)
      expect(verify.regressions).toEqual([])
      expect(verify.waivedClaims).toEqual(["order.status.transition:a"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("computeAccuracyReport — isolation failures (review MAJOR follow-up, #263)", () => {
  it("a clearHistory failure produces a hard isolation_degraded problem and forces ok:false, even when every case otherwise passes — degraded isolation must never read as a trustworthy run", async () => {
    const report = await computeAccuracyReport({
      results: [result({ capability: "order.status.transition", caseId: "a", ok: true })],
      waiversPath: EMPTY_WAIVERS_PATH,
      isolationFailures: [
        { capability: "order.status.transition", caseId: "a", detail: "REDIS_URL env var required" },
      ],
    })
    expect(report.ok).toBe(false)
    expect(report.problems).toEqual([
      {
        code: "isolation_degraded",
        file: "order.status.transition:a",
        message: expect.stringContaining("REDIS_URL env var required"),
      },
    ])
    // The case itself still scores normally — isolation degradation is a
    // report-level trust problem, not a silent per-case override. The CLI's
    // `if (!report.ok)` gate (the SAME one waivers_unreadable/duplicate_case_key
    // already rely on) is what turns this into a nonzero exit — including on
    // the --verify-file path, since that check runs BEFORE any baseline
    // comparison is even attempted.
    expect(report.cases[0]?.state).toBe("passing")
  })

  it("multiple isolation failures each produce their own attributed problem", async () => {
    const report = await computeAccuracyReport({
      results: [
        result({ capability: "order.status.transition", caseId: "a", ok: true }),
        result({ capability: "order.status.transition", caseId: "b", ok: true }),
      ],
      waiversPath: EMPTY_WAIVERS_PATH,
      isolationFailures: [
        { capability: "order.status.transition", caseId: "a", detail: "boom-a" },
        { capability: "order.status.transition", caseId: "b", detail: "boom-b" },
      ],
    })
    expect(report.ok).toBe(false)
    expect(report.problems).toHaveLength(2)
    expect(report.problems.map((p) => p.code)).toEqual(["isolation_degraded", "isolation_degraded"])
    expect(report.problems.map((p) => p.file)).toEqual([
      "order.status.transition:a",
      "order.status.transition:b",
    ])
  })

  it("no isolationFailures option at all (the default) never adds a problem — an unaffected run stays trustworthy", async () => {
    const report = await computeAccuracyReport({
      results: [result({ capability: "order.status.transition", caseId: "a", ok: true })],
      waiversPath: EMPTY_WAIVERS_PATH,
    })
    expect(report.ok).toBe(true)
    expect(report.problems).toEqual([])
  })
})
