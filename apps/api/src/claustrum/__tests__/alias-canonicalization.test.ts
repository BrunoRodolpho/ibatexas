// alias-canonicalization.test.ts — LE2-025b's pure core.
//
// The seam proofs (an aliased utterance and its canonical form sharing an L1 key
// and an L2 query; the CLARIFY turn making zero model calls; the customer never
// seeing a canonical handle) live at the turn seam in
// `apps/api/src/__tests__/alias-canonicalization.e2e.test.ts`. This file covers
// the resolution rules themselves, including the ones whose failure is silent.

import { describe, expect, it } from "vitest";
import { ALIAS_GAZETTEER } from "@ibatexas/catalog";
import {
  canonicalizeAliases,
  renderAliasClarify,
} from "../alias-canonicalization.js";

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
    expect(r.text).toContain(canonical);
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
  });
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
