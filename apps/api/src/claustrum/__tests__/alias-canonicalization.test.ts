// alias-canonicalization.test.ts — LE2-025b's pure core.
//
// The seam proofs (an aliased utterance and its canonical form sharing an L1 key
// and an L2 query; the CLARIFY turn making zero model calls; the customer never
// seeing a canonical handle) live at the turn seam in
// `apps/api/src/__tests__/alias-canonicalization.e2e.test.ts`. This file covers
// the resolution rules themselves, including the ones whose failure is silent.

import { describe, expect, it, vi } from "vitest";
import { ALIAS_GAZETTEER, type AliasEdge } from "@ibatexas/catalog";
import {
  ALIAS_CANONICALIZATION_VERSION,
  canonicalizeAliases,
  renderAliasClarify,
} from "../alias-canonicalization.js";

/**
 * Run the canonicalizer against an AUTHORED gazetteer instead of the shipped one.
 *
 * F-2's rule is about "any surface + `disambiguatedBy` pair", and the seed table
 * holds exactly one such surface (`costela`). Proving the rule on that row alone
 * would leave "the fix is a costela special case" and "the fix is general"
 * indistinguishable — so the general cases below author their own edges: a
 * MULTI-WORD surface, a three-way ambiguity, a surface whose canonical handle does
 * NOT contain the disambiguator.
 *
 * The module builds its indexes at load, so each call needs a fresh module graph.
 */
async function underGazetteer(
  edges: readonly AliasEdge[],
  text: string,
): Promise<{
  text: string;
  resolutions: ReadonlyArray<Record<string, unknown>>;
  ambiguous: ReadonlyArray<{ surface: string }>;
}> {
  vi.resetModules();
  vi.doMock("@ibatexas/catalog", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@ibatexas/catalog")>()),
    ALIAS_GAZETTEER: edges,
  }));
  const mod = await import("../alias-canonicalization.js");
  const r = mod.canonicalizeAliases(text);
  vi.doUnmock("@ibatexas/catalog");
  return r as never;
}

const AUTHORED = (over: Partial<AliasEdge>): AliasEdge => ({
  surface: "x",
  canonical: "x-handle",
  provenance: "authored",
  why: "test fixture",
  ...over,
});

describe("unambiguous surfaces resolve deterministically", () => {
  it("rewrites a bare colloquial to its canonical handle", () => {
    const r = canonicalizeAliases("adiciona uma farofa ao carrinho");
    expect(r.text).toBe("adiciona uma farofa-de-bacon-defumado ao carrinho");
    expect(r.resolutions).toEqual([
      { surface: "farofa", canonical: "farofa-de-bacon-defumado" },
    ]);
    expect(r.ambiguous).toEqual([]);
  });

  it("is case- and accent-insensitive on the MATCH but preserves everything else", () => {
    // "linguiça" is declared; a customer who drops the cedilla still means it.
    const withCedilla = canonicalizeAliases("tira a linguiça do carrinho!");
    const without = canonicalizeAliases("tira a LINGUICA do carrinho!");
    expect(withCedilla.text).toBe("tira a linguica-artesanal-defumada do carrinho!");
    expect(without.text).toBe(withCedilla.text);
    // Punctuation and the rest of the sentence survive verbatim.
    expect(withCedilla.text.endsWith(" do carrinho!")).toBe(true);
  });

  it("resolves several surfaces in one utterance", () => {
    const r = canonicalizeAliases("quero um brisket e uma mandioca");
    expect(r.text).toBe("quero um brisket-americano e uma mandioca-frita");
    expect(r.resolutions.map((x) => x.canonical).sort()).toEqual([
      "brisket-americano",
      "mandioca-frita",
    ]);
  });

  it("matches whole word tokens only — never inside a longer word", () => {
    // "brisketeria" is not "brisket". A substring matcher would corrupt the text.
    const r = canonicalizeAliases("conheço a brisketeria da esquina");
    expect(r.text).toBe("conheço a brisketeria da esquina");
    expect(r.resolutions).toEqual([]);
  });
});

describe("the fail-safe: anything unmatched passes through BYTE-IDENTICAL", () => {
  it.each([
    "quero uma coca",
    "vocês entregam em Ibaté?",
    "Oi, bom dia!",
    "",
    "   ",
    "!!!",
  ])("leaves %p untouched", (text) => {
    const r = canonicalizeAliases(text);
    expect(r.text).toBe(text);
    expect(r.resolutions).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });

  it("a plain word with no alias edge is NOT 'unknown' — it just parses normally", () => {
    // The scoping that matters: "unknown" means declared-ambiguous-without-context,
    // NOT "a word the gazetteer has never heard of". Treating every unknown noun as
    // a clarify would make the assistant unusable.
    const r = canonicalizeAliases("quero um prato qualquer que não existe no cardápio");
    expect(r.ambiguous).toEqual([]);
    expect(r.text).toBe("quero um prato qualquer que não existe no cardápio");
  });
});

describe("ambiguity CLARIFIES — never a nearest neighbour", () => {
  // The seed's real case: the store sells two costelas at different prices and
  // different fulfilment, so the bare word is a coin flip the catalog forbids.
  it("a declared-ambiguous surface with no disambiguating token clarifies", () => {
    const r = canonicalizeAliases("tira a costela do meu carrinho");
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0]!.surface).toBe("costela");
    expect(r.ambiguous[0]!.candidates).toEqual([
      "costela-bovina-defumada",
      "costela-defumada-congelada",
    ]);
    // NOTHING was rewritten and NOTHING was resolved — a half-canonicalized text
    // must never reach a parse.
    expect(r.text).toBe("tira a costela do meu carrinho");
    expect(r.resolutions).toEqual([]);
  });

  it.each([
    ["bovina", "costela-bovina-defumada"],
    ["congelada", "costela-defumada-congelada"],
  ])("resolves when the utterance carries the %s token", (token, canonical) => {
    const r = canonicalizeAliases(`muda a costela ${token} para 3 unidades`);
    expect(r.ambiguous).toEqual([]);
    expect(r.resolutions[0]).toMatchObject({ canonical, disambiguatedBy: token });
    // F-2 — the EXACT text, not `toContain`. `toContain(canonical)` was true of the
    // warted output too ("costela-bovina-defumada bovina" contains the handle), so
    // it could never have caught the duplicated modifier. This is the assertion the
    // defect walked through.
    expect(r.text).toBe(`muda a costela-bovina-defumada para 3 unidades`.replace(
      "costela-bovina-defumada",
      canonical,
    ));
    expect(r.resolutions[0]).toMatchObject({ disambiguatorConsumed: true });
  });

  it("clarifies when BOTH disambiguators appear — two answers is as unanswerable as none", () => {
    const r = canonicalizeAliases("tenho a costela bovina e a congelada, tira uma");
    expect(r.ambiguous).toHaveLength(1);
    expect(r.resolutions).toEqual([]);
  });

  it("the disambiguating token is matched accent- and case-folded too", () => {
    const r = canonicalizeAliases("quero a COSTELA Bovina");
    expect(r.ambiguous).toEqual([]);
    expect(r.resolutions[0]?.canonical).toBe("costela-bovina-defumada");
    // F-2 — the fold decides CONSUMPTION as well as selection: an upper-case
    // "Bovina" is the same spent token as a lower-case one.
    expect(r.text).toBe("quero a costela-bovina-defumada");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// F-2 — THE REWRITE CONSUMES ITS DISAMBIGUATOR
// ═══════════════════════════════════════════════════════════════════════════════
//
// The recorded defect, measured live in production during R1-S2:
//   "combina com a costela bovina" -> "a costela-bovina-defumada bovina"
// The token that SELECTED the reading survived into the rewritten text, and the
// rewritten text is what the parser sees.

describe("F-2 — a consumed disambiguator is spliced out, not left behind", () => {
  it("THE RECORDED DEFECT: the production utterance canonicalizes clean", () => {
    const r = canonicalizeAliases("o que combina com a costela bovina?");
    expect(r.text).toBe("o que combina com a costela-bovina-defumada?");
    // The exact warted string this replaced, named so a regression is unmistakable.
    expect(r.text).not.toBe("o que combina com a costela-bovina-defumada bovina?");
  });

  it("the modifier is gone from the text but still ANSWERS 'why this reading'", () => {
    const r = canonicalizeAliases("quanto custa a costela bovina?");
    expect(r.text).toBe("quanto custa a costela-bovina-defumada?");
    expect(r.resolutions).toEqual([
      {
        surface: "costela",
        canonical: "costela-bovina-defumada",
        disambiguatedBy: "bovina",
        disambiguatorConsumed: true,
      },
    ]);
  });

  it("`surface` stays the ALIAS SURFACE — the trace names the edge that fired", () => {
    // Not "costela bovina". The gazetteer is keyed on the surface, and widening
    // this field would stop it answering which row resolved the word.
    expect(canonicalizeAliases("tira a costela congelada").resolutions[0]?.surface).toBe(
      "costela",
    );
  });

  it("consumes a PRECEDING disambiguator too — the rule is adjacency, not word order", async () => {
    const r = await underGazetteer(
      [
        AUTHORED({ surface: "pao", canonical: "pao-de-alho", disambiguatedBy: "alho" }),
        AUTHORED({ surface: "pao", canonical: "pao-de-queijo", disambiguatedBy: "queijo" }),
      ],
      "quero o alho pao",
    );
    expect(r.text).toBe("quero o pao-de-alho");
  });

  it("a NON-ADJACENT disambiguator still SELECTS and is deliberately LEFT IN PLACE", () => {
    // The bounded residual, and the reason the rule is scoped to adjacency: here
    // "bovina" belongs to a different phrase four tokens away, and splicing it out
    // would corrupt a sentence this layer exists to keep faithful. It is reported
    // as un-consumed rather than silently cleaned OR silently ignored.
    const r = canonicalizeAliases("Costela Defumada: Costela bovina defumada 12h.");
    expect(r.text).toBe("costela-bovina-defumada Defumada: Costela bovina defumada 12h.");
    expect(r.resolutions[0]).toMatchObject({ disambiguatedBy: "bovina" });
    expect(r.resolutions[0]).not.toHaveProperty("disambiguatorConsumed");
  });

  it("never steals a token another surface or a canonical handle already owns", async () => {
    // "queijo" is BOTH `pao`'s disambiguator and a surface in its own right. It is
    // consumed by whichever claims it first and can never be spliced twice, which
    // is what would produce overlapping rewrite spans and a corrupted splice.
    const r = await underGazetteer(
      [
        AUTHORED({ surface: "pao", canonical: "pao-de-alho", disambiguatedBy: "alho" }),
        AUTHORED({ surface: "pao", canonical: "pao-de-queijo", disambiguatedBy: "queijo" }),
        AUTHORED({ surface: "queijo", canonical: "queijo-coalho" }),
      ],
      "quero pao queijo",
    );
    // Longest-first index order puts the single-token surfaces in gazetteer order;
    // whichever wins, the output is a well-formed splice with no duplicated token.
    expect(r.text).not.toContain("queijo queijo");
    expect(r.text.split(/\s+/).filter((w) => w === "queijo")).toHaveLength(0);
  });

  it("works for a MULTI-WORD surface — the span is the hull, not a fixed offset", async () => {
    const r = await underGazetteer(
      [
        AUTHORED({
          surface: "calabresa americana",
          canonical: "calabresa-americana-em-fatias",
          disambiguatedBy: "fatiada",
        }),
        AUTHORED({
          surface: "calabresa americana",
          canonical: "calabresa-americana-inteira",
          disambiguatedBy: "inteira",
        }),
      ],
      "poe uma calabresa americana fatiada no carrinho",
    );
    expect(r.text).toBe("poe uma calabresa-americana-em-fatias no carrinho");
  });

  it("DOES NOT fire when the idempotence pre-pass already owns the span", () => {
    // The boundary, pinned because it is easy to mistake for a miss: a customer who
    // writes the product's full pt-BR name has written the canonical handle in its
    // SPACED spelling, the pre-pass consumes all three tokens as terminal, and no
    // alias edge — and so no F-2 consumption — ever runs. `pairing-resolver.ts`
    // depends on exactly this, which is why it matches the spaced form too.
    const r = canonicalizeAliases("o que combina com a costela bovina defumada?");
    expect(r.text).toBe("o que combina com a costela bovina defumada?");
    expect(r.resolutions).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });

  it("works when the canonical handle does NOT contain the disambiguator", async () => {
    // The fix must not be "the handle already says it, so drop it" — it is "the
    // token was SPENT selecting". A handle that spells the reading differently is
    // the case that tells those two rules apart.
    const r = await underGazetteer(
      [
        AUTHORED({ surface: "costela", canonical: "prod-4471", disambiguatedBy: "bovina" }),
        AUTHORED({ surface: "costela", canonical: "prod-9902", disambiguatedBy: "congelada" }),
      ],
      "quero a costela bovina",
    );
    expect(r.text).toBe("quero a prod-4471");
  });

  it("stays IDEMPOTENT: canonicalizing the fixed output is byte-identical", () => {
    const once = canonicalizeAliases("quanto custa a costela bovina?").text;
    const twice = canonicalizeAliases(once);
    expect(twice.text).toBe(once);
    expect(twice.resolutions).toEqual([]);
  });

  it("THE GENERAL RULE, over every ambiguous pair the shipped gazetteer declares", () => {
    // ROLL CALL, HAND-WRITTEN. Deriving this list from the gazetteer would make a
    // deleted row delete its own coverage silently; the equality pin below is what
    // forces a new ambiguous surface to be considered here rather than skipped.
    const DECLARED_AMBIGUOUS_PAIRS = [
      { surface: "costela", disambiguatedBy: "bovina", canonical: "costela-bovina-defumada" },
      { surface: "costela", disambiguatedBy: "congelada", canonical: "costela-defumada-congelada" },
    ] as const;

    const bySurface = new Map<string, number>();
    for (const e of ALIAS_GAZETTEER) bySurface.set(e.surface, (bySurface.get(e.surface) ?? 0) + 1);
    const live = ALIAS_GAZETTEER.filter((e) => (bySurface.get(e.surface) ?? 0) > 1).map((e) => ({
      surface: e.surface,
      disambiguatedBy: e.disambiguatedBy,
      canonical: e.canonical,
    }));
    // NAMES, not a count — a swapped row would satisfy a count.
    expect(live).toEqual([...DECLARED_AMBIGUOUS_PAIRS]);

    for (const pair of DECLARED_AMBIGUOUS_PAIRS) {
      const r = canonicalizeAliases(`quero ${pair.surface} ${pair.disambiguatedBy} hoje`);
      expect(r.text).toBe(`quero ${pair.canonical} hoje`);
      expect(r.ambiguous).toEqual([]);
    }
  });
});

describe("F-2 — the rewrite revision is DECLARED, and the L1 key digests it", () => {
  it("is a positive integer the bump discipline can move", () => {
    expect(Number.isInteger(ALIAS_CANONICALIZATION_VERSION)).toBe(true);
    expect(ALIAS_CANONICALIZATION_VERSION).toBeGreaterThanOrEqual(2);
  });

  // That it PARTICIPATES in the parse-cache key is proven where the key is built:
  // `parse-memo-catalog-version.test.ts`, alongside the CATALOG_VERSION case it
  // mirrors. Asserting it here would only re-state the import.
});

describe("the clarify question", () => {
  it("voices the customer's word and the disambiguating tokens, not the internal handles", () => {
    const r = canonicalizeAliases("tira a costela do meu carrinho");
    const q = renderAliasClarify(r.ambiguous);
    expect(q).toContain("costela");
    expect(q).toContain("bovina");
    expect(q).toContain("congelada");
    // Internal ids must never be spoken to a customer.
    expect(q).not.toContain("costela-bovina-defumada");
    expect(q).not.toContain("-");
  });

  it("asserts nothing about the store — it asks about the sentence", () => {
    const q = renderAliasClarify(canonicalizeAliases("tira a costela").ambiguous);
    // No price, no stock, no availability claim: safe without the claims gate.
    expect(q).not.toMatch(/R\$|preço|estoque|dispon/i);
  });
});

describe("the safety invariant, mirrored at runtime (defense in depth)", () => {
  it("the gazetteer carries no allergen or dietary surface — and so none can be canonicalized", () => {
    // LE2-025a's compile pass REJECTS a safety-bearing alias edge, so this can only
    // fail if that gate regresses. Asserting it here too means the runtime never
    // silently starts rewriting a health-relevant word even if the gate is weakened
    // (BKL-143 / BKL-123 / BKL-171 — the ratified conservative policy).
    const SAFETY_WORDS = [
      "gluten",
      "glúten",
      "lactose",
      "amendoim",
      "vegano",
      "vegetariano",
      "alergia",
      "alérgico",
      "celíaco",
      "diabético",
    ];
    for (const edge of ALIAS_GAZETTEER) {
      for (const word of SAFETY_WORDS) {
        expect(edge.surface.toLowerCase()).not.toContain(word.toLowerCase());
        expect(edge.canonical.toLowerCase()).not.toContain(word.toLowerCase());
      }
    }
  });

  it("a safety-marker utterance is passed through untouched", () => {
    const text = "sou alérgico a amendoim, tem farofa sem amendoim?";
    const r = canonicalizeAliases(text);
    // "farofa" IS an alias, so it resolves — but nothing in the allergen span is
    // rewritten, and the safety words survive verbatim for the §O#9 router.
    expect(r.text).toContain("alérgico a amendoim");
    expect(r.text).toContain("sem amendoim");
  });
});
