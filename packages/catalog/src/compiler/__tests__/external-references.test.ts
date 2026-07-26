// The external-references pass's own contract (LE2-018).
//
// The conformance corpus next door pins the compiler's OUTPUT — exact
// diagnostics, exact order, exact bytes. This file tests the pass's REASONING:
// the boundaries the goldens can only sample (what `null` means on a consumer,
// which side of the config/catalog line a value falls on), the real authored
// table, and the layering promise that this pass does no IO.

import { describe, expect, it } from "vitest"

import { CAPABILITY_DEFINITIONS } from "../../capability-definitions/definitions.js"
import {
  EXTERNAL_REFERENCE_STORES,
  EXTERNAL_REFERENCES,
  type ExternalReferenceDeclaration,
} from "../../external-references.js"
import { runExternalReferencesPass } from "../passes/external-references.js"

/** Widen hand-authored specimens the authored type deliberately forbids. */
function table(...objects: readonly unknown[]): readonly ExternalReferenceDeclaration[] {
  return objects as readonly ExternalReferenceDeclaration[]
}

const CONSUMER_KIND = CAPABILITY_DEFINITIONS[0]?.kind ?? ""

const WELL_FORMED = {
  id: "promotion.unit",
  store: "promotion",
  keyFrom: "UNIT_COUPON_CODE",
  why: "a unit-test control.",
  declaredBy: [{ capability: CONSUMER_KIND, site: "unit.ts", usage: "consumes it" }],
}

function rules(declarations: readonly ExternalReferenceDeclaration[]): readonly string[] {
  return runExternalReferencesPass(CAPABILITY_DEFINITIONS, declarations)
    .diagnostics.map((d) => d.rule)
    .sort()
}

describe("external-references — the authored table", () => {
  it("compiles the REAL declaration table clean", () => {
    const result = runExternalReferencesPass(CAPABILITY_DEFINITIONS, EXTERNAL_REFERENCES)
    expect(result.diagnostics).toEqual([])
  })

  it("counts every declaration AND every consumer (the anti-vacuous measure)", () => {
    const consumers = EXTERNAL_REFERENCES.reduce((n, d) => n + d.declaredBy.length, 0)
    const result = runExternalReferencesPass(CAPABILITY_DEFINITIONS, EXTERNAL_REFERENCES)
    expect(result.checked).toBe(EXTERNAL_REFERENCES.length + consumers)
    // A table that empties out should report zero HONESTLY rather than have the
    // pass invent work; the guard against that is this number being visible on
    // one line of `ibx catalog check`, not the pass refusing to run.
    expect(result.checked).toBeGreaterThan(0)
  })

  it("declares no key VALUES — every reference is sourced from config", () => {
    // The load-bearing half of the catalog/config split: if a coupon code ever
    // reappears in this package, this test is the one that says so.
    for (const declaration of EXTERNAL_REFERENCES) {
      expect(Object.keys(declaration)).not.toContain("key")
      expect(declaration.keyFrom).toMatch(/^[A-Z][A-Z0-9_]*$/)
    }
  })

  it("names a known store for every declaration", () => {
    for (const declaration of EXTERNAL_REFERENCES) {
      expect(EXTERNAL_REFERENCE_STORES).toContain(declaration.store)
    }
  })

  it("gives every declaration at least one consumer with a real site", () => {
    for (const declaration of EXTERNAL_REFERENCES) {
      expect(declaration.declaredBy.length).toBeGreaterThan(0)
      for (const consumer of declaration.declaredBy) {
        expect(consumer.site).not.toBe("")
        expect(consumer.usage.length).toBeGreaterThan(10)
      }
    }
  })
})

describe("external-references — what `null` on a consumer means", () => {
  it("accepts a null capability (a subscriber or session helper is not a capability)", () => {
    expect(
      rules(
        table({
          ...WELL_FORMED,
          declaredBy: [{ capability: null, site: "subscriber.ts", usage: "announces it" }],
        }),
      ),
    ).toEqual([])
  })

  it("rejects a NAMED capability that the catalog does not define", () => {
    expect(
      rules(
        table({
          ...WELL_FORMED,
          declaredBy: [{ capability: "order.gone", site: "x.ts", usage: "u" }],
        }),
      ),
    ).toEqual(["external-reference-consumer-dangling"])
  })

  it("rejects an empty consumer list — a gate that names nobody names nothing", () => {
    expect(rules(table({ ...WELL_FORMED, declaredBy: [] }))).toEqual([
      "external-reference-no-consumer",
    ])
  })

  it("attributes the dangling consumer by INDEX, so a long list stays actionable", () => {
    const result = runExternalReferencesPass(
      CAPABILITY_DEFINITIONS,
      table({
        ...WELL_FORMED,
        declaredBy: [
          { capability: null, site: "a.ts", usage: "u" },
          { capability: "order.gone", site: "b.ts", usage: "u" },
        ],
      }),
    )
    expect(result.diagnostics[0]?.field).toBe("declaredBy[1].capability")
  })
})

describe("external-references — the config/catalog line", () => {
  it("accepts an UPPER_SNAKE_CASE variable name", () => {
    expect(rules(table({ ...WELL_FORMED, keyFrom: "A1_B2_C3" }))).toEqual([])
  })

  it("rejects a lower-cased or hyphenated name — nothing would ever set it", () => {
    for (const bad of ["welcome_code", "WELCOME-CODE", "1_LEADING_DIGIT", ""]) {
      expect(rules(table({ ...WELL_FORMED, keyFrom: bad })), bad).toEqual([
        "external-reference-malformed-key-source",
      ])
    }
  })

  it("CANNOT tell a coupon code from a variable name, and does not pretend to", () => {
    // `BEMVINDO15` is a legal env-var name by shape. The static pass therefore
    // passes it; the reconciler catches it when the variable turns out to be
    // unset. Documenting the seam here keeps a future reader from "fixing" the
    // regex into something that rejects legitimate names.
    expect(rules(table({ ...WELL_FORMED, keyFrom: "BEMVINDO15" }))).toEqual([])
  })
})

describe("external-references — identity and stores", () => {
  it("reports BOTH rows of a duplicate id (either one may be the wrong one)", () => {
    const result = runExternalReferencesPass(
      CAPABILITY_DEFINITIONS,
      table({ ...WELL_FORMED }, { ...WELL_FORMED, keyFrom: "OTHER_CODE" }),
    )
    expect(result.diagnostics).toHaveLength(2)
    expect(result.diagnostics.map((d) => d.object)).toEqual([
      "external-reference:promotion.unit",
      "external-reference:promotion.unit",
    ])
  })

  it("names a declaration by array position when its own id slot is unusable", () => {
    const result = runExternalReferencesPass(
      CAPABILITY_DEFINITIONS,
      table({ ...WELL_FORMED, id: "  ", declaredBy: [] }),
    )
    expect(result.diagnostics[0]?.object).toBe("external-reference:#0")
  })

  it("rejects every store the reconciler has no probe for", () => {
    expect(rules(table({ ...WELL_FORMED, store: "loyalty-ledger" }))).toEqual([
      "external-reference-unknown-store",
    ])
  })

  it("accepts every store the vocabulary declares", () => {
    for (const store of EXTERNAL_REFERENCE_STORES) {
      expect(rules(table({ ...WELL_FORMED, store })), store).toEqual([])
    }
  })
})

describe("external-references — layering", () => {
  it("is total: malformed junk becomes diagnostics, never a throw", () => {
    expect(() =>
      runExternalReferencesPass(
        CAPABILITY_DEFINITIONS,
        table({}, { id: 42, store: null, keyFrom: undefined, declaredBy: "nope" }, null),
      ),
    ).not.toThrow()
  })

  it("defaults to an EMPTY table, so a caller that passes nothing checks nothing", () => {
    // The inverse of `compileCatalog`'s default (which is the real table, on
    // purpose). At the pass level the safe default is emptiness: a pass is a
    // pure function of its arguments and must never reach for live data.
    expect(runExternalReferencesPass(CAPABILITY_DEFINITIONS).checked).toBe(0)
  })

  it("reads no environment variable — the same catalog compiles on every box", () => {
    process.env["UNIT_COUPON_CODE"] = "SET_TO_SOMETHING"
    const withVar = runExternalReferencesPass(CAPABILITY_DEFINITIONS, table(WELL_FORMED))
    delete process.env["UNIT_COUPON_CODE"]
    const withoutVar = runExternalReferencesPass(CAPABILITY_DEFINITIONS, table(WELL_FORMED))
    expect(withVar).toEqual(withoutVar)
  })
})
