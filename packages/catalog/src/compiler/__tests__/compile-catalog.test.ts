// LE2-016 — the compiler entry point: registration, determinism, fail-closed
// behavior, and the v0 gate's absorption.

import { describe, expect, it } from "vitest"

import { CAPABILITY_DEFINITIONS } from "../../capability-definitions/definitions.js"
import type { AliasEdge } from "../../alias-gazetteer.js"
import type { CapabilityDefinition } from "../../capability-definitions/types.js"
import {
  assertClaimReferencesResolve,
  CatalogCrossReferenceError,
  findClaimReferenceDanglers,
} from "../../build-gates/check-claim-references.js"
import { CATALOG_VERSION } from "../../version.js"
import {
  assertCatalogCompiles,
  CATALOG_PASS_IDS,
  CATALOG_PASSES,
  CatalogCompileError,
  compileCatalog,
  formatCatalogReport,
  type CatalogCompileResult,
} from "../index.js"

/**
 * A catalog that violates EVERY registered pass at once.
 *
 * The name is the assertion: the "runs every pass" test below compares the
 * emitting-pass set to `CATALOG_PASS_IDS` itself, so a pass added without a
 * corresponding fault here turns that test red rather than letting the new
 * pass sit unexercised. (`external-references` is tripped without a line of
 * its own — `compileCatalog` defaults that table to the REAL authored
 * declarations, whose consumers name capability kinds this one-object catalog
 * does not contain.)
 *
 * The alias half lives in {@link BROKEN_ALIASES} rather than here, because the
 * gazetteer is a separate table and its default is the opposite of the
 * external-reference one: the REAL gazetteer is clean, and must stay clean, so
 * a fault has to be supplied explicitly. {@link compileEverythingBroken} is
 * the pairing.
 */
const EVERY_PASS_BROKEN: readonly CapabilityDefinition[] = [
  {
    kind: "order.ghost",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "chat",
    surfaces: ["chat"],
    auth: "guest",
    legacyNames: ["ghost"],
    description: "Fixture.",
    // referential: a claim id nothing defines
    // safety:      an allergen edge
    successClaimLinks: ["no-such-claim", "MENU_ITEM_ALLERGENS"],
    // slot:        a slot the contract has never heard of
    refusalCodes: "order.default.deny",
    // conversation-projection: below the per-capability floor (LE2-033)
    conversationTriggers: ["quero o pedido fantasma"],
    // terminal:    a chain with no floor
    guardRefs: [{ phase: "business", name: "executeW5Kinds" }],
  },
] as unknown as readonly CapabilityDefinition[]

/** The alias-gazetteer half of {@link EVERY_PASS_BROKEN} — an allergen edge. */
const BROKEN_ALIASES = [
  {
    surface: "apelido fantasma",
    canonical: "conformance-sem-gluten",
    provenance: "authored",
    why: "fixture.",
  },
] as unknown as readonly AliasEdge[]

/** Both halves of the broken catalog, compiled together. */
function compileEverythingBroken(
  definitions: readonly CapabilityDefinition[] = EVERY_PASS_BROKEN,
  aliases: readonly AliasEdge[] = BROKEN_ALIASES,
): CatalogCompileResult {
  // `undefined` keeps the REAL external-reference table, which is what trips
  // that pass — see EVERY_PASS_BROKEN's doc.
  return compileCatalog(definitions, undefined, aliases)
}

describe("compileCatalog — registration and reporting", () => {
  it("registers exactly the declared passes, in declared order", () => {
    expect(CATALOG_PASSES.map((p) => p.id)).toEqual([...CATALOG_PASS_IDS])
  })

  it("reports the catalog version and capability count it compiled", () => {
    const result = compileCatalog(CAPABILITY_DEFINITIONS)
    expect(result.catalogVersion).toBe(CATALOG_VERSION)
    expect(result.capabilities).toBe(CAPABILITY_DEFINITIONS.length)
  })

  it("runs EVERY pass even after one rejects — fail-closed is the exit code, not the silence", () => {
    const result = compileEverythingBroken()
    expect(result.ok).toBe(false)
    expect(result.passes).toHaveLength(CATALOG_PASS_IDS.length)
    expect(new Set(result.diagnostics.map((d) => d.pass))).toEqual(
      new Set(CATALOG_PASS_IDS),
    )
  })

  it("emits diagnostics in a STABLE total order (the golden-gate prerequisite)", () => {
    const once = compileEverythingBroken().diagnostics
    const twice = compileEverythingBroken(
      [...EVERY_PASS_BROKEN],
      [...BROKEN_ALIASES],
    ).diagnostics
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
    // Pass order first, then object/field within a pass.
    const passOrder = once.map((d) => CATALOG_PASS_IDS.indexOf(d.pass))
    expect([...passOrder].sort((a, b) => a - b)).toEqual(passOrder)
  })

  it("names object, slot and rule in every diagnostic (ticket AC3)", () => {
    for (const d of compileEverythingBroken().diagnostics) {
      expect(d.object).not.toBe("")
      expect(d.field).not.toBe("")
      expect(d.rule).not.toBe("")
      expect(d.severity).toBe("error")
    }
  })
})

describe("assertCatalogCompiles — fail-closed", () => {
  it("throws a CatalogCompileError carrying the full result", () => {
    expect(() => assertCatalogCompiles(EVERY_PASS_BROKEN)).toThrow(CatalogCompileError)
    try {
      assertCatalogCompiles(EVERY_PASS_BROKEN)
    } catch (err) {
      expect(err).toBeInstanceOf(CatalogCompileError)
      expect((err as CatalogCompileError).result.ok).toBe(false)
      expect((err as CatalogCompileError).message).toContain("catalog check FAILED")
    }
  })

  it("returns the clean result — with non-zero `checked` on every pass", () => {
    const result = assertCatalogCompiles(CAPABILITY_DEFINITIONS)
    expect(result.ok).toBe(true)
    for (const pass of result.passes) expect(pass.checked).toBeGreaterThan(0)
  })

  it("formats a clean report that names every pass", () => {
    const report = formatCatalogReport(compileCatalog(CAPABILITY_DEFINITIONS))
    expect(report).toContain("catalog check OK")
    for (const id of CATALOG_PASS_IDS) expect(report).toContain(id)
  })
})

describe("the cross-reference check v0 is ABSORBED, not weakened", () => {
  it("keeps its exact v0 API shape over the compiler's shared edge table", () => {
    const withDangler: readonly CapabilityDefinition[] = [
      {
        kind: "order.cancel",
        pack: "ibatexas/pack-orders",
        mutating: true,
        tier: "identity",
        successClaimLinks: ["order-canceled", "order-nuked"],
      } as CapabilityDefinition,
    ]
    expect(findClaimReferenceDanglers(withDangler)).toEqual([
      {
        kind: "order.cancel",
        field: "successClaimLinks",
        reference: "order-nuked",
        vocabulary: "CLAIM_CLASS_REFERENCES",
      },
    ])
    expect(() => assertClaimReferencesResolve(withDangler)).toThrow(
      CatalogCrossReferenceError,
    )
  })

  it("still counts the references it checked on the real catalog", () => {
    expect(assertClaimReferencesResolve(CAPABILITY_DEFINITIONS)).toBeGreaterThan(20)
  })

  it("reports the same fault as a referential-integrity diagnostic", () => {
    const result = compileCatalog([
      {
        kind: "order.cancel",
        pack: "ibatexas/pack-orders",
        mutating: true,
        tier: "identity",
        successClaimLinks: ["order-nuked"],
      } as CapabilityDefinition,
    ])
    expect(
      result.diagnostics.some(
        (d) => d.rule === "claim-reference-dangling" && d.reference === "order-nuked",
      ),
    ).toBe(true)
  })
})

describe("the REAL catalog compiles clean (the control for every pass)", () => {
  it("has zero diagnostics", () => {
    const result = compileCatalog(CAPABILITY_DEFINITIONS)
    expect(formatCatalogReport(result)).toContain("catalog check OK")
    expect(result.diagnostics).toEqual([])
  })
})
