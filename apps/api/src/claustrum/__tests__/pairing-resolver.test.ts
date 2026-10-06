// pairing-resolver.test.ts — LE2-029: the four-branch pairing/substitution READ.
//
// The unit half of ticket 29. Its sibling `pairings.e2e.test.ts` drives the SAME
// behaviour through a real `handleTurn`; this file pins the resolver's own
// decisions, where each one can be isolated:
//
//   (a) `classifyPairingAsk` — which RELATION the utterance asks about, and the
//       precedence rule when both vocabularies appear.
//   (b) `findPairingSubject` — the alias-canonicalized subject lookup (AC-3's
//       alias proof at unit level), the ambiguous decline, and whole-token
//       matching.
//   (c) `resolvePairings` — all four branches plus the three DEGRADE paths a
//       partial graph over a live catalog can take (dead objects, a dead subject,
//       an unreadable catalog).
//   (d) the per-turn memo (one catalog read per turn, the C6 same-scalar
//       invariant's mechanism).
//   (e) `joinPtBrList` — the pt-BR list frame, no Oxford comma.
//
// EVERY NEGATIVE IS DIRECTIONAL. A "resolves to unknown" assertion proves nothing
// on its own — a resolver that returned `unknown` unconditionally would satisfy
// half this file — so each one is paired with the NEAREST positive control that
// must still pass. That is the same discipline the delivery-coverage and
// coupon-validity resolver suites carry, and the reason the ambiguous-costela case
// sits beside the canonical-handle case rather than in its own describe block.
//
// THE ONE MOCKED SEAM is `resolveMenuItem` — the resolver's single IO edge (the
// live catalog read). Everything else, including the composers under test and the
// REAL `PAIRING_GRAPH`, stays real, so the strings asserted here are the strings
// the customer would see.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PAIRING_GRAPH } from "@ibatexas/catalog";
import type { MenuItemResolveContext } from "../menu-item-resolver.js";
import {
  classifyPairingAsk,
  isBothPairingAsk,
  isPairingAsk,
} from "../required-claim-decomposer.js";

// Mock ONLY the catalog read seam; the rest of the module (and every other module
// this file touches) stays real.
vi.mock("../menu-item-resolver.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../menu-item-resolver.js")>();
  return { ...orig, resolveMenuItem: vi.fn() };
});

const { resolveMenuItem } = await import("../menu-item-resolver.js");
const {
  clearPairingMemoForTests,
  composePairingsText,
  composeSubstitutionsText,
  findPairingSubject,
  joinPtBrList,
  resolvePairings,
  MENU_PAIRINGS_KEY,
  MENU_SUBSTITUTIONS_KEY,
} = await import("../pairing-resolver.js");

const CTX: MenuItemResolveContext = {
  channel: "web",
  sessionId: "conv-1",
  customerId: "guest:abc",
};

/**
 * The LIVE catalog, keyed the way `resolveMenuItem` is actually queried: the
 * resolver de-kebabs a handle before searching (`mandioca-frita` → "mandioca
 * frita"), so a fixture keyed on the HANDLE would silently never match and every
 * branch would degrade to `unknown` for the wrong reason.
 *
 * Titles are the seed catalog's own (`apps/commerce/src/seed-data.ts`), because
 * the load-bearing property under test is that the SPOKEN name is the product's
 * live title and never the handle.
 */
const LIVE_TITLES: Readonly<Record<string, string>> = {
  "brisket americano": "Brisket Americano",
  "mandioca frita": "Mandioca Frita",
  "limonada suica": "Limonada Suíça",
  "brownie com sorvete": "Brownie com Sorvete",
  "costela bovina defumada": "Costela Bovina Defumada",
  "costela defumada congelada": "Costela Defumada Congelada",
  "farofa de bacon defumado": "Farofa de Bacon Defumado",
  "molho barbecue artesanal": "Molho Barbecue Artesanal",
  "pulled pork": "Pulled Pork",
  "pulled pork congelado": "Pulled Pork Congelado",
  "linguica artesanal defumada": "Linguiça Artesanal Defumada",
  "feijao tropeiro": "Feijão Tropeiro",
  "coleslaw da casa": "Coleslaw da Casa",
  "frango defumado inteiro": "Frango Defumado Inteiro",
  "barriga de porco defumada": "Barriga de Porco Defumada",
};

function liveItem(title: string) {
  return {
    id: `prod_${title.toLowerCase().replace(/\W+/g, "_")}`,
    title,
    price: 1000,
    description: null,
    categoryHandle: "carnes",
    inStock: true,
  };
}

/** Serve the live catalog, minus the handles the case declares as DEAD (the store
 *  no longer sells them). A handle absent from {@link LIVE_TITLES} resolves to
 *  `undefined` exactly as an unknown item does in production. */
function serveCatalog(dead: readonly string[] = []): void {
  const deadText = new Set(dead.map((h) => h.replace(/-/g, " ")));
  vi.mocked(resolveMenuItem).mockImplementation(async (_turnId, itemText) => {
    if (deadText.has(itemText)) return undefined;
    const title = LIVE_TITLES[itemText];
    return title === undefined ? undefined : liveItem(title);
  });
}

beforeEach(() => {
  clearPairingMemoForTests();
  vi.mocked(resolveMenuItem).mockReset();
  serveCatalog();
});

// ── (a) classifyPairingAsk — WHICH relation, and who wins a tie ───────────────

describe("LE2-029 (a) — classifyPairingAsk picks the relation the customer asked about", () => {
  it("a 'what goes with' question is `pairs-with`", () => {
    expect(classifyPairingAsk("o que combina com brisket?")).toBe("pairs-with");
  });

  it("an ABSENCE question is `substitutes-for`", () => {
    expect(classifyPairingAsk("não tem costela, o que peço no lugar?")).toBe(
      "substitutes-for",
    );
  });

  it("SUBSTITUTION WINS when both vocabularies appear in one utterance", () => {
    // "vai bem" is pairing vocabulary and "no lugar" is substitution vocabulary;
    // the operative word is the one saying the customer cannot have what they
    // asked for. The positive control below proves the pairing net is not simply
    // dead — the same sentence WITHOUT the absence clause classifies the other way.
    expect(classifyPairingAsk("o que vai bem no lugar da costela")).toBe(
      "substitutes-for",
    );
    expect(classifyPairingAsk("o que vai bem com a costela")).toBe("pairs-with");
  });

  it("a plain ORDER is not a pairing ask at all", () => {
    expect(classifyPairingAsk("quero um brisket")).toBeUndefined();
    expect(isPairingAsk("quero um brisket")).toBe(false);
    // Positive control: the same item, asked ABOUT rather than ordered.
    expect(isPairingAsk("o que combina com brisket?")).toBe(true);
  });
});

// ── (a2) isBothPairingAsk — the TWO-question utterance ───────────────────────

describe("LE2-029 (a2) — isBothPairingAsk tells two questions from one", () => {
  const BOTH_ASK = "o que combina com a costela bovina e o que posso pôr no lugar?";
  const BORROWED_VOCABULARY = "o que vai bem no lugar da costela";

  it("fires on a genuine TWO-question utterance", () => {
    expect(isBothPairingAsk(BOTH_ASK)).toBe(true);
  });

  it("REGRESSION GUARD: does NOT fire on the single question that borrows both vocabularies", () => {
    // THE BUG THIS CASE EXISTS FOR. Both nets fire on this string — "vai bem" is
    // pairing vocabulary, "no lugar" is substitution vocabulary — so the first cut
    // of the predicate (both-vocabularies alone) degraded the ticket's own primary
    // use case to a shrug. What separates them is TWO INTERROGATIVE CLAUSE HEADS;
    // this sentence has exactly one.
    expect(isBothPairingAsk(BORROWED_VOCABULARY)).toBe(false);
    // …and the precedence still owns it, unchanged.
    expect(classifyPairingAsk(BORROWED_VOCABULARY)).toBe("substitutes-for");
  });

  it("fires on the `qual …` interrogative head too, not just `o que`", () => {
    expect(
      isBothPairingAsk("qual acompanhamento combina com brisket e qual posso pôr no lugar?"),
    ).toBe(true);
  });

  it("does NOT fire on either single question on its own", () => {
    expect(isBothPairingAsk("o que combina com brisket?")).toBe(false);
    expect(isBothPairingAsk("não tem brisket, o que peço no lugar?")).toBe(false);
  });

  // ACCEPTED LIMIT, recorded rather than pinned: an UNHEADED two-question form
  // ("o que combina com a costela e um substituto") carries one interrogative
  // head, is NOT detected, and half-answers. That is the deliberate direction —
  // a false positive breaks the primary use case, a false negative says nothing
  // untrue — so there is no test asserting the unheaded form is detected.
});

// ── (b) findPairingSubject — canonicalized, declining, whole-token ────────────

describe("LE2-029 (b) — findPairingSubject runs the catalog's own canonicalizer", () => {
  it("AC-3: the colloquial alias and the canonical handle find the SAME subject", () => {
    expect(findPairingSubject("o que combina com brisket?")).toBe(
      "brisket-americano",
    );
    expect(findPairingSubject("o que combina com brisket-americano?")).toBe(
      "brisket-americano",
    );
  });

  it("an AMBIGUOUS surface resolves to NOTHING — the canonicaliser declines to guess", () => {
    // "costela" names two products with different prices and different
    // fulfilment, so the canonicalizer refuses and so does this. The positive
    // control is the SAME product named unambiguously: the subject exists in the
    // graph and IS findable, so the `undefined` above is the ambiguity and not a
    // missing row.
    expect(findPairingSubject("o que combina com costela?")).toBeUndefined();
    expect(
      findPairingSubject("o que combina com costela-bovina-defumada?"),
    ).toBe("costela-bovina-defumada");
  });

  it("a word the graph has never heard of resolves to NOTHING", () => {
    expect(findPairingSubject("o que combina com sushi?")).toBeUndefined();
    // …and the same frame with a KNOWN item still resolves.
    expect(findPairingSubject("o que combina com linguiça?")).toBe(
      "linguica-artesanal-defumada",
    );
  });

  it("WHOLE-TOKEN: `pulled-pork-congelado` is never read as `pulled-pork`", () => {
    // The frozen row is an OBJECT in the graph, never a subject. Substring
    // matching would answer a question about the frozen product with the fresh
    // product's edges — a confident wrong answer, the exact class this floor
    // exists to stop.
    expect(
      findPairingSubject("o que combina com pulled-pork-congelado?"),
    ).toBeUndefined();
    // The positive control: the bare handle IS a subject and DOES resolve, so the
    // negative above measures the token boundary and not a missing subject.
    expect(findPairingSubject("o que combina com pulled-pork?")).toBe(
      "pulled-pork",
    );
  });
});

// ── (c) resolvePairings — the four branches and the three degrades ───────────

describe("LE2-029 (c) — the PAIRINGS branch speaks LIVE titles, never handles", () => {
  it("renders the subject's `pairs-with` objects in DECLARATION order", async () => {
    const out = await resolvePairings("turn-1", "o que combina com brisket?", CTX);
    expect(out.kind).toBe("pairings");
    if (out.kind !== "pairings") throw new Error("unreachable");
    expect(out.subject).toBe("brisket-americano");
    expect(out.suggestionsText).toBe(
      "Com Brisket Americano, aqui na casa a gente costuma servir " +
        "Mandioca Frita, Limonada Suíça e Brownie com Sorvete",
    );
  });

  it("NO kebab handle survives into the spoken scalar (Hard Rule 4)", async () => {
    const out = await resolvePairings("turn-2", "o que combina com brisket?", CTX);
    if (out.kind !== "pairings") throw new Error("expected pairings");
    for (const handle of ["brisket-americano", "mandioca-frita", "limonada-suica"]) {
      expect(out.suggestionsText).not.toContain(handle);
    }
    // Directional: the LIVE titles for those same handles ARE present, so the
    // assertion above is about the handle spelling and not an empty string.
    expect(out.suggestionsText).toContain("Mandioca Frita");
    expect(out.suggestionsText).toContain("Limonada Suíça");
  });

  it("queries the catalog with the DE-KEBABED handle (words, not hyphens)", async () => {
    await resolvePairings("turn-3", "o que combina com brisket?", CTX);
    const queries = vi.mocked(resolveMenuItem).mock.calls.map((c) => c[1]);
    expect(queries).toContain("mandioca frita");
    expect(queries).not.toContain("mandioca-frita");
  });
});

describe("LE2-029 (c) — the SUBSTITUTIONS branch has its own frame", () => {
  it("answers an absence with the menu-stated stand-in", async () => {
    const out = await resolvePairings(
      "turn-4",
      "não tem costela-bovina-defumada, o que peço no lugar?",
      CTX,
    );
    expect(out.kind).toBe("substitutions");
    if (out.kind !== "substitutions") throw new Error("unreachable");
    expect(out.subject).toBe("costela-bovina-defumada");
    expect(out.substitutionsText).toBe(
      "No lugar de Costela Bovina Defumada, a casa indica Costela Defumada Congelada",
    );
    // The two frames are DIFFERENT ACTS, and the substitution one never invites
    // an addition.
    expect(out.substitutionsText).not.toContain("costuma servir");
  });
});

describe("LE2-029 (c) — every degrade is the HONEST UNKNOWN, never a guess", () => {
  it("an item the graph has never heard of → unknown (positive control beside it)", async () => {
    expect(
      await resolvePairings("turn-5", "o que combina com sushi?", CTX),
    ).toEqual({ kind: "unknown" });
    expect(
      (await resolvePairings("turn-5b", "o que combina com brisket?", CTX)).kind,
    ).toBe("pairings");
  });

  it("a known subject with NO EDGES of the ASKED relation → unknown", async () => {
    // `brisket-americano` has three `pairs-with` edges and ZERO `substitutes-for`
    // ones. The graph is a PARTIAL authored seed, so "no edge recorded" is "not
    // written down yet", never "nothing stands in for it".
    expect(
      PAIRING_GRAPH.some(
        (e) => e.subject === "brisket-americano" && e.relation === "substitutes-for",
      ),
    ).toBe(false);
    const out = await resolvePairings(
      "turn-6",
      "não tem brisket, o que peço no lugar?",
      CTX,
    );
    expect(out).toEqual({ kind: "unknown" });
    // Directional control: the SAME subject, asked about the relation it DOES
    // carry, answers — so the unknown above is the empty relation, not a dead
    // subject or a dead catalog.
    expect(
      (await resolvePairings("turn-6b", "o que combina com brisket?", CTX)).kind,
    ).toBe("pairings");
  });

  it("a non-pairing utterance never reaches the graph at all", async () => {
    expect(await resolvePairings("turn-7", "quero um brisket", CTX)).toEqual({
      kind: "unknown",
    });
    expect(vi.mocked(resolveMenuItem)).not.toHaveBeenCalled();
  });

  it("a SUBJECT the live store no longer sells → unknown (no advice about a dead product)", async () => {
    serveCatalog(["brisket-americano"]);
    expect(
      await resolvePairings("turn-8", "o que combina com brisket?", CTX),
    ).toEqual({ kind: "unknown" });
  });

  it("ALL objects dead in the live catalog → unknown", async () => {
    serveCatalog(["mandioca-frita", "limonada-suica", "brownie-com-sorvete"]);
    expect(
      await resolvePairings("turn-9", "o que combina com brisket?", CTX),
    ).toEqual({ kind: "unknown" });
  });

  it("SOME objects dead → the survivors are spoken and the dead one is ABSENT", async () => {
    serveCatalog(["mandioca-frita"]);
    const out = await resolvePairings("turn-10", "o que combina com brisket?", CTX);
    expect(out.kind).toBe("pairings");
    if (out.kind !== "pairings") throw new Error("unreachable");
    // A stale edge costs a SUGGESTION; it never produces a wrong one.
    expect(out.suggestionsText).toBe(
      "Com Brisket Americano, aqui na casa a gente costuma servir " +
        "Limonada Suíça e Brownie com Sorvete",
    );
    expect(out.suggestionsText).not.toContain("Mandioca");
  });

  it("an UNREADABLE catalog → unknown (Inv 7: 'could not check', never 'nothing goes with it')", async () => {
    vi.mocked(resolveMenuItem).mockRejectedValue(new Error("catalog down"));
    expect(
      await resolvePairings("turn-11", "o que combina com brisket?", CTX),
    ).toEqual({ kind: "unknown" });
    // The read WAS attempted — this is a thrown read, not a skipped one.
    expect(vi.mocked(resolveMenuItem)).toHaveBeenCalled();
  });
});

describe("LE2-029 (c) — a BOTH-ask DEGRADES rather than half-answering", () => {
  // `costela-bovina-defumada` is the seed's one subject carrying edges of BOTH
  // relations (a frozen substitute AND two pairings), so it is the ONLY subject
  // on which the old precedence could answer one half confidently and drop the
  // other in silence. That makes it the case, not an illustration of it.
  const BOTH_ASK = "o que combina com a costela bovina e o que posso pôr no lugar?";

  it("records NOTHING and reads NOTHING — neither claim key can be produced", async () => {
    // The subject IS resolvable, so this degrade is a decision about the
    // QUESTION and not a failure to find the item.
    expect(findPairingSubject(BOTH_ASK)).toBe("costela-bovina-defumada");

    const out = await resolvePairings("turn-both", BOTH_ASK, CTX);
    expect(out).toEqual({ kind: "unknown" });
    // `unknown` is the ONLY branch on which the investigator pushes no read, so
    // neither `menu:pairings` nor `menu:substitutions` can be recorded. The
    // short-circuit also means the catalog is never touched.
    expect(vi.mocked(resolveMenuItem)).not.toHaveBeenCalled();
  });

  it("CONTROL A: the borrowed-vocabulary SINGLE ask still resolves to a substitution", async () => {
    // The regression guard at the RESOLVER level, not just the predicate's. Note
    // the subject is spelled canonically here: the bare "costela" the predicate
    // case uses is the AMBIGUOUS surface (two products), so it would degrade for
    // a reason this case is not about — see the ambiguity test above.
    const out = await resolvePairings(
      "turn-borrowed",
      "o que vai bem no lugar da costela-bovina-defumada",
      CTX,
    );
    expect(out.kind).toBe("substitutions");
  });

  it("CONTROL B: the SAME subject asked as a SINGLE question still answers", async () => {
    // Without these the degrade above would pass for a resolver that simply never
    // answered about the costela at all.
    const pairing = await resolvePairings(
      "turn-both-ctl-1",
      "o que combina com costela-bovina-defumada?",
      CTX,
    );
    expect(pairing.kind).toBe("pairings");
    if (pairing.kind !== "pairings") throw new Error("unreachable");
    expect(pairing.suggestionsText).toBe(
      "Com Costela Bovina Defumada, aqui na casa a gente costuma servir " +
        "Farofa de Bacon Defumado e Molho Barbecue Artesanal",
    );

    const substitution = await resolvePairings(
      "turn-both-ctl-2",
      "o que posso pedir no lugar da costela-bovina-defumada?",
      CTX,
    );
    expect(substitution.kind).toBe("substitutions");
    if (substitution.kind !== "substitutions") throw new Error("unreachable");
    expect(substitution.substitutionsText).toBe(
      "No lugar de Costela Bovina Defumada, a casa indica Costela Defumada Congelada",
    );
  });
});

describe("LE2-029 (c) — an ALLERGEN/DIET-marked ask never gets a suggestion", () => {
  const DIET_MARKED = "o que combina com brisket que seja sem glúten?";

  it("degrades to unknown and never touches the catalog", async () => {
    // The subject IS resolvable and the relation IS asked, so this degrade is a
    // decision about the SAFETY MARKER — not a lookup failure. Measured at the
    // turn seam (`pairings.e2e.test.ts`) before the guard existed: this exact
    // utterance rendered the full grounded suggestion list.
    expect(findPairingSubject(DIET_MARKED)).toBe("brisket-americano");
    expect(classifyPairingAsk(DIET_MARKED)).toBe("pairs-with");

    expect(await resolvePairings("turn-diet", DIET_MARKED, CTX)).toEqual({
      kind: "unknown",
    });
    expect(vi.mocked(resolveMenuItem)).not.toHaveBeenCalled();
  });

  it("THE CONTROL: the same question WITHOUT the marker answers", async () => {
    expect(
      (await resolvePairings("turn-diet-ctl", "o que combina com brisket?", CTX))
        .kind,
    ).toBe("pairings");
  });

  it("covers the whole allergen family, not just glúten", async () => {
    for (const [i, text] of [
      "o que combina com brisket sem lactose?",
      "o que combina com brisket que não contém amendoim?",
      "sou alérgico, o que combina com brisket?",
    ].entries()) {
      expect(await resolvePairings(`turn-fam-${i}`, text, CTX)).toEqual({
        kind: "unknown",
      });
    }
  });
});

// ── (d) the per-turn memo ────────────────────────────────────────────────────

describe("LE2-029 (d) — the per-turn memo: ONE catalog read per turn", () => {
  it("two calls with the SAME turnId + text coalesce onto one set of reads", async () => {
    const first = await resolvePairings("turn-memo", "o que combina com brisket?", CTX);
    const afterFirst = vi.mocked(resolveMenuItem).mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    const second = await resolvePairings("turn-memo", "o que combina com brisket?", CTX);
    expect(vi.mocked(resolveMenuItem).mock.calls.length).toBe(afterFirst);
    // Byte-equal by construction — the property that makes the investigator's
    // recorded scalar and the planner's derived scalar match (C6).
    expect(second).toEqual(first);
  });

  it("a DIFFERENT turn re-reads — the memo is turn-scoped, never a global cache", async () => {
    await resolvePairings("turn-memo-a", "o que combina com brisket?", CTX);
    const afterFirst = vi.mocked(resolveMenuItem).mock.calls.length;
    await resolvePairings("turn-memo-b", "o que combina com brisket?", CTX);
    expect(vi.mocked(resolveMenuItem).mock.calls.length).toBeGreaterThan(afterFirst);
  });
});

// ── (e) joinPtBrList + the composers ─────────────────────────────────────────

describe("LE2-029 (e) — joinPtBrList speaks pt-BR (no Oxford comma)", () => {
  it("one, two and three names", () => {
    expect(joinPtBrList(["a"])).toBe("a");
    expect(joinPtBrList(["a", "b"])).toBe("a e b");
    expect(joinPtBrList(["a", "b", "c"])).toBe("a, b e c");
  });

  it("an empty list is the empty string (the caller never reaches it — see the branches)", () => {
    expect(joinPtBrList([])).toBe("");
  });

  it("the two composers produce DIFFERENT frames for the same pair", () => {
    const args = { subjectTitle: "Brisket Americano", objectTitles: ["Mandioca Frita"] };
    expect(composePairingsText(args)).not.toBe(composeSubstitutionsText(args));
    expect(composePairingsText(args)).toContain("aqui na casa a gente costuma servir");
    expect(composeSubstitutionsText(args)).toContain("No lugar de");
  });
});

// ── The evidence keys the investigator and the registry share ────────────────

describe("LE2-029 — the two evidence keys are DISTINCT (the presence complement)", () => {
  it("declares one key per relation", () => {
    expect(MENU_PAIRINGS_KEY).toBe("menu:pairings");
    expect(MENU_SUBSTITUTIONS_KEY).toBe("menu:substitutions");
    expect(MENU_PAIRINGS_KEY).not.toBe(MENU_SUBSTITUTIONS_KEY);
  });
});
