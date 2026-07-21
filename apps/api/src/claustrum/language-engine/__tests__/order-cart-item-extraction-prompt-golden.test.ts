// order-cart-item-extraction-prompt-golden.test.ts — the FE-T14 golden
// BYTE-IDENTITY gate for the pack-orders cart/item family (order.cart.
// ensure, order.item.add, order.item.update, order.item.remove,
// order.coupon.apply).
//
// Mirrors order-amend-granular-extraction-prompt-golden.test.ts's
// methodology exactly — ONE fixture for the whole related group (all five
// are composed through the same `buildToolSurface` branch and always
// appear together in the customer planner's allowed-intent set).
//
// To regenerate after an intentional change:
//
//   npx tsx -e "
//     import { computeOrderCartItemExtractionPromptFragment } from
//       './src/claustrum/language-engine/__tests__/order-cart-item-extraction-prompt-fragment-support.ts';
//     import { writeFileSync } from 'node:fs';
//     computeOrderCartItemExtractionPromptFragment().then(f =>
//       writeFileSync(
//         'src/claustrum/language-engine/__tests__/__golden__/order-cart-item.extraction-prompt-fragment.json',
//         JSON.stringify(f, null, 2) + '\n',
//       ));
//   "  (run from apps/api/), then `ibx journey extraction-consistency --update-binding`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeOrderCartItemExtractionPromptFragment,
  type OrderCartItemExtractionPromptFragment,
} from "./order-cart-item-extraction-prompt-fragment-support.js";

const GOLDEN_PATH = fileURLToPath(
  new URL("./__golden__/order-cart-item.extraction-prompt-fragment.json", import.meta.url),
);

function readGoldenRaw(): string {
  return readFileSync(GOLDEN_PATH, "utf8");
}

function canonicalize(fragment: OrderCartItemExtractionPromptFragment): string {
  return JSON.stringify(fragment, null, 2) + "\n";
}

describe("extraction-prompt golden byte-identity gate (order.cart.ensure/item.add/item.update/item.remove/coupon.apply, FE-T14)", () => {
  it("GREEN: the freshly-composed fragment is byte-identical to the committed golden fixture", async () => {
    const fresh = await computeOrderCartItemExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });

  it("exposes ONLY the model-extractable fields per capability — never cartId/variantId/itemId/allergens", async () => {
    const fresh = await computeOrderCartItemExtractionPromptFragment();
    const schema = fresh.expressIntentTool.inputSchema as {
      allOf: Array<{
        if: { properties: { capability: { const: string } } };
        then: { properties: { payload: { properties: Record<string, unknown>; required?: string[] } } };
      }>;
    };
    expect(schema.allOf).toHaveLength(5);
    const byCapability = new Map(
      schema.allOf.map((clause) => [
        clause.if.properties.capability.const,
        clause.then.properties.payload,
      ]),
    );
    expect([...byCapability.keys()].sort()).toEqual([
      "order.cart.ensure",
      "order.coupon.apply",
      "order.item.add",
      "order.item.remove",
      "order.item.update",
    ]);
    for (const payload of byCapability.values()) {
      const keys = Object.keys(payload.properties);
      expect(keys).not.toContain("cartId");
      expect(keys).not.toContain("variantId");
      expect(keys).not.toContain("itemId");
      expect(keys).not.toContain("allergens");
    }
    expect(byCapability.get("order.cart.ensure")!.properties).toEqual({});
    expect(byCapability.get("order.item.add")!.required).toEqual(["item"]);
    expect(byCapability.get("order.item.update")!.required).toEqual(["item", "quantity"]);
    expect(byCapability.get("order.item.remove")!.required).toEqual(["item"]);
    expect(byCapability.get("order.coupon.apply")!.required).toEqual(["code"]);
  });

  it("RED: a mutated wire schema (an extra leaked field) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computeOrderCartItemExtractionPromptFragment();
    const mutated: OrderCartItemExtractionPromptFragment = JSON.parse(
      JSON.stringify(fresh),
    ) as OrderCartItemExtractionPromptFragment;
    const schema = mutated.expressIntentTool.inputSchema as {
      allOf: Array<{ then: { properties: { payload: { properties: Record<string, unknown> } } } }>;
    };
    schema.allOf[0]!.then.properties.payload.properties.cartId = {
      type: "string",
      description: "x",
    };
    expect(canonicalize(mutated)).not.toBe(readGoldenRaw());
  });

  it("REVERT: an unmutated fresh computation is byte-identical again (the gate is not permanently red)", async () => {
    const fresh = await computeOrderCartItemExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });
});
