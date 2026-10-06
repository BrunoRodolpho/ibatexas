// The CONFORMANCE SUITE — golden byte-identity over the fixture corpus
// (LE2-017).
//
// This suite is the catalog compiler's COMPATIBILITY CONTRACT. It does not
// re-test the passes' logic — the five unit-test files next door do that,
// inline and in prose. What it pins is the DIAGNOSTIC CONTRACT itself: for
// each committed fixture catalog, the exact diagnostics the compiler emits,
// in the exact order, with the exact object / field / rule / message /
// reference, plus the per-pass `checked` counts and the one-line build-log
// rendering.
//
// A change here is never "just update the golden". A golden diff means one of:
// a rule changed its mind, a message changed its wording, a pass changed what
// it counts, or the total order moved. All four are real changes to what the
// compiler PROMISES, and the diff is the review artifact.
//
// Regenerate deliberately:
//   pnpm --filter @ibatexas/catalog run conformance:regen

import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  CLEAN_CONFORMANCE_FIXTURES,
  CONFORMANCE_FIXTURES,
  REJECTION_FIXTURES,
} from "../fixtures/index.js"
import { canonicalize, computeGolden, goldenPath } from "../golden.js"
import { declaredRules, type ConformanceFixture } from "../types.js"

function goldenBytes(fixture: ConformanceFixture): string {
  return readFileSync(goldenPath(fixture.name), "utf8")
}

describe("conformance corpus — golden byte-identity", () => {
  it.each(CONFORMANCE_FIXTURES)(
    "$name — the compiler's output is byte-identical to its committed golden",
    (fixture) => {
      expect(canonicalize(computeGolden(fixture))).toBe(goldenBytes(fixture))
    },
  )

  it("recompiles every fixture to identical bytes (the determinism the goldens rest on)", () => {
    for (const fixture of CONFORMANCE_FIXTURES) {
      const once = canonicalize(computeGolden(fixture))
      const twice = canonicalize(computeGolden({ ...fixture, definitions: [...fixture.definitions] }))
      expect(twice, `${fixture.name} is not deterministic`).toBe(once)
    }
  })
})

describe("conformance corpus — the contract each fixture asserts", () => {
  it("every rejection fixture FAILS to compile", () => {
    const compiled = REJECTION_FIXTURES.filter((f) => computeGolden(f).ok).map((f) => f.name)
    expect(
      compiled,
      "a rejection fixture that compiles clean proves nothing — LE2 Testing " +
        "Decisions: every rejection class gets a fixture catalog that MUST FAIL " +
        "to compile",
    ).toEqual([])
  })

  it("every clean fixture compiles clean, with no diagnostics at all", () => {
    for (const fixture of CLEAN_CONFORMANCE_FIXTURES) {
      const golden = computeGolden(fixture)
      expect(golden.ok, `${fixture.name} should compile clean`).toBe(true)
      expect(golden.diagnostics).toEqual([])
      expect(golden.rulesEmitted).toEqual([])
    }
  })

  it("emits EXACTLY the rules each fixture declares — no drive-by extra diagnostics", () => {
    for (const fixture of CONFORMANCE_FIXTURES) {
      expect(
        computeGolden(fixture).rulesEmitted,
        `${fixture.name} emits rules its registration does not declare (or fails to ` +
          "emit one it does). A fixture is a single-purpose witness: fix the fixture, " +
          "or declare the co-emission in `alsoEmits` with a reason.",
      ).toEqual(declaredRules(fixture))
    }
  })

  it("keeps each rejection fixture's target rule attributed to the pass that owns it", () => {
    for (const fixture of REJECTION_FIXTURES) {
      const [pass, rule] = (fixture.targets ?? "").split("/")
      const hit = computeGolden(fixture).diagnostics.find(
        (d) => d.pass === pass && d.rule === rule,
      )
      expect(hit, `${fixture.name} never emitted ${fixture.targets ?? ""}`).toBeDefined()
      expect(hit?.severity).toBe("error")
      expect(hit?.object).not.toBe("")
      expect(hit?.message).not.toBe("")
    }
  })

  it("names every fixture uniquely (the golden basename depends on it)", () => {
    const names = CONFORMANCE_FIXTURES.map((f) => f.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it("keeps every fixture self-contained and tiny", () => {
    for (const fixture of CONFORMANCE_FIXTURES) {
      expect(fixture.definitions.length, `${fixture.name} is not tiny`).toBeLessThanOrEqual(2)
      expect(fixture.definitions.length).toBeGreaterThan(0)
      expect(fixture.why.length, `${fixture.name} does not say why it exists`).toBeGreaterThan(20)
    }
  })
})
