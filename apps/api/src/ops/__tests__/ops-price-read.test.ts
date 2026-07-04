// ops-price-read — NEW-004 admin catalog pricing read + snapshot mapping.

import { describe, expect, it, vi } from "vitest";
import {
  readOpsProductPricing,
  computeOpsPricingSnapshot,
  type OpsProductPricingRead,
} from "../ops-price-read.js";

/** A Medusa admin GET fake returning a product with the given variants/prices. */
function fakeAdmin(product: unknown) {
  return vi.fn(async (_path: string) => ({ product }));
}

describe("readOpsProductPricing — admin catalog read (reais → centavos)", () => {
  it("projects id/status/name + BRL variant prices in centavos (× 100)", async () => {
    const admin = fakeAdmin({
      id: "prod_1",
      title: "Picanha",
      status: "published",
      variants: [
        { id: "v1", prices: [{ amount: 89, currency_code: "brl" }] },
        { id: "v2", prices: [{ amount: 165, currency_code: "brl" }] },
      ],
    });
    const read = await readOpsProductPricing(admin, "prod_1");
    expect(admin).toHaveBeenCalledWith(
      "/admin/products/prod_1?expand=variants,variants.prices",
    );
    expect(read).toEqual({
      id: "prod_1",
      status: "published",
      name: "Picanha",
      brlVariants: [
        { variantId: "v1", priceCentavos: 8900 },
        { variantId: "v2", priceCentavos: 16500 },
      ],
    });
  });

  it("excludes variants with no BRL price (other currency / missing)", async () => {
    const admin = fakeAdmin({
      id: "prod_1",
      title: "Combo",
      status: "published",
      variants: [
        { id: "v1", prices: [{ amount: 42, currency_code: "brl" }] },
        { id: "v2", prices: [{ amount: 10, currency_code: "usd" }] },
        { id: "v3", prices: [] },
      ],
    });
    const read = await readOpsProductPricing(admin, "prod_1");
    expect(read!.brlVariants).toEqual([{ variantId: "v1", priceCentavos: 4200 }]);
  });

  it("returns null when the product is absent", async () => {
    const admin = vi.fn(async () => ({}));
    expect(await readOpsProductPricing(admin, "ghost")).toBeNull();
  });

  it("rounds fractional reais to the nearest centavo", async () => {
    const admin = fakeAdmin({
      id: "p",
      title: "Suco",
      status: "published",
      variants: [{ id: "v", prices: [{ amount: 12.34, currency_code: "brl" }] }],
    });
    const read = await readOpsProductPricing(admin, "p");
    expect(read!.brlVariants[0]!.priceCentavos).toBe(1234);
  });
});

describe("computeOpsPricingSnapshot — displayed price + divergent flag", () => {
  const base = (
    brlVariants: OpsProductPricingRead["brlVariants"],
  ): OpsProductPricingRead => ({
    id: "prod_1",
    status: "published",
    name: "Picanha",
    brlVariants,
  });

  it("single variant → uniform, currentPrice = that price", () => {
    expect(computeOpsPricingSnapshot(base([{ variantId: "v", priceCentavos: 8900 }]))).toEqual({
      id: "prod_1",
      status: "published",
      name: "Picanha",
      currentPriceCentavos: 8900,
      divergentVariantPrices: false,
    });
  });

  it("multi-variant SAME price → uniform, currentPrice = the shared price", () => {
    const snap = computeOpsPricingSnapshot(
      base([
        { variantId: "p", priceCentavos: 6900 },
        { variantId: "m", priceCentavos: 6900 },
        { variantId: "g", priceCentavos: 6900 },
      ]),
    );
    expect(snap!.divergentVariantPrices).toBe(false);
    expect(snap!.currentPriceCentavos).toBe(6900);
  });

  it("multi-variant DIFFERENT price → divergent, currentPrice = the MIN (displayed)", () => {
    const snap = computeOpsPricingSnapshot(
      base([
        { variantId: "500g", priceCentavos: 8900 },
        { variantId: "1kg", priceCentavos: 16500 },
      ]),
    );
    expect(snap!.divergentVariantPrices).toBe(true);
    expect(snap!.currentPriceCentavos).toBe(8900);
  });

  it("null read → null snapshot", () => {
    expect(computeOpsPricingSnapshot(null)).toBeNull();
  });

  it("no BRL-priced variant → null snapshot (not priceable by message)", () => {
    expect(computeOpsPricingSnapshot(base([]))).toBeNull();
  });
});
