// LE2-025a — the alias-gazetteer pass's LOGIC.
//
// The conformance corpus pins this pass's DIAGNOSTIC CONTRACT byte-for-byte
// (`src/conformance/`); this file asserts the rules themselves, including the
// boundaries a golden cannot express: folded equality vs byte equality, the
// fail-closed ORDER of the checks, the safety matcher's deliberate false
// positive, and the real gazetteer as the control.

import { describe, expect, it } from "vitest"

import { ALIAS_GAZETTEER, normalizeAliasSurface, type AliasEdge } from "../../alias-gazetteer.js"
import { runAliasGazetteerPass } from "../passes/alias-gazetteer.js"

/** A well-formed edge; every fixture below changes exactly one slot. */
function edge(overrides: Record<string, unknown> = {}): AliasEdge {
  return {
    surface: "apelido",
    canonical: "entidade-canonica",
    provenance: "authored",
    why: "fixture.",
    ...overrides,
  } as unknown as AliasEdge
}

function rules(aliases: readonly AliasEdge[]): string[] {
  return runAliasGazetteerPass(aliases).diagnostics.map((d) => d.rule)
}

describe("alias-gazetteer — the real gazetteer is the control", () => {
  it("compiles the authored table clean", () => {
    expect(runAliasGazetteerPass(ALIAS_GAZETTEER).diagnostics).toEqual([])
  })

  it("actually looked at it (the anti-vacuous-gate signal)", () => {
    const declaredTokens = ALIAS_GAZETTEER.filter(
      (a) => a.disambiguatedBy !== undefined,
    ).length
    expect(runAliasGazetteerPass(ALIAS_GAZETTEER).checked).toBe(
      ALIAS_GAZETTEER.length * 2 + declaredTokens,
    )
    expect(runAliasGazetteerPass(ALIAS_GAZETTEER).checked).toBeGreaterThan(0)
  })

  it("reports checked: 0 on an EMPTY gazetteer rather than pretending to have looked", () => {
    expect(runAliasGazetteerPass([]).checked).toBe(0)
  })

  it("carries at least one genuinely ambiguous surface, declared correctly", () => {
    // The seed's `costela` pair is what proves the ambiguity rule's POSITIVE
    // path is reachable on real data — a rule only ever seen rejecting is a
    // rule nobody has shown can be satisfied.
    const byNormal = new Map<string, number>()
    for (const alias of ALIAS_GAZETTEER) {
      const key = normalizeAliasSurface(alias.surface)
      byNormal.set(key, (byNormal.get(key) ?? 0) + 1)
    }
    const ambiguous = [...byNormal.entries()].filter(([, n]) => n > 1)
    expect(ambiguous.length).toBeGreaterThan(0)
    for (const [surface] of ambiguous) {
      for (const alias of ALIAS_GAZETTEER.filter(
        (a) => normalizeAliasSurface(a.surface) === surface,
      )) {
        expect(alias.disambiguatedBy, `${surface} reading is undeclared`).toBeDefined()
      }
    }
  })
})

describe("alias-gazetteer — ambiguity", () => {
  it("accepts one surface form naming one entity", () => {
    expect(rules([edge()])).toEqual([])
  })

  it("REJECTS one surface form naming two entities with no disambiguation", () => {
    const diagnostics = runAliasGazetteerPass([
      edge(),
      edge({ canonical: "entidade-alternativa" }),
    ]).diagnostics
    // Both readings are reported: each is separately fixable, and a diagnostic
    // on only one would imply the other is the right answer.
    expect(diagnostics.map((d) => d.rule)).toEqual([
      "ambiguous-alias-surface",
      "ambiguous-alias-surface",
    ])
    expect(diagnostics[0]).toMatchObject({
      pass: "alias-gazetteer",
      field: "surface",
      object: "alias:apelido",
    })
    // The message names the competing entities, so the pair is reconstructable
    // from one line of a build log.
    expect(diagnostics[0]?.message).toContain("entidade-alternativa")
    expect(diagnostics[0]?.message).toContain("entidade-canonica")
  })

  it("ACCEPTS the same pair once each reading declares a distinct token", () => {
    expect(
      rules([
        edge({ disambiguatedBy: "bovina" }),
        edge({ canonical: "entidade-alternativa", disambiguatedBy: "congelada" }),
      ]),
    ).toEqual([])
  })

  it("compares surface forms by NORMAL FORM, not bytes", () => {
    // "Apelido!" and "apelido" are one surface form, so this is ambiguous.
    expect(
      rules([edge(), edge({ surface: "Apelido!", canonical: "entidade-alternativa" })]),
    ).toEqual(["ambiguous-alias-surface", "ambiguous-alias-surface"])
  })

  it("treats a BLANK disambiguation as absent, not as a second fault", () => {
    // Fail-closed: an empty token must route into the ambiguity rule (which
    // demands a real one) rather than quietly satisfying it.
    expect(
      rules([
        edge({ disambiguatedBy: "   " }),
        edge({ canonical: "entidade-alternativa", disambiguatedBy: "congelada" }),
      ]),
    ).toEqual(["ambiguous-alias-surface"])
  })

  it("REJECTS a disambiguation both readings claim", () => {
    const [d] = runAliasGazetteerPass([
      edge({ disambiguatedBy: "grande" }),
      edge({ canonical: "entidade-alternativa", disambiguatedBy: "Grande!" }),
    ]).diagnostics
    expect(d).toMatchObject({
      rule: "colliding-alias-disambiguation",
      field: "disambiguatedBy",
    })
  })

  it("REJECTS a disambiguation on a surface form that names one entity", () => {
    const [d] = runAliasGazetteerPass([edge({ disambiguatedBy: "bovina" })]).diagnostics
    expect(d).toMatchObject({
      rule: "unnecessary-alias-disambiguation",
      field: "disambiguatedBy",
    })
  })

  it("REJECTS the same edge declared twice, and does NOT call it ambiguous", () => {
    expect(rules([edge(), edge({ surface: "APELIDO" })])).toEqual(["duplicate-alias-edge"])
  })
})

describe("alias-gazetteer — shape", () => {
  it.each([
    [" apelido", "leading or trailing whitespace"],
    ["apelido ", "leading or trailing whitespace"],
    ["ape  lido", "run of consecutive whitespace"],
    ["!!!", "no letter or digit"],
  ])("REJECTS the surface form %j", (surface, because) => {
    const [d] = runAliasGazetteerPass([edge({ surface })]).diagnostics
    expect(d?.rule).toBe("malformed-alias-surface")
    expect(d?.message).toContain(because)
  })

  it.each([
    "Entidade Canonica",
    "entidade_canonica",
    "entidade-canônica",
    "-entidade",
    "entidade--canonica",
    "",
  ])("REJECTS the canonical name %j", (canonical) => {
    expect(rules([edge({ canonical })])).toEqual(["malformed-alias-canonical"])
  })

  it("accepts digits inside a handle", () => {
    expect(rules([edge({ canonical: "combo-2-pessoas" })])).toEqual([])
  })

  it("survives a non-object row without taking the whole report down", () => {
    const diagnostics = runAliasGazetteerPass([null as unknown as AliasEdge]).diagnostics
    expect(diagnostics.map((d) => d.rule)).toEqual([
      "malformed-alias-surface",
      "malformed-alias-canonical",
    ])
    // A row with no usable surface is still findable by array position.
    expect(diagnostics[0]?.object).toBe("alias:#0")
  })
})

describe("alias-gazetteer — the safety binding (BKL-143 / BKL-123 / BKL-171)", () => {
  it.each([
    "sem-gluten",
    "gluten-free",
    "menu-item-allergens",
    "produtos-sem-lactose",
    "contem-amendoim",
  ])("REJECTS the canonical target %j", (canonical) => {
    expect(rules([edge({ canonical })])).toEqual(["safety-restricted-alias-target"])
  })

  it.each(["sem glúten", "sem lactose", "alérgenos", "tem amendoim"])(
    "REJECTS the surface form %j",
    (surface) => {
      const [d] = runAliasGazetteerPass([edge({ surface })]).diagnostics
      expect(d).toMatchObject({
        rule: "safety-restricted-alias-surface",
        field: "surface",
      })
    },
  )

  it("REJECTS a safety marker hiding in the DISAMBIGUATING token", () => {
    // The token is a word the customer must say for the reading to apply, so
    // it is the same end of the edge as the surface form.
    const [d] = runAliasGazetteerPass([
      edge({ disambiguatedBy: "sem lactose" }),
      edge({ canonical: "entidade-alternativa", disambiguatedBy: "comum" }),
    ]).diagnostics
    expect(d).toMatchObject({
      rule: "safety-restricted-alias-surface",
      field: "disambiguatedBy",
    })
  })

  it("classifies SAFETY BEFORE shape, so a bad spelling cannot mask an allergen", () => {
    // Both faults are present; only the safety one is reported. The reverse
    // order would let the most important diagnostic be buried by the least.
    expect(rules([edge({ surface: "  sem   glúten  " })])).toEqual([
      "safety-restricted-alias-surface",
    ])
  })

  it("folds accents and case before matching, like the runtime's own matcher", () => {
    // Also a second witness for the check order: this target is malformed as a
    // handle too, and only the safety rule is reported.
    expect(rules([edge({ canonical: "SEM-GLÚTEN" })])).toEqual([
      "safety-restricted-alias-target",
    ])
  })

  it("fires on a product handle that merely CONTAINS an ingredient word", () => {
    // The documented deliberate false positive. `pudim-de-leite-condensado` is
    // an ordinary dessert in the seed catalog and is unaliasable by this pass;
    // the pass module says why that is the right direction to be wrong in.
    expect(rules([edge({ canonical: "pudim-de-leite-condensado" })])).toEqual([
      "safety-restricted-alias-target",
    ])
  })

  it("leaves every canonical name the real gazetteer uses alone", () => {
    for (const alias of ALIAS_GAZETTEER) {
      expect(rules([edge({ canonical: alias.canonical })]), alias.canonical).toEqual([])
    }
  })
})
