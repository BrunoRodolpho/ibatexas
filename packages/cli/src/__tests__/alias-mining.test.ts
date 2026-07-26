// Tests for the LE2-026 alias-mining loop's pure core.
//
// Every case below is grounded in a real utterance from the dev stack's
// `claustrum_memory_episodic` store, and several are REGRESSIONS for mistakes
// the first live run actually made. Those are marked as such — they are the
// reason the thresholds and lexicons are what they are, and a future edit that
// "simplifies" one of them should fail here rather than in a report an owner
// acts on.
//
// No IO: `sources.ts` is not imported. These are pure functions over fixtures.

import { describe, it, expect } from "vitest"
import {
  extractRequestObjects,
  mentionsFrom,
  labelledMention,
  displayFormOf,
  type CandidateMention,
} from "../lib/alias-mining/extract.js"
import {
  classifyAll,
  classifyCandidate,
  type KnownAlias,
  type Roster,
} from "../lib/alias-mining/classify.js"
import { cosineSimilarity, rankCandidates } from "../lib/alias-mining/rank.js"
import { renderReport, scrubUtterance, type ReportContext } from "../lib/alias-mining/report.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A slice of the LIVE roster, copied from the dev store. */
const ROSTER: Roster = {
  products: [
    { handle: "refrigerante", title: "Refrigerante", variantTitles: ["Coca-Cola", "Guaraná Antarctica"] },
    { handle: "costela-bovina-defumada", title: "Costela Bovina Defumada", variantTitles: [] },
    { handle: "costela-defumada-congelada", title: "Costela Defumada Congelada", variantTitles: [] },
    { handle: "farofa-de-bacon-defumado", title: "Farofa de Bacon Defumado", variantTitles: [] },
    { handle: "brisket-americano", title: "Brisket Americano", variantTitles: [] },
    { handle: "pudim-de-leite-condensado", title: "Pudim de Leite Condensado", variantTitles: [] },
  ],
  categories: [
    { handle: "bebidas", name: "Bebidas" },
    { handle: "sobremesas", name: "Sobremesas" },
  ],
}

const GAZETTEER: readonly KnownAlias[] = [
  { surface: "farofa", canonical: "farofa-de-bacon-defumado" },
  { surface: "brisket", canonical: "brisket-americano" },
]

/** Build mentions for one surface without going through the extractor. */
function mention(
  surface: string,
  utterance: string,
  over: Partial<CandidateMention> = {},
): CandidateMention {
  return { surface, display: surface, utterance, source: "transcript", quantified: true, ...over }
}

const surfaces = (u: string): readonly string[] =>
  extractRequestObjects(u).map((r) => r.surface)

// ── Extraction ───────────────────────────────────────────────────────────────

describe("extractRequestObjects", () => {
  it("reads the object of a request verb", () => {
    expect(surfaces("quero uma coca")).toContain("coca")
    expect(surfaces("põe mais um refrigerante no meu pedido")).toContain("refrigerante")
  })

  it("stops the phrase at a preposition", () => {
    // "tira a Mandioca Frita DO meu pedido" must not yield "mandioca frita do".
    expect(surfaces("tira a Mandioca Frita do meu pedido")).toContain("mandioca frita")
    expect(surfaces("tira a Mandioca Frita do meu pedido")).not.toContain("mandioca frita do")
  })

  it("emits the head word alongside a multi-word phrase", () => {
    const got = surfaces("adiciona uma coca cola no meu pedido")
    expect(got).toContain("coca cola")
    expect(got).toContain("coca")
  })

  it("REGRESSION: 'de' is a preposition, never a verb", () => {
    // The first live run read folded "dê" as a request verb, so every product
    // name containing "de" emitted its own tail: "Farofa de Bacon Defumado"
    // produced `bacon`, and it was then ranked as a propose-alias row with
    // 12 utterances of evidence.
    const got = surfaces("adiciona duas Farofas de Bacon e tres Refrigerantes no carrinho")
    expect(got).toContain("farofas")
    expect(got).not.toContain("bacon")
  })

  it("REGRESSION: clause punctuation ends a phrase", () => {
    // Folding turns "." into a space, so without splitting first this produced
    // the candidate `brisket americano fecha`.
    const got = surfaces("quero um Brisket Americano. fecha o pedido")
    expect(got).toContain("brisket americano")
    expect(got.some((s) => s.includes("fecha"))).toBe(false)
  })

  it("REGRESSION: a pronoun contraction ends a phrase", () => {
    const got = surfaces("adiciona uma coca-cola nele por favor")
    expect(got).toContain("coca cola")
    expect(got).not.toContain("coca cola nele")
  })

  it("REGRESSION: 'tem' is existential only when it opens the question", () => {
    // "do you have picanha" is a product request; "does it contain milk" is an
    // allergen question, and mining the second proposed an alias FROM an
    // allergen term — an edge the catalog's safety binding forbids outright.
    expect(surfaces("voces tem picanha?")).toContain("picanha")
    expect(surfaces("ainda tem picanha hoje?")).toContain("picanha")
    expect(surfaces("o Brownie com Sorvete tem leite?")).not.toContain("leite")
  })
})

describe("the count-noun signal", () => {
  it("fires on an indefinite article or a numeral", () => {
    expect(extractRequestObjects("me ve uma agua")[0]?.quantified).toBe(true)
    expect(extractRequestObjects("adiciona dois refrigerantes")[0]?.quantified).toBe(true)
  })

  it("REGRESSION: does NOT fire on a definite article", () => {
    // "muda o status", "quero trocar a forma de pagamento" and "me mandar o
    // menu" were all reported as CATALOG GAPS when every determiner counted.
    expect(extractRequestObjects("muda o status")[0]?.quantified).toBe(false)
    expect(extractRequestObjects("Pode me mandar o menu")[0]?.quantified).toBe(false)
  })
})

describe("mentionsFrom", () => {
  it("counts one utterance once per surface", () => {
    const got = mentionsFrom(["quero uma coca e depois quero uma coca"], "transcript")
    expect(got.filter((m) => m.surface === "coca")).toHaveLength(1)
  })

  it("tags the source it was told", () => {
    expect(mentionsFrom(["quero uma coca"], "transcript")[0]?.source).toBe("transcript")
    expect(labelledMention("coca", "coca").source).toBe("labelled-event")
  })
})

describe("displayFormOf", () => {
  it("recovers the customer's own spelling", () => {
    expect(displayFormOf("me vê uma Coca-Cola gelada", "coca cola")).toBe("Coca-Cola")
  })

  it("falls back to the folded form when the span cannot be located", () => {
    expect(displayFormOf("nothing here", "coca")).toBe("coca")
  })
})

// ── Classification ───────────────────────────────────────────────────────────

describe("classifyCandidate", () => {
  it("REGRESSION: a canonical product name is not an alias for itself", () => {
    // LE2-025a's gazetteer header states `refrigerante` is a catalog gap —
    // "there is NO soft-drink handle in the seed at all". The live store has
    // sold a published `refrigerante` since the seed was written. Classifying
    // against the roster instead of against the catalog package's own view is
    // what makes this branch reachable at all.
    const got = classifyCandidate(
      "refrigerante",
      "Refrigerante",
      [mention("refrigerante", "põe mais um refrigerante no meu pedido")],
      ROSTER,
      GAZETTEER,
    )
    expect(got.rowType).toBe("already-canonical")
    expect(got.rowType).not.toBe("catalog-gap")
    expect(got.targets).toEqual(["refrigerante"])
  })

  it("proposes an alias when exactly one product answers to the surface", () => {
    const got = classifyCandidate(
      "frango",
      "Frango",
      [mention("frango", "quero pedir um Frango Defumado Inteiro")],
      { ...ROSTER, products: [{ handle: "frango-defumado-inteiro", title: "Frango Defumado Inteiro", variantTitles: [] }] },
      GAZETTEER,
    )
    expect(got.rowType).toBe("propose-alias")
    expect(got.target).toBe("frango-defumado-inteiro")
  })

  it("demands disambiguation when two products answer to it", () => {
    const got = classifyCandidate(
      "costela",
      "costela",
      [mention("costela", "tira a costela do meu carrinho")],
      ROSTER,
      GAZETTEER,
    )
    expect(got.rowType).toBe("needs-disambiguation")
    expect(got.targets).toEqual(["costela-bovina-defumada", "costela-defumada-congelada"])
  })

  it("separates a VARIANT target from a product target", () => {
    // "coca" resolves — to the Coca-Cola variant of `refrigerante`. An alias
    // edge pointing at the parent product would collapse Coca-Cola and Guaraná
    // into one thing, so this cannot be a propose-alias row.
    const got = classifyCandidate(
      "coca",
      "coca",
      [mention("coca", "quero uma coca")],
      ROSTER,
      GAZETTEER,
    )
    expect(got.rowType).toBe("variant-target")
    expect(got.targets).toEqual(["refrigerante/Coca-Cola"])
    expect(got.target).toBeUndefined()
  })

  it("reports a catalog gap only when the surface was quantified", () => {
    const gap = classifyCandidate(
      "agua",
      "agua",
      [mention("agua", "me ve uma agua e tambem uma coca-cola, por favor")],
      ROSTER,
      GAZETTEER,
    )
    expect(gap.rowType).toBe("catalog-gap")

    const noise = classifyCandidate(
      "saber",
      "saber",
      [mention("saber", "quero saber", { quantified: false })],
      ROSTER,
      GAZETTEER,
    )
    expect(noise.rowType).toBe("noise")
  })

  it("REGRESSION: a plural is an alias candidate, not a missing product", () => {
    // `costelas`, `Farofas` and `linguicas` were all reported as catalog gaps —
    // the miner claiming the store sells no costela.
    const got = classifyCandidate(
      "farofas",
      "Farofas",
      [mention("farofas", "adiciona duas Farofas de Bacon no carrinho")],
      ROSTER,
      [],
    )
    expect(got.rowType).toBe("propose-alias")
    expect(got.target).toBe("farofa-de-bacon-defumado")
    expect(got.why).toContain("plural")
  })

  it("reports an already-declared surface as already-aliased", () => {
    const got = classifyCandidate(
      "farofa",
      "farofa",
      [mention("farofa", "quero uma farofa")],
      ROSTER,
      GAZETTEER,
    )
    expect(got.rowType).toBe("already-aliased")
  })

  it("counts evidence in DISTINCT utterances", () => {
    const got = classifyCandidate(
      "agua",
      "agua",
      [
        mention("agua", "me ve uma agua"),
        mention("agua", "me ve uma agua"),
        mention("agua", "quero uma agua gelada"),
      ],
      ROSTER,
      GAZETTEER,
    )
    expect(got.evidence).toBe(2)
  })
})

describe("classifyAll", () => {
  it("groups mentions by folded surface", () => {
    const got = classifyAll(
      [mention("coca", "quero uma coca"), mention("coca", "põe uma coca no pedido")],
      ROSTER,
      GAZETTEER,
    )
    expect(got).toHaveLength(1)
    expect(got[0]?.evidence).toBe(2)
  })
})

// ── Ranking ──────────────────────────────────────────────────────────────────

describe("rankCandidates", () => {
  const candidates = classifyAll(
    [
      mention("agua", "me ve uma agua"),
      mention("agua", "quero uma agua"),
      mention("agua", "traz uma agua"),
      mention("frango", "quero um frango"),
      mention("saber", "quero saber", { quantified: false }),
    ],
    { ...ROSTER, products: [...ROSTER.products, { handle: "frango-defumado-inteiro", title: "Frango Defumado Inteiro", variantTitles: [] }] },
    GAZETTEER,
  )

  it("puts actionable rows before informational ones regardless of evidence", () => {
    const ranked = rankCandidates(candidates)
    // `frango` proposes an edit on 1 utterance; `agua` reports a fact on 3.
    const frango = ranked.findIndex((c) => c.surface === "frango")
    const agua = ranked.findIndex((c) => c.surface === "agua")
    expect(frango).toBeLessThan(agua)
  })

  it("puts noise last", () => {
    const ranked = rankCandidates(candidates)
    expect(ranked[ranked.length - 1]?.rowType).toBe("noise")
  })

  it("orders by evidence within a row type", () => {
    const rows = classifyAll(
      [
        mention("agua", "me ve uma agua"),
        mention("agua", "quero uma agua"),
        mention("picanha", "quero uma picanha"),
      ],
      ROSTER,
      GAZETTEER,
    )
    const ranked = rankCandidates(rows).filter((c) => c.rowType === "catalog-gap")
    expect(ranked.map((c) => c.surface)).toEqual(["agua", "picanha"])
  })

  it("prefers a runtime-labelled surface at equal evidence", () => {
    const rows = classifyAll(
      [
        mention("agua", "agua", { source: "labelled-event" }),
        mention("picanha", "picanha"),
      ],
      ROSTER,
      GAZETTEER,
    )
    expect(rankCandidates(rows)[0]?.surface).toBe("agua")
  })

  it("produces the SAME rows with and without the embedder", () => {
    // The report's content may not depend on whether an ollama host answered —
    // only its order and an advisory column may.
    const withOut = rankCandidates(candidates)
    const withEmb = rankCandidates(
      candidates,
      new Map([["agua", { handle: "limonada-suica", similarity: 0.9 }]]),
    )
    expect(withEmb.map((c) => c.surface).sort()).toEqual(withOut.map((c) => c.surface).sort())
    expect(withEmb.map((c) => c.rowType).sort()).toEqual(withOut.map((c) => c.rowType).sort())
    expect(withEmb.find((c) => c.surface === "agua")?.nearest?.handle).toBe("limonada-suica")
    expect(withOut.find((c) => c.surface === "agua")?.nearest).toBeUndefined()
  })

  it("is a total, stable order", () => {
    expect(rankCandidates(candidates).map((c) => c.surface)).toEqual(
      rankCandidates([...candidates].reverse()).map((c) => c.surface),
    )
  })
})

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it("is 0 on a length mismatch or a zero vector", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})

// ── Report ───────────────────────────────────────────────────────────────────

describe("scrubUtterance", () => {
  it("masks the repo's PII taxonomy", () => {
    expect(scrubUtterance("meu cpf e 123.456.789-00")).toContain("[REDACTED:CPF]")
    expect(scrubUtterance("me manda em a@b.com")).toContain("[REDACTED:EMAIL]")
    expect(scrubUtterance("meu numero e (16) 99999-8888")).toContain("[REDACTED:PHONE]")
  })

  it("masks order references, which are not PII but are customer handles", () => {
    expect(scrubUtterance("quero alterar o pedido 947310")).toBe("quero alterar o pedido [num]")
  })

  it("keeps sizes and quantities, which are the product detail a reviewer needs", () => {
    expect(scrubUtterance("quanto custa a coca 2L?")).toBe("quanto custa a coca 2L?")
    expect(scrubUtterance("uma lata de 350ml")).toBe("uma lata de 350ml")
  })

  it("caps a runaway utterance", () => {
    expect(scrubUtterance("a".repeat(500))).toContain("[REDACTED:TRUNCATED]")
  })
})

describe("renderReport", () => {
  const ctx: ReportContext = {
    generatedAt: "2026-07-26T00:00:00.000Z",
    mode: "frequency-only",
    sources: [
      { name: "labelled-event", query: "_time:30d component:=\"funnel\"", records: 0 },
      { name: "transcript", query: "SELECT DISTINCT user_text …", records: 602 },
    ],
    gazetteerSize: 9,
    rosterProducts: 30,
    rosterCategories: 11,
    embedder: "not configured",
  }
  const rendered = renderReport(
    rankCandidates(
      classifyAll([mention("agua", "me ve uma agua para o pedido 947310")], ROSTER, GAZETTEER),
    ),
    ctx,
  )

  it("gives every candidate an approve AND a reject box", () => {
    expect(rendered).toContain("- [ ] **approve** `agua`")
    expect(rendered).toContain("- [ ] **reject** `agua`")
  })

  it("states the ranking mode and the schema version", () => {
    expect(rendered).toContain("`frequency-only`")
    expect(rendered).toContain("**Schema:** v1")
  })

  it("states each source and its query, including sources that returned nothing", () => {
    expect(rendered).toContain("| labelled-event |")
    expect(rendered).toContain("| transcript |")
  })

  it("declares the sourcing boundary", () => {
    expect(rendered).toContain("packages/journeys/extraction-corpus")
  })

  it("scrubs the example utterances it prints", () => {
    expect(rendered).toContain("me ve uma agua para o pedido [num]")
    expect(rendered).not.toContain("947310")
  })

  it("tells the reader how an approved row reaches the catalog", () => {
    expect(rendered).toContain("packages/catalog/src/alias-gazetteer.ts")
    expect(rendered).toContain("The miner never writes")
  })

  it("renders every section even when empty", () => {
    expect(rendered).toContain("## Propose alias (0)")
    expect(rendered).toContain("## Catalog gap — no product to alias (1)")
  })
})
