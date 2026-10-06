// Tests for the shared menu-item resolver (BKL-142). Proves the two load-bearing
// properties: the lexical-overlap floor (no confident wrong answer on a fuzzy hit)
// and the per-turn memo (the same-resolver-same-text invariant that keeps the claim
// planner's subject and the investigator's evidence key in lockstep within a turn).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchProductsMock = vi.hoisted(() => vi.fn());
vi.mock("@ibatexas/tools", () => ({
  searchProducts: (input: unknown, ctx: unknown) => searchProductsMock(input, ctx),
}));

const {
  resolveMenuItem,
  __resetMenuItemMemoForTest,
  resolveMenuOverviewText,
  __resetMenuOverviewMemoForTest,
  resolveDietaryOptionsText,
  __resetMenuDietaryMemoForTest,
  composeMenuContentsText,
} = await import("../menu-item-resolver.js");

const product = (overrides: Record<string, unknown> = {}) => ({
  id: "prod_coke",
  title: "Coca-Cola 350ml",
  price: 800,
  description: "Refrigerante gelado 350ml",
  categoryHandle: "bebidas",
  inStock: true,
  tags: [] as string[],
  ...overrides,
});

const CTX = { channel: "web", sessionId: "sess-1", customerId: "c1" };

beforeEach(() => {
  __resetMenuItemMemoForTest();
  __resetMenuOverviewMemoForTest();
  searchProductsMock.mockReset();
});
afterEach(() => {
  __resetMenuItemMemoForTest();
  __resetMenuOverviewMemoForTest();
});

// ── MENU_OVERVIEW read (fixed subject, wildcard listing) ────────────────────────
describe("resolveMenuOverviewText — wildcard listing, per-turn memo, fail-closed", () => {
  it("reads the wildcard catalog and composes a bounded first-party overview scalar", async () => {
    searchProductsMock.mockResolvedValue({
      products: [
        product({ id: "p1", title: "Costela", price: 8900, categoryHandle: "carnes" }),
        product({ id: "p2", title: "Farofa", price: 1500, categoryHandle: "acompanhamentos" }),
      ],
    });
    const text = await resolveMenuOverviewText("turn-1", "o que tem no cardápio?", CTX);
    expect(text).toBe("No nosso cardápio: Farofa — R$ 15,00; Costela — R$ 89,00.");
    // The wildcard path — same source the catalog route uses.
    expect(searchProductsMock.mock.calls[0]![0]).toMatchObject({ query: "*" });
  });

  it("memoizes on turnId: two calls in the same turn coalesce onto ONE read (byte-equal)", async () => {
    searchProductsMock.mockResolvedValue({ products: [product({ title: "Costela", price: 8900 })] });
    const a = await resolveMenuOverviewText("turn-1", "o que tem no cardápio?", CTX);
    const b = await resolveMenuOverviewText("turn-1", "o que tem no cardápio?", CTX);
    expect(a).toBe(b);
    expect(searchProductsMock).toHaveBeenCalledTimes(1);
  });

  it("empty catalog → undefined (honest UNKNOWN, never a fabricated menu)", async () => {
    searchProductsMock.mockResolvedValue({ products: [] });
    expect(await resolveMenuOverviewText("turn-1", "o que tem no cardápio?", CTX)).toBeUndefined();
  });

  it("catalog read error → undefined (fail-closed)", async () => {
    searchProductsMock.mockRejectedValue(new Error("typesense down"));
    expect(await resolveMenuOverviewText("turn-1", "o que tem no cardápio?", CTX)).toBeUndefined();
  });
});

// ── BKL-273 — the READ-level allergen guards ───────────────────────────────────
// The three MENU reads whose span-suppression this ticket removed. Each proves the
// SAME shape LE2-029 proved for the pairing read: an allergen/diet-marked ask gets
// NO answer FROM THE READ (so the span survives and §O#15 keeps the question), and
// the identical ask WITHOUT the marker still answers — which is what makes the
// negative directional rather than a dead feature.
describe("BKL-273 — allergen-marked MENU reads refuse at the READ", () => {
  it("resolveMenuOverviewText: allergen ask → undefined, and NEVER touches the catalog", async () => {
    searchProductsMock.mockResolvedValue({
      products: [product({ title: "Costela", price: 8900, categoryHandle: "carnes" })],
    });
    expect(
      await resolveMenuOverviewText("turn-a", "o que tem no cardápio sem lactose?", CTX),
    ).toBeUndefined();
    // The guard is BEFORE the memo and before the egress: no listing is even read,
    // so nothing this turn must not hold can be cached.
    expect(searchProductsMock).not.toHaveBeenCalled();
  });

  it("resolveMenuOverviewText: THE CONTROL — the same turn's unmarked ask still answers", async () => {
    searchProductsMock.mockResolvedValue({
      products: [product({ title: "Costela", price: 8900, categoryHandle: "carnes" })],
    });
    expect(await resolveMenuOverviewText("turn-b", "o que tem no cardápio?", CTX)).toBe(
      "No nosso cardápio: Costela — R$ 89,00.",
    );
  });

  it("resolveDietaryOptionsText: a MIXED vegetarian+allergen ask → undefined", async () => {
    __resetMenuDietaryMemoForTest();
    searchProductsMock.mockResolvedValue({
      products: [product({ title: "Salada", price: 2500, tags: ["vegetariano"] })],
    });
    expect(
      await resolveDietaryOptionsText(
        "turn-c",
        "vegetariano",
        "tem opção vegetariana sem glúten?",
        CTX,
      ),
    ).toBeUndefined();
    expect(searchProductsMock).not.toHaveBeenCalled();
  });

  it("resolveDietaryOptionsText: THE CONTROL — the unmarked dietary ask still answers", async () => {
    __resetMenuDietaryMemoForTest();
    searchProductsMock.mockResolvedValue({
      products: [product({ title: "Salada", price: 2500, tags: ["vegetariano"] })],
    });
    const out = await resolveDietaryOptionsText(
      "turn-d",
      "vegetariano",
      "tem opção vegetariana?",
      CTX,
    );
    expect(out).toBeDefined();
    expect(out).toContain("Salada");
  });

  it("composeMenuContentsText: allergen ask → undefined even with a full description", () => {
    const item = {
      id: "prod_1",
      title: "Costela Defumada",
      price: 8900,
      description: "Costela bovina defumada 12h.",
      categoryHandle: "carnes",
      inStock: true,
    };
    expect(composeMenuContentsText(item, "o que vem na costela sem glúten?")).toBeUndefined();
    // THE CONTROL: identical item, marker removed → the first-party blurb composes.
    expect(composeMenuContentsText(item, "o que vem na costela?")).toBe(
      "Costela Defumada: Costela bovina defumada 12h.",
    );
  });
});

describe("resolveMenuItem — lexical-overlap floor", () => {
  it("resolves a lexically-related product to the first-party fields", async () => {
    searchProductsMock.mockResolvedValue({ products: [product()] });
    const r = await resolveMenuItem("turn-1", "coca cola", CTX);
    expect(r).toEqual({
      id: "prod_coke",
      title: "Coca-Cola 350ml",
      price: 800,
      description: "Refrigerante gelado 350ml",
      categoryHandle: "bebidas",
      inStock: true,
    });
  });

  it("accepts a partial/substring match (a shared token is enough — 'coca' ⊂ 'Coca-Cola')", async () => {
    searchProductsMock.mockResolvedValue({ products: [product()] });
    const r = await resolveMenuItem("turn-1", "coca", CTX);
    expect(r?.id).toBe("prod_coke");
  });

  it("REJECTS an unrelated fuzzy top hit → undefined (no confident wrong price)", async () => {
    // Typesense still returns SOMETHING for a nonsense query; the floor collapses it.
    searchProductsMock.mockResolvedValue({
      products: [product({ id: "prod_costela", title: "Costela Bovina Defumada", price: 8900 })],
    });
    const r = await resolveMenuItem("turn-1", "xyzzy", CTX);
    expect(r).toBeUndefined();
  });

  it("returns undefined on an empty result set (honest no-match)", async () => {
    searchProductsMock.mockResolvedValue({ products: [] });
    expect(await resolveMenuItem("turn-1", "coca", CTX)).toBeUndefined();
  });

  it("returns undefined (fail-closed) when the catalog read throws — never an arbitrary product", async () => {
    searchProductsMock.mockRejectedValue(new Error("typesense down"));
    expect(await resolveMenuItem("turn-1", "coca", CTX)).toBeUndefined();
  });

  it("returns undefined for empty/whitespace text WITHOUT reading the catalog", async () => {
    expect(await resolveMenuItem("turn-1", "   ", CTX)).toBeUndefined();
    expect(searchProductsMock).not.toHaveBeenCalled();
  });
});

describe("resolveMenuItem — per-turn memo (same-resolver-same-text invariant)", () => {
  it("coalesces two same-turn same-text calls onto ONE catalog read, identical result", async () => {
    searchProductsMock.mockResolvedValue({ products: [product()] });
    const [a, b] = await Promise.all([
      resolveMenuItem("turn-1", "coca cola", CTX),
      resolveMenuItem("turn-1", "coca cola", CTX),
    ]);
    expect(a).toEqual(b);
    expect(a?.id).toBe("prod_coke");
    expect(searchProductsMock).toHaveBeenCalledTimes(1); // the planner + investigator share ONE read
  });

  it("shares a memo entry across textually-equivalent references (normalization)", async () => {
    searchProductsMock.mockResolvedValue({ products: [product()] });
    await resolveMenuItem("turn-1", "Coca  Cola", CTX);
    await resolveMenuItem("turn-1", "coca cola", CTX);
    expect(searchProductsMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT share across different turns (memo is turn-scoped, never leaks)", async () => {
    searchProductsMock.mockResolvedValue({ products: [product()] });
    await resolveMenuItem("turn-1", "coca cola", CTX);
    await resolveMenuItem("turn-2", "coca cola", CTX);
    expect(searchProductsMock).toHaveBeenCalledTimes(2);
  });

  it("a within-turn result is stable even if the catalog would rank differently on a re-read", async () => {
    // First (and only) read wins for the whole turn — the planner subject and the
    // investigator evidence key can never disagree.
    searchProductsMock
      .mockResolvedValueOnce({ products: [product({ id: "prod_a", title: "Coca-Cola" })] })
      .mockResolvedValueOnce({ products: [product({ id: "prod_b", title: "Coca-Cola Zero" })] });
    const first = await resolveMenuItem("turn-1", "coca cola", CTX);
    const second = await resolveMenuItem("turn-1", "coca cola", CTX);
    expect(first?.id).toBe("prod_a");
    expect(second?.id).toBe("prod_a"); // memoized — the second (divergent) read never happened
    expect(searchProductsMock).toHaveBeenCalledTimes(1);
  });
});
