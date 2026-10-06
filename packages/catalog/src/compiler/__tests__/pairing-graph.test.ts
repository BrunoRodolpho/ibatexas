// LE2-029 — the `pairing-graph` pass's LOGIC, asserted inline.
//
// The complement to the conformance suite: that corpus pins the diagnostic
// CONTRACT byte-for-byte over committed fixtures, this file states what each
// rule believes and why, in prose a reviewer can disagree with. Both are
// required — a golden diff proves something changed, these tests say what
// SHOULD be true.
//
// Every case here is DIRECTIONAL: each rejection is paired with the nearest
// legal neighbour that must compile silent. A rejection test on its own cannot
// distinguish "the rule fired for the right reason" from "the pass rejects
// everything", which is the vacuity class this program keeps finding.

import { describe, expect, it } from "vitest"

import { PAIRING_GRAPH, type PairingEdge } from "../../pairing-graph.js"
import { runPairingGraphPass } from "../passes/pairing-graph.js"

/** Widen hand-authored fixture objects — the pass exists to reject these. */
function edges(...objects: readonly unknown[]): readonly PairingEdge[] {
  return objects as readonly PairingEdge[]
}

/** A well-formed grounded edge; each case mutates exactly one slot. */
const BASE = {
  subject: "item-sujeito",
  relation: "pairs-with",
  object: "item-objeto",
  provenance: "menu-composition",
  why: "the control.",
} as const

/** The rule ids a graph emits, sorted — the assertion surface for every case. */
function rules(...objects: readonly unknown[]): readonly string[] {
  return [...new Set(runPairingGraphPass(edges(...objects)).diagnostics.map((d) => d.rule))].sort()
}

describe("the safety binding — the ticket's acceptance criterion", () => {
  it("rejects a dietary class on the ASKED-ABOUT end", () => {
    expect(rules({ ...BASE, subject: "sem-gluten" })).toEqual([
      "safety-restricted-pairing-subject",
    ])
  })

  it("rejects an allergen marker on the SUGGESTED end — the end the read speaks", () => {
    expect(rules({ ...BASE, object: "sem-lactose" })).toEqual([
      "safety-restricted-pairing-object",
    ])
  })

  it("rejects a dietary REASON, even though no renderer quotes `why` today", () => {
    expect(rules({ ...BASE, why: "combina porque e sem gluten." })).toEqual([
      "safety-restricted-pairing-rationale",
    ])
  })

  it("classifies safety BEFORE shape, so a marker is never masked by a typo", () => {
    // Both faults are present; only the safety one is reported. The inverse
    // ordering would let the most important diagnostic be buried by the least.
    const diagnostics = runPairingGraphPass(
      edges({ ...BASE, object: "Sem Gluten Em Caixa" }),
    ).diagnostics
    expect(diagnostics.map((d) => d.rule)).toEqual(["safety-restricted-pairing-object"])
  })

  it("names the marker and the ratified basis in the message", () => {
    const [diagnostic] = runPairingGraphPass(edges({ ...BASE, object: "sem-lactose" })).diagnostics
    expect(diagnostic?.message).toContain("lactose")
    expect(diagnostic?.message).toContain("BKL-143")
    expect(diagnostic?.reference).toBe("sem-lactose")
  })

  it("does NOT reject a product whose ALLERGENS are declared elsewhere — the graph is not allergen-aware", () => {
    // `coleslaw-da-casa` carries eggs and lactose in the seed's metadata. Its
    // HANDLE asserts nothing, so pairing it is legal: this pass governs what the
    // DATA ASSERTS, never what a product CONTAINS. A rule that read seed
    // metadata would be the allergen-awareness BKL-143 refused to build.
    expect(rules({ ...BASE, object: "coleslaw-da-casa" })).toEqual([])
  })
})

describe("shape", () => {
  it("rejects a handle that is not a kebab-case ASCII handle", () => {
    expect(rules({ ...BASE, object: "Item Objeto" })).toEqual(["malformed-pairing-handle"])
  })

  it("accepts the handle spellings the store actually uses", () => {
    expect(rules({ ...BASE, object: "costela-bovina-defumada" })).toEqual([])
  })

  it("rejects a relation outside the closed set", () => {
    expect(rules({ ...BASE, relation: "goes-nicely-with" })).toEqual([
      "unknown-pairing-relation",
    ])
  })

  it("accepts BOTH declared relations", () => {
    expect(rules({ ...BASE, relation: "substitutes-for" })).toEqual([])
    expect(rules({ ...BASE, relation: "pairs-with" })).toEqual([])
  })

  it("rejects a provenance tag that merely LOOKS grounded (the fail-open)", () => {
    // Without this rule an unrecognized tag would skip the review-flag rules
    // below, which branch on provenance — an invented pairing would ship
    // unflagged because of a typo.
    expect(rules({ ...BASE, provenance: "grounded" })).toEqual([
      "unknown-pairing-provenance",
    ])
  })

  it("rejects a rationale that says nothing", () => {
    expect(rules({ ...BASE, why: "   " })).toEqual(["malformed-pairing-rationale"])
  })
})

describe("internal coherence", () => {
  it("rejects a handle paired with itself", () => {
    expect(rules({ ...BASE, object: BASE.subject })).toEqual([
      "self-referential-pairing-edge",
    ])
  })

  it("rejects the same edge declared twice", () => {
    expect(rules({ ...BASE }, { ...BASE })).toEqual(["duplicate-pairing-edge"])
  })

  it("accepts two DIFFERENT edges out of one subject — the read renders a list", () => {
    expect(rules({ ...BASE }, { ...BASE, object: "item-alternativo" })).toEqual([])
  })

  it("rejects one pair related both ways, in EITHER direction", () => {
    // Keyed on the unordered pair: a rule that only caught the aligned spelling
    // would be evaded by swapping the ends, which changes nothing about the
    // contradiction the customer would hear.
    const reversed = {
      ...BASE,
      subject: BASE.object,
      object: BASE.subject,
      relation: "substitutes-for",
    }
    expect(rules({ ...BASE }, reversed)).toEqual(["contradictory-pairing-relations"])
    const aligned = { ...BASE, relation: "substitutes-for" }
    expect(rules({ ...BASE }, aligned)).toEqual(["contradictory-pairing-relations"])
  })

  it("accepts the two relations over DIFFERENT pairs", () => {
    expect(
      rules(
        { ...BASE },
        { ...BASE, subject: "item-terceiro", object: "item-quarto", relation: "substitutes-for" },
      ),
    ).toEqual([])
  })
})

describe("provenance and the owner-review flag", () => {
  it("rejects an authored edge with no review flag", () => {
    expect(rules({ ...BASE, provenance: "authored" })).toEqual([
      "unreviewed-authored-pairing",
    ])
  })

  it("accepts an authored edge that carries one", () => {
    expect(rules({ ...BASE, provenance: "authored", ownerReview: true })).toEqual([])
  })

  it("rejects a review flag on a menu-grounded edge", () => {
    expect(rules({ ...BASE, ownerReview: true })).toEqual([
      "unnecessary-pairing-review-flag",
    ])
  })
})

describe("`checked` — the anti-vacuous-gate signal", () => {
  it("counts the five authored slots of every edge, plus each review flag", () => {
    expect(runPairingGraphPass(edges({ ...BASE })).checked).toBe(5)
    expect(
      runPairingGraphPass(edges({ ...BASE, provenance: "authored", ownerReview: true })).checked,
    ).toBe(6)
  })

  it("is ZERO on an empty graph — which is what makes a zero readable as 'gone'", () => {
    expect(runPairingGraphPass([]).checked).toBe(0)
  })

  it("counts every edge of the REAL graph, so a green run is never a silent one", () => {
    const result = runPairingGraphPass(PAIRING_GRAPH)
    expect(result.checked).toBeGreaterThanOrEqual(PAIRING_GRAPH.length * 5)
  })
})

describe("the authored graph itself", () => {
  it("compiles clean", () => {
    expect(runPairingGraphPass(PAIRING_GRAPH).diagnostics).toEqual([])
  })

  it("flags every authored edge for owner review, and no grounded one", () => {
    // The compile-enforced invariant, restated as a countable fact for the
    // reviewer who has to work the queue.
    for (const edge of PAIRING_GRAPH) {
      expect(edge.ownerReview).toBe(edge.provenance === "authored" ? true : undefined)
    }
    expect(PAIRING_GRAPH.filter((e) => e.provenance === "menu-composition")).toHaveLength(4)
    expect(PAIRING_GRAPH.filter((e) => e.ownerReview === true)).toHaveLength(6)
  })

  it("names no product whose handle carries a safety marker", () => {
    // The standing consequence of the safety rules over the REAL table, pinned
    // so that adding `pudim-de-leite-condensado` fails here as well as in the
    // pass — two independent statements of one invariant.
    const handles = PAIRING_GRAPH.flatMap((e) => [e.subject, e.object])
    expect(handles).not.toContain("pudim-de-leite-condensado")
  })
})
