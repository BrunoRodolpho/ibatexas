// META-ENFORCEMENT — "no new rejection class lands without a conformance
// fixture" (LE2-017), as a mechanism rather than a convention.
//
// Ticket 17's fourth acceptance criterion is a CONVENTION, and a convention
// that lives only in a README is a convention that lapses on the first busy
// afternoon. So this file does not read a documented rule id list: it PARSES
// `src/compiler/` for the passes registered there and every rule id they can
// emit (see `../rule-inventory.ts`), and fails — naming the gap — when the
// corpus does not cover one.
//
// That is what makes the suite EXTENSIBLE rather than merely present. Ticket
// 18's boot reconciliation and tickets 20/22's journey / compensation /
// lifecycle passes each add rule ids to the compiler; the moment they do, this
// test goes red until their fixtures land, in the same change.
//
// The inventory is ALSO golden-pinned, so a rule id that appears, disappears
// or is renamed is a reviewable diff rather than a silent change of what the
// compiler promises.

import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { CATALOG_PASSES } from "../../compiler/index.js"
import { CONFORMANCE_FIXTURES } from "../fixtures/index.js"
import {
  canonicalize,
  computeInventoryGolden,
  goldenFileName,
  goldenPath,
  GOLDEN_DIR,
  INVENTORY_GOLDEN_NAME,
} from "../golden.js"
import { expectedGoldenFiles } from "../regenerate.js"
import { ConformanceScanError, scanPassRuleInventory, scanRuleIds } from "../rule-inventory.js"
import { declaredRules } from "../types.js"

const INVENTORY = scanPassRuleInventory()
const RULE_IDS = scanRuleIds()
const REGISTERED_PASS_IDS = CATALOG_PASSES.map((pass) => pass.id)

/** Every `<pass>/<rule>` some fixture declares it covers. */
const COVERED_RULES = new Set(CONFORMANCE_FIXTURES.flatMap(declaredRules))

/** Every pass some fixture's TARGET rule belongs to. */
const COVERED_PASSES = new Set(
  CONFORMANCE_FIXTURES.flatMap((fixture) =>
    fixture.targets === null ? [] : [fixture.targets.split("/")[0] ?? ""],
  ),
)

function scannerFixtureDir(name: string): string {
  return fileURLToPath(new URL(`./scanner-fixtures/${name}/`, import.meta.url))
}

describe("meta-enforcement — the compiler's own source is the source of truth", () => {
  it("finds exactly the registered passes — no unregistered pass, no unscanned one", () => {
    expect([...INVENTORY.map((entry) => entry.pass)].sort()).toEqual(
      [...REGISTERED_PASS_IDS].sort(),
    )
  })

  it("finds at least one rule id per pass (a pass that can reject nothing is not a pass)", () => {
    for (const entry of INVENTORY) {
      expect(entry.rules.length, `pass "${entry.pass}" yielded no rule ids`).toBeGreaterThan(0)
      expect(entry.sources.length).toBeGreaterThan(0)
    }
  })

  it("REFUSES a rule id it cannot attribute to a pass, instead of under-reporting", () => {
    expect(() => scanPassRuleInventory(scannerFixtureDir("unattributed"))).toThrow(
      ConformanceScanError,
    )
    expect(() => scanPassRuleInventory(scannerFixtureDir("unattributed"))).toThrow(
      /declares no `const PASS/,
    )
  })

  it("REFUSES a rule id it cannot statically resolve, instead of under-reporting", () => {
    expect(() => scanPassRuleInventory(scannerFixtureDir("computed"))).toThrow(
      ConformanceScanError,
    )
    expect(() => scanPassRuleInventory(scannerFixtureDir("computed"))).toThrow(
      /cannot statically\s+resolve/,
    )
  })
})

describe("meta-enforcement — every rejection class has a conformance fixture", () => {
  it("covers EVERY rule id the compiler can emit", () => {
    const uncovered = RULE_IDS.filter((rule) => !COVERED_RULES.has(rule))
    expect(
      uncovered,
      "these rejection classes have no conformance fixture. LE2 Testing Decisions: " +
        '"every rejection class gets a fixture catalog that must fail to compile". ' +
        "Add one fixture catalog per rule id under src/conformance/fixtures/, then " +
        "`pnpm --filter @ibatexas/catalog run conformance:regen`.",
    ).toEqual([])
  })

  it("covers EVERY registered pass", () => {
    const uncovered = REGISTERED_PASS_IDS.filter((pass) => !COVERED_PASSES.has(pass))
    expect(uncovered, "these passes have no conformance fixture at all").toEqual([])
  })

  it("has no fixture for a rule the compiler cannot emit (a stale or renamed rule)", () => {
    const known = new Set(RULE_IDS)
    const stale = [...COVERED_RULES].filter((rule) => !known.has(rule)).sort()
    expect(
      stale,
      "these fixtures claim rule ids no pass emits any more — the rule was renamed " +
        "or removed and its fixture was left behind",
    ).toEqual([])
  })

  it("keeps one fixture per rule id — the corpus is a map, not a pile", () => {
    const targets = CONFORMANCE_FIXTURES.flatMap((f) => (f.targets === null ? [] : [f.targets]))
    expect(new Set(targets).size).toBe(targets.length)
  })
})

describe("meta-enforcement — the goldens and the inventory", () => {
  it("has a committed golden for every fixture, and no orphaned goldens", () => {
    const committed = readdirSync(GOLDEN_DIR)
      .filter((name) => name.endsWith(".json"))
      .sort()
    expect(committed).toEqual([...expectedGoldenFiles()].sort())
    for (const fixture of CONFORMANCE_FIXTURES) {
      expect(committed).toContain(goldenFileName(fixture.name))
    }
  })

  it("pins the pass/rule inventory byte-identically (an added rule is a visible diff)", () => {
    expect(canonicalize(computeInventoryGolden())).toBe(
      readFileSync(goldenPath(INVENTORY_GOLDEN_NAME), "utf8"),
    )
  })
})
