// seed-cart-with-items.test.ts — BKL-186: the pure items-spec parser + the
// no-IO preconditions. The live Medusa/Redis round-trip is the SAME governed
// path seed-item-cart.ts already runs (store API cart + rk session binding);
// the smoke proof rides the live stack, not vitest (house seeder convention).

import { describe, expect, it } from "vitest"
import {
  parseItemsSpec,
  seedCartWithItems,
  SeedCartWithItemsError,
} from "../seed-cart-with-items.js"

describe("parseItemsSpec — handle[:qty[:variantTitle]] entries", () => {
  it("parses a plain handle with qty defaulting to 1", () => {
    expect(parseItemsSpec("mandioca-frita")).toEqual([
      { productHandle: "mandioca-frita", quantity: 1 },
    ])
  })

  it("parses handle:qty pairs and multiple comma-separated entries", () => {
    expect(parseItemsSpec("refrigerante:2, mandioca-frita:1")).toEqual([
      { productHandle: "refrigerante", quantity: 2 },
      { productHandle: "mandioca-frita", quantity: 1 },
    ])
  })

  it("parses the optional trailing variantTitle (which may itself contain colons)", () => {
    expect(parseItemsSpec("refrigerante:2:Guaraná Antarctica")).toEqual([
      { productHandle: "refrigerante", quantity: 2, variantTitle: "Guaraná Antarctica" },
    ])
    expect(parseItemsSpec("x:1:A:B")).toEqual([
      { productHandle: "x", quantity: 1, variantTitle: "A:B" },
    ])
  })

  it("empty qty segment keeps the default (handle::Variant)", () => {
    expect(parseItemsSpec("refrigerante::Coca-Cola")).toEqual([
      { productHandle: "refrigerante", quantity: 1, variantTitle: "Coca-Cola" },
    ])
  })

  it("rejects an empty spec, an empty entry, and a non-positive/NaN qty", () => {
    expect(() => parseItemsSpec("")).toThrow(SeedCartWithItemsError)
    expect(() => parseItemsSpec("a:1,,b:2")).toThrow(SeedCartWithItemsError)
    expect(() => parseItemsSpec("a:0")).toThrow(SeedCartWithItemsError)
    expect(() => parseItemsSpec("a:x")).toThrow(SeedCartWithItemsError)
  })
})

describe("seedCartWithItems — no-IO preconditions", () => {
  it("rejects an empty items list BEFORE touching Medusa/Redis", async () => {
    await expect(
      seedCartWithItems({ sessionId: "sess-1", items: [] }),
    ).rejects.toBeInstanceOf(SeedCartWithItemsError)
  })
})
