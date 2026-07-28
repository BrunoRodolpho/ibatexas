// BKL-142 — the menu claim chain (MENU_ITEM_PRICE / MENU_ITEM_CONTENTS) on the shared
// resolver. Deterministic; no live model. Pins the registry shape (public / perResource
// / deliberately-unread falsifier / scalar valueBinding), the single-proposition
// templates, the deterministic scalar composers (Hard Rule #2 money), and the
// decomposer span classification (fires on menu questions, disjoint from cart / order /
// allergen families).

import { describe, it, expect } from "vitest";
import { CLAIM_REGISTRY, REGISTRY_SPECS, isRegistryClaimType } from "../claim-registry.js";
import { VALIDATED_TEMPLATES } from "../slot-grammar.js";
import {
  classifyRequestSpans,
  isAllergenFamilyAsk,
  REQUIRED_CLAIM_CLOSURE,
} from "../required-claim-decomposer.js";
import {
  formatCentavosBRL,
  composeMenuPriceText,
  composeMenuContentsText,
  composeMenuOverviewText,
  composeDietaryOptionsText,
  detectDietaryPreferenceTags,
  DIETARY_PREFERENCE_TAGS,
  type ResolvedMenuItem,
} from "../menu-item-resolver.js";

const item = (over: Partial<ResolvedMenuItem> = {}): ResolvedMenuItem => ({
  id: "prod_1",
  title: "Costela Defumada",
  price: 8900,
  description: "Costela bovina defumada 12h.",
  categoryHandle: "carnes",
  inStock: true,
  ...over,
});

describe("BKL-142 registry — MENU_ITEM_PRICE / MENU_ITEM_CONTENTS", () => {
  it("both are in-enum proposable types", () => {
    expect(CLAIM_REGISTRY).toContain("MENU_ITEM_PRICE");
    expect(CLAIM_REGISTRY).toContain("MENU_ITEM_CONTENTS");
    expect(isRegistryClaimType("MENU_ITEM_PRICE")).toBe(true);
    expect(isRegistryClaimType("MENU_ITEM_CONTENTS")).toBe(true);
  });

  it.each(["MENU_ITEM_PRICE", "MENU_ITEM_CONTENTS"] as const)(
    "%s is PUBLIC (not_applicable), perResourceKey, ttl 300_000ms, scalar valueBinding",
    (type) => {
      const spec = REGISTRY_SPECS[type];
      expect(spec.kind).toBe("read_claim");
      expect(spec.customerScoped).toBe(false);
      expect(spec.perResourceKey).toBe(true);
      expect(spec.requiredEvidence[0]!.ownershipPolicy).toBe("not_applicable");
      expect(spec.requiredEvidence[0]!.freshnessPolicy).toEqual({ kind: "cacheable", ttl: 300_000 });
      // C6 value-binding key must be one of requiredEvidence keys (kernel hard-throws otherwise).
      expect(spec.requiredEvidence.map((e) => e.key)).toContain(spec.valueBinding!.key);
    },
  );

  it("declares falsifierComplete with a DELIBERATELY-UNREAD menu:item_unpublished key (escapes W6; #290/#291 tautology precedent)", () => {
    for (const type of ["MENU_ITEM_PRICE", "MENU_ITEM_CONTENTS"] as const) {
      const spec = REGISTRY_SPECS[type];
      expect(spec.falsifierComplete).toBe(true);
      expect(spec.falsifiers?.map((f) => f.key)).toEqual(["menu:item_unpublished"]);
      // The falsifier key is NOT a requiredEvidence key (it is a DIFFERENT-key W6
      // falsifier) and NOT the valueBinding key (never read against itself).
      expect(spec.requiredEvidence.map((e) => e.key)).not.toContain("menu:item_unpublished");
    }
  });
});

describe("BKL-142 render templates — single proposition, scalar-bound (Inv 6)", () => {
  it.each([
    ["MENU_ITEM_PRICE", "priceText"],
    ["MENU_ITEM_CONTENTS", "contentsText"],
  ] as const)("%s binds exactly one proposition to %s (the C6 valueBinding path)", (type, field) => {
    const tpl = VALIDATED_TEMPLATES[type];
    expect(tpl).toBeDefined();
    expect(tpl!.posture).toBe("validated");
    const propSlots = tpl!.slots.filter(
      (s) => (s as { kind?: string }).kind === "PROPOSITION",
    );
    expect(propSlots).toHaveLength(1);
    // The single proposition reads the C6 valueBinding path field (1:1, Inv 6).
    expect((propSlots[0] as { field?: string }).field).toBe(field);
    expect(REGISTRY_SPECS[type].valueBinding!.path).toEqual([field]);
  });
});

describe("BKL-142 composers — deterministic first-party scalars (Hard Rule #2)", () => {
  it("formats integer centavos as pt-BR currency, never floats", () => {
    expect(formatCentavosBRL(8900)).toBe("R$ 89,00");
    expect(formatCentavosBRL(5)).toBe("R$ 0,05");
    expect(formatCentavosBRL(123456)).toBe("R$ 1.234,56");
    expect(formatCentavosBRL(100000000)).toBe("R$ 1.000.000,00");
  });

  it("priceText is a full first-party clause bound to the resolved product", () => {
    expect(composeMenuPriceText(item())).toBe("Costela Defumada custa R$ 89,00");
  });

  it("contentsText prefixes the title to the first-party description", () => {
    expect(composeMenuContentsText(item(), "o que vem na costela?")).toBe("Costela Defumada: Costela bovina defumada 12h.");
  });

  it("contentsText is undefined when the catalog has no description → honest UNKNOWN, never fabricated", () => {
    expect(composeMenuContentsText(item({ description: null }), "o que vem na costela?")).toBeUndefined();
    expect(composeMenuContentsText(item({ description: "   " }), "o que vem na costela?")).toBeUndefined();
  });
});

describe("BKL-142 decomposer — span classification (disjoint from cart/order/allergen)", () => {
  it("classifies a price question", () => {
    expect(classifyRequestSpans("quanto custa a costela?")).toContain("MENU_ITEM_PRICE_Q");
    expect(classifyRequestSpans("qual o preço da linguiça")).toContain("MENU_ITEM_PRICE_Q");
  });

  it("classifies a contents question", () => {
    expect(classifyRequestSpans("o que vem no combo?")).toContain("MENU_ITEM_CONTENTS_Q");
    expect(classifyRequestSpans("do que é feito o prato")).toContain("MENU_ITEM_CONTENTS_Q");
  });

  it("does NOT sweep in cart / order / delivery questions", () => {
    expect(classifyRequestSpans("o que tem no meu carrinho?")).not.toContain("MENU_ITEM_CONTENTS_Q");
    expect(classifyRequestSpans("quanto custa a entrega?")).not.toContain("MENU_ITEM_PRICE_Q");
    expect(classifyRequestSpans("quanto ficou meu pedido?")).not.toContain("MENU_ITEM_PRICE_Q");
  });

  it("leaves allergen-family questions to the carved-out MENU_ITEM_ALLERGENS (never a CONTENTS render)", () => {
    expect(classifyRequestSpans("a costela contém glúten?")).not.toContain("MENU_ITEM_CONTENTS_Q");
    expect(classifyRequestSpans("tem lactose nos ingredientes?")).not.toContain("MENU_ITEM_CONTENTS_Q");
  });

  it("each menu span requires ONLY its own public claim (no unrelated coupling)", () => {
    expect(REQUIRED_CLAIM_CLOSURE.MENU_ITEM_PRICE_Q).toEqual(["MENU_ITEM_PRICE"]);
    expect(REQUIRED_CLAIM_CLOSURE.MENU_ITEM_CONTENTS_Q).toEqual(["MENU_ITEM_CONTENTS"]);
  });

  // ── BKL-205 half 1 — the ACCENTED plural forms ────────────────────────────────
  // Asserted spelling by spelling, NOT as one loop over a list, because the whole
  // point is that a stem can match one spelling and miss the other: `vem` matched
  // and `vêm` did not, and the ASCII spelling passing is exactly what hid it. Same
  // shape as the BKL-270 `diab[ée]t` vocabulary test and the BKL-271 `p[õo]r`
  // finding — a false-positive sweep can never surface an empty true-positive set.
  it("BKL-205 — fires on BOTH the unaccented and the ACCENTED contents forms", () => {
    // The spelling that already worked (the control — if this ever goes red the
    // accent fix broke the base case rather than extending it).
    expect(classifyRequestSpans("o que vem no combo família?")).toContain(
      "MENU_ITEM_CONTENTS_Q",
    );
    // The spelling the net MISSED — measured ∅ on dev before this ticket.
    expect(classifyRequestSpans("o que vêm no combo família?")).toContain(
      "MENU_ITEM_CONTENTS_Q",
    );
    // `têm` is load-bearing TOGETHER with the overview lookahead (BKL-205 half 2):
    // that lookahead sends this utterance away from the overview span, so without
    // the accented form here it would classify to NOTHING at all.
    expect(classifyRequestSpans("o que têm no prato executivo?")).toContain(
      "MENU_ITEM_CONTENTS_Q",
    );
  });

  // ── BKL-205 half 2 — SPECIFICITY ORDERING ─────────────────────────────────────
  // The registered defect, in the row's own words: "'o que TEM no X?' renders
  // MENU_OVERVIEW (overview span shadows the item-contents ask when a product name
  // follows)". Measured on dev: `["MENU_OVERVIEW_Q"]` — the whole catalogue
  // returned as the answer to a question about ONE item. Note this was never a
  // DEGRADE: the turn rendered confidently, off a VALIDATED claim, to the wrong
  // question. That is why it is fixed at the span and not at the resolver.
  it("BKL-205 — 'o que tem no <ITEM>?' is a per-ITEM contents ask, not a whole-menu one", () => {
    for (const text of [
      "o que tem no brisket?",
      "o que tem na costela bovina defumada?",
      "o que tem no combo família?",
      "o que tem nos acompanhamentos?",
    ]) {
      const spans = classifyRequestSpans(text);
      expect(spans, text).toContain("MENU_ITEM_CONTENTS_Q");
      expect(spans, text).not.toContain("MENU_OVERVIEW_Q");
    }
  });
});

// ── BKL-142 — MENU_OVERVIEW (the menu-wide, fixed-subject claim) ─────────────────
describe("BKL-142 MENU_OVERVIEW registry — PUBLIC, FIXED-subject (like STORE_HOURS)", () => {
  it("is an in-enum proposable type", () => {
    expect(CLAIM_REGISTRY).toContain("MENU_OVERVIEW");
    expect(isRegistryClaimType("MENU_OVERVIEW")).toBe(true);
  });

  it("is PUBLIC (not_applicable), FIXED-key (NOT perResourceKey), ttl 300_000ms, scalar valueBinding", () => {
    const spec = REGISTRY_SPECS.MENU_OVERVIEW;
    expect(spec.kind).toBe("read_claim");
    expect(spec.customerScoped).toBe(false);
    // Fixed-subject, unlike the per-item claims: no perResourceKey suffixing.
    expect((spec as { perResourceKey?: boolean }).perResourceKey).toBeUndefined();
    expect(spec.requiredEvidence[0]!.key).toBe("menu:overview");
    expect(spec.requiredEvidence[0]!.ownershipPolicy).toBe("not_applicable");
    expect(spec.requiredEvidence[0]!.freshnessPolicy).toEqual({ kind: "cacheable", ttl: 300_000 });
    expect(spec.valueBinding).toEqual({ key: "menu:overview", path: ["overviewText"] });
    expect(spec.requiredEvidence.map((e) => e.key)).toContain(spec.valueBinding!.key);
  });

  it("declares falsifierComplete with the DELIBERATELY-UNREAD menu:item_unpublished key (escapes W6; #290/#291 precedent)", () => {
    const spec = REGISTRY_SPECS.MENU_OVERVIEW;
    expect(spec.falsifierComplete).toBe(true);
    expect(spec.falsifiers?.map((f) => f.key)).toEqual(["menu:item_unpublished"]);
    expect(spec.requiredEvidence.map((e) => e.key)).not.toContain("menu:item_unpublished");
  });

  it("binds exactly one proposition to overviewText (Inv 6)", () => {
    const tpl = VALIDATED_TEMPLATES.MENU_OVERVIEW;
    expect(tpl).toBeDefined();
    expect(tpl!.posture).toBe("validated");
    const propSlots = tpl!.slots.filter((s) => (s as { kind?: string }).kind === "PROPOSITION");
    expect(propSlots).toHaveLength(1);
    expect((propSlots[0] as { field?: string }).field).toBe("overviewText");
  });
});

describe("BKL-142 composeMenuOverviewText — deterministic bounded first-party listing", () => {
  const listing = [
    { title: "Farofa", price: 1500, categoryHandle: "acompanhamentos" },
    { title: "Costela", price: 8900, categoryHandle: "carnes" },
    { title: "Linguiça", price: 4500, categoryHandle: "carnes" },
  ];

  it("composes a pt-BR list of first-party titles + centavos prices, deterministically (category then title order)", () => {
    const text = composeMenuOverviewText(listing);
    // Sorted by categoryHandle (acompanhamentos < carnes) then title.
    expect(text).toBe("No nosso cardápio: Farofa — R$ 15,00; Costela — R$ 89,00; Linguiça — R$ 45,00.");
  });

  it("is order-independent of the input (same set → byte-equal, so investigator + planner never diverge)", () => {
    const shuffled = [listing[2]!, listing[0]!, listing[1]!];
    expect(composeMenuOverviewText(shuffled)).toBe(composeMenuOverviewText(listing));
  });

  it("returns undefined for an empty catalog → honest UNKNOWN, never a fabricated menu", () => {
    expect(composeMenuOverviewText([])).toBeUndefined();
  });

  // BKL-182 — the "cardápio" overview is FOOD-only: merch (the seed "Loja" tree —
  // camisetas/acessorios/kits) is dropped before composing, and the "e mais N"
  // remainder counts food only. Live-caught in the SCN-005 drive (Avental/Boné/
  // Camiseta polluting the food list).
  it("BKL-182: drops merch categories from the overview (food-only listing)", () => {
    const withMerch = [
      ...listing,
      { title: "Avental IbateXas", price: 12000, categoryHandle: "acessorios" },
      { title: "Camiseta Logo", price: 7900, categoryHandle: "camisetas" },
      { title: "Kit Churrasco", price: 25000, categoryHandle: "kits" },
    ];
    const text = composeMenuOverviewText(withMerch)!;
    expect(text).toBe(composeMenuOverviewText(listing));
    expect(text).not.toContain("Avental");
    expect(text).not.toContain("Camiseta");
    expect(text).not.toContain("Kit Churrasco");
  });

  it("BKL-182: the remainder count excludes merch (never inflated by non-food items)", () => {
    const manyFood = Array.from({ length: 30 }, (_, i) => ({
      title: `Prato ${String(i).padStart(2, "0")}`,
      price: 1000 + i,
      categoryHandle: `food_${i % 8}`,
    }));
    const merch = Array.from({ length: 10 }, (_, i) => ({
      title: `Merch ${i}`,
      price: 5000,
      categoryHandle: "camisetas",
    }));
    const foodOnly = composeMenuOverviewText(manyFood)!;
    const mixed = composeMenuOverviewText([...manyFood, ...merch])!;
    expect(mixed).toBe(foodOnly);
  });

  it("BKL-182: an ALL-merch catalog composes undefined → honest UNKNOWN (no merch-as-menu)", () => {
    expect(
      composeMenuOverviewText([
        { title: "Avental", price: 12000, categoryHandle: "acessorios" },
      ]),
    ).toBeUndefined();
  });

  it("bounds a large catalog and honestly notes the remainder", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      title: `Item ${String(i).padStart(2, "0")}`,
      price: 1000 + i,
      categoryHandle: `cat_${i % 8}`,
    }));
    const text = composeMenuOverviewText(many)!;
    expect(text).toMatch(/e mais \d+ itens no cardápio/);
    // Never leaks allergen/dietary; prices are centavos-formatted.
    expect(text).toContain("R$ ");
  });
});

describe("BKL-142 MENU_OVERVIEW decomposer — whole-menu span, disjoint from per-item", () => {
  it("classifies a whole-menu question", () => {
    expect(classifyRequestSpans("o que tem no cardápio?")).toContain("MENU_OVERVIEW_Q");
    expect(classifyRequestSpans("me mostra o menu")).toContain("MENU_OVERVIEW_Q");
    expect(classifyRequestSpans("quais os pratos de vocês?")).toContain("MENU_OVERVIEW_Q");
  });

  it("a whole-menu question does NOT also fire the per-ITEM contents span (disjoint)", () => {
    expect(classifyRequestSpans("o que tem no cardápio?")).not.toContain("MENU_ITEM_CONTENTS_Q");
  });

  it("a per-item contents question does NOT fire the overview span", () => {
    expect(classifyRequestSpans("o que vem no combo?")).not.toContain("MENU_OVERVIEW_Q");
  });

  it("does NOT sweep in cart/order questions", () => {
    expect(classifyRequestSpans("o que tem no meu carrinho?")).not.toContain("MENU_OVERVIEW_Q");
  });

  it("★ BKL-273 — an allergen-marked overview ask KEEPS its span (the guard is on the READ)", () => {
    // INVERTED from the pre-BKL-273 assertion, deliberately. Suppressing this span
    // did not route the question to the conservative abstain: it left the turn with
    // NO read span, so §O#15 had nothing to complete and the REAL responder authored
    // the dietary answer itself (measured at the customer seam, BKL-270). The span
    // must fire so the question stays accounted for; the refusal happens in
    // `resolveMenuOverviewText`, which returns undefined for exactly this predicate.
    const text = "o cardápio tem algo com glúten?";
    expect(classifyRequestSpans(text)).toContain("MENU_OVERVIEW_Q");
    expect(isAllergenFamilyAsk(text)).toBe(true);
  });

  it("the overview span requires ONLY MENU_OVERVIEW", () => {
    expect(REQUIRED_CLAIM_CLOSURE.MENU_OVERVIEW_Q).toEqual(["MENU_OVERVIEW"]);
  });

  // ── BKL-205 half 2, the MUST-NOT-BREAK half ───────────────────────────────────
  // The locative lookahead narrows the BARE interrogative arm ONLY. Every genuine
  // whole-menu phrasing must survive it, and each survives by a DIFFERENT route —
  // which is the point of listing them separately rather than as one loop:
  //   · "no cardápio" / "no menu" survive via the INDEPENDENT `\bcard[áa]pio\b` /
  //     `\bmenu\b` alternatives, which are evaluated ahead of the lookahead. These
  //     two are the cases that would break if someone "simplified" the regex by
  //     hanging the lookahead off the whole pattern instead of the bare arm.
  //   · the rest carry no locative at all, so the lookahead never engages.
  it("BKL-205 — the whole-menu phrasings all SURVIVE the locative narrowing", () => {
    // …via the cardápio/menu arms, DESPITE carrying a locative complement.
    expect(classifyRequestSpans("o que tem no cardápio?")).toContain("MENU_OVERVIEW_Q");
    expect(classifyRequestSpans("o que tem no menu de hoje?")).toContain(
      "MENU_OVERVIEW_Q",
    );
    // …and via having no locative at all.
    expect(classifyRequestSpans("o que vocês têm?")).toContain("MENU_OVERVIEW_Q");
    expect(classifyRequestSpans("o que tem pra comer?")).toContain("MENU_OVERVIEW_Q");
    expect(classifyRequestSpans("o que vocês servem?")).toContain("MENU_OVERVIEW_Q");
    // A `de` complement is deliberately NOT excluded — a CATEGORY ask is an
    // overview, not an item. Pinned so a future widening to "any complement" has
    // to argue with a test instead of sliding through.
    expect(classifyRequestSpans("o que vocês têm de sobremesa?")).toContain(
      "MENU_OVERVIEW_Q",
    );
    expect(classifyRequestSpans("o que tem de bebida?")).toContain("MENU_OVERVIEW_Q");
  });

  // The narrowing must not leak into the OTHER families that own "o que tem no …".
  it("BKL-205 — the cart family still owns 'o que tem no meu carrinho?'", () => {
    const spans = classifyRequestSpans("o que tem no meu carrinho?");
    expect(spans).toContain("CART_CONTENTS_Q");
    expect(spans).not.toContain("MENU_ITEM_CONTENTS_Q");
    expect(spans).not.toContain("MENU_OVERVIEW_Q");
  });

  // …and the cart SYNONYM, which the vocabulary sweep flagged as the one cart
  // phrasing that carries NONE of the `notOrderScoped` words
  // (`pedido|carrinho|entrega|frete`), so a menu span is not held off it by that
  // guard. The cart span is what must own the turn, and it still does.
  //
  // The menu-span half MOVED here and the direction is worth stating: before this
  // ticket it was MENU_OVERVIEW_Q, which VALIDATES and renders the whole
  // catalogue alongside the cart; now it is the per-item span, whose subject
  // cannot resolve → ABSENT evidence → honest UNKNOWN → dropped by the kernel's
  // §D filter. A spurious confident answer became a spurious silent one.
  it("BKL-205 — the cart SYNONYM 'cesta' keeps its own span (and loses a spurious menu render)", () => {
    const spans = classifyRequestSpans("o que tem na cesta?");
    expect(spans).toContain("CART_CONTENTS_Q");
    expect(spans).not.toContain("MENU_OVERVIEW_Q");
  });

  // BKL-201/271 — the mutation gate sits UPSTREAM of both menu spans, so the
  // narrowing cannot hand a write turn to the per-item read either.
  it("BKL-205 — a mutation still fires NEITHER menu span (the read-vs-write split holds)", () => {
    const spans = classifyRequestSpans("tira o brisket do carrinho");
    expect(spans).not.toContain("MENU_ITEM_CONTENTS_Q");
    expect(spans).not.toContain("MENU_OVERVIEW_Q");
  });
});


describe("BKL-214 MENU_DIETARY — dietary-PREFERENCE claim (vegetariano/vegano only)", () => {
  it("is a registered, renderable claim type with a single-proposition validated template", () => {
    expect(isRegistryClaimType("MENU_DIETARY")).toBe(true);
    expect(CLAIM_REGISTRY).toContain("MENU_DIETARY");
    const spec = REGISTRY_SPECS.MENU_DIETARY;
    expect(spec.kind).toBe("read_claim");
    expect(spec.perResourceKey).toBe(true); // PUBLIC per-item, subject = the dietary tag
    expect(spec.customerScoped).toBe(false);
    expect(spec.valueBinding).toEqual({ key: "menu:dietary", path: ["dietaryText"] });
    const tpl = VALIDATED_TEMPLATES.MENU_DIETARY;
    expect(tpl.posture).toBe("validated");
    expect(tpl.slots).toHaveLength(1); // exactly ONE proposition slot (Inv 6)
  });

  it("REQUIRED_CLAIM_CLOSURE maps MENU_DIETARY_Q → MENU_DIETARY", () => {
    expect(REQUIRED_CLAIM_CLOSURE.MENU_DIETARY_Q).toEqual(["MENU_DIETARY"]);
  });

  it("restricts the renderable tags to pure PREFERENCE — vegetariano/vegano ONLY (no allergen-adjacent diets)", () => {
    expect([...DIETARY_PREFERENCE_TAGS].sort()).toEqual(["vegano", "vegetariano"]);
    expect(DIETARY_PREFERENCE_TAGS as readonly string[]).not.toContain("sem_gluten");
    expect(DIETARY_PREFERENCE_TAGS as readonly string[]).not.toContain("sem_lactose");
  });

  it("detects the dietary-preference tag deterministically (disjoint vegan/vegetarian stems)", () => {
    expect(detectDietaryPreferenceTags("tem opção vegetariana?")).toEqual(["vegetariano"]);
    expect(detectDietaryPreferenceTags("vocês têm prato vegano?")).toEqual(["vegano"]);
    expect(detectDietaryPreferenceTags("é vegetariano ou vegano?")).toContain("vegetariano");
    expect(detectDietaryPreferenceTags("é vegetariano ou vegano?")).toContain("vegano");
    expect(detectDietaryPreferenceTags("quanto custa a costela?")).toEqual([]);
    // "vegano" stem must NOT match inside "vegetariano" and vice-versa.
    expect(detectDietaryPreferenceTags("tem prato vegetariano?")).toEqual(["vegetariano"]);
  });

  describe("span classification", () => {
    it("a dietary-preference question fires MENU_DIETARY_Q", () => {
      expect(classifyRequestSpans("tem opção vegetariana?")).toContain("MENU_DIETARY_Q");
      expect(classifyRequestSpans("vocês têm prato vegano?")).toContain("MENU_DIETARY_Q");
    });

    it("★ the allergen boundary — a PURE allergen ask never fires MENU_DIETARY_Q", () => {
      // These carry no vegetarian/vegano stem at all, so the span simply does not
      // match. That is a VOCABULARY fact and is untouched by BKL-273.
      expect(classifyRequestSpans("tem opção sem glúten?")).not.toContain("MENU_DIETARY_Q");
      expect(classifyRequestSpans("tem prato sem lactose?")).not.toContain("MENU_DIETARY_Q");
    });

    it("★ BKL-273 — a MIXED vegetarian+allergen ask KEEPS its span (the guard is on the READ)", () => {
      // INVERTED from the pre-BKL-273 assertion. The old code declined the span
      // wholesale, which dropped the turn off the deterministic path and let the
      // model answer the "sem glúten" half in prose — worse than the render it was
      // trying to prevent. The span now fires so §O#15 still owns the question, and
      // `resolveDietaryOptionsText` returns undefined for this predicate, degrading
      // to the BKL-184 abstain + staff handoff.
      const text = "tem opção vegetariana sem glúten?";
      expect(classifyRequestSpans(text)).toContain("MENU_DIETARY_Q");
      expect(isAllergenFamilyAsk(text)).toBe(true);
    });

    it("an imperative cart mutation near a dietary word routes to the mutation path, not the read", () => {
      expect(classifyRequestSpans("tira o prato vegetariano do carrinho")).not.toContain("MENU_DIETARY_Q");
    });

    it("a non-dietary question does not fire MENU_DIETARY_Q", () => {
      expect(classifyRequestSpans("o que tem no cardápio?")).not.toContain("MENU_DIETARY_Q");
      expect(classifyRequestSpans("quanto custa a costela?")).not.toContain("MENU_DIETARY_Q");
    });
  });

  describe("composeDietaryOptionsText — deterministic first-party list, never an allergen assurance", () => {
    const veg = [
      { title: "Farofa de Bacon", categoryHandle: "acompanhamentos" },
      { title: "Salada Verde", categoryHandle: "acompanhamentos" },
    ];
    it("composes a pt-BR list of tagged product titles (deterministic, sorted)", () => {
      const text = composeDietaryOptionsText("vegetariano", veg)!;
      expect(text).toBe("Temos estas opções vegetarianas: Farofa de Bacon; Salada Verde.");
    });
    it("uses the correct tag label for vegano", () => {
      expect(composeDietaryOptionsText("vegano", [{ title: "Salada Verde", categoryHandle: "acompanhamentos" }])!)
        .toBe("Temos estas opções veganas: Salada Verde.");
    });
    it("★ NEVER renders a 'não contém'/allergen assurance — a positive preference list only", () => {
      const text = composeDietaryOptionsText("vegetariano", veg)!;
      expect(text.toLowerCase()).not.toContain("não contém");
      expect(text.toLowerCase()).not.toContain("sem glúten");
      expect(text.toLowerCase()).not.toContain("sem lactose");
      expect(text.toLowerCase()).not.toContain("seguro");
    });
    it("returns undefined when NO product carries the tag → honest UNKNOWN (never a fabricated option)", () => {
      expect(composeDietaryOptionsText("vegetariano", [])).toBeUndefined();
    });
    it("order-independent of the input (investigator + planner compose byte-equal)", () => {
      const shuffled = [veg[1]!, veg[0]!];
      expect(composeDietaryOptionsText("vegetariano", shuffled)).toBe(composeDietaryOptionsText("vegetariano", veg));
    });
    it("drops merch from the list (food-only, like the overview)", () => {
      const withMerch = [...veg, { title: "Camiseta Vegana", categoryHandle: "camisetas" }];
      const text = composeDietaryOptionsText("vegetariano", withMerch)!;
      expect(text).not.toContain("Camiseta");
    });
  });
});
