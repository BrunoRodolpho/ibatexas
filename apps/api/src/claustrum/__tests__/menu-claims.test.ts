// BKL-142 — the menu claim chain (MENU_ITEM_PRICE / MENU_ITEM_CONTENTS) on the shared
// resolver. Deterministic; no live model. Pins the registry shape (public / perResource
// / deliberately-unread falsifier / scalar valueBinding), the single-proposition
// templates, the deterministic scalar composers (Hard Rule #2 money), and the
// decomposer span classification (fires on menu questions, disjoint from cart / order /
// allergen families).

import { describe, it, expect } from "vitest";
import { CLAIM_REGISTRY, REGISTRY_SPECS, isRegistryClaimType } from "../claim-registry.js";
import { VALIDATED_TEMPLATES } from "../slot-grammar.js";
import { classifyRequestSpans, REQUIRED_CLAIM_CLOSURE } from "../required-claim-decomposer.js";
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
    expect(composeMenuContentsText(item())).toBe("Costela Defumada: Costela bovina defumada 12h.");
  });

  it("contentsText is undefined when the catalog has no description → honest UNKNOWN, never fabricated", () => {
    expect(composeMenuContentsText(item({ description: null }))).toBeUndefined();
    expect(composeMenuContentsText(item({ description: "   " }))).toBeUndefined();
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

  it("does NOT sweep in cart/order/allergen questions", () => {
    expect(classifyRequestSpans("o que tem no meu carrinho?")).not.toContain("MENU_OVERVIEW_Q");
    expect(classifyRequestSpans("o cardápio tem algo com glúten?")).not.toContain("MENU_OVERVIEW_Q");
  });

  it("the overview span requires ONLY MENU_OVERVIEW", () => {
    expect(REQUIRED_CLAIM_CLOSURE.MENU_OVERVIEW_Q).toEqual(["MENU_OVERVIEW"]);
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

    it("★ the allergen boundary — an allergen-adjacent diet NEVER fires MENU_DIETARY_Q (routes to the conservative abstain path)", () => {
      // "sem glúten"/"sem lactose" trip ALLERGEN_FAMILY_RE (glúten|lactose) → excluded.
      expect(classifyRequestSpans("tem opção sem glúten?")).not.toContain("MENU_DIETARY_Q");
      expect(classifyRequestSpans("tem prato sem lactose?")).not.toContain("MENU_DIETARY_Q");
      // A mixed ask (vegetarian + allergen) also declines wholesale — safety wins.
      expect(classifyRequestSpans("tem opção vegetariana sem glúten?")).not.toContain("MENU_DIETARY_Q");
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
