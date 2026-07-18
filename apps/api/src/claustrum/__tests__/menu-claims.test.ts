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
