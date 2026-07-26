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
import { EXTRACTION_SCHEMAS_BY_CAPABILITY } from "../wire-schemas.js";
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

  // BKL-255a — this used to read each capability's payload schema back off the
  // `express_intent` wire surface (the `allOf` clauses). Those are gone: the
  // engine dropped them at decode (LE2-004), so the planner no longer sends
  // them. The per-capability field inventory is still live and still
  // load-bearing — `ALLOWED_PAYLOAD_FIELD_NAMES_BY_CAPABILITY` derives the
  // parse-seam filter from it — so this now reads the AUTHORED registry,
  // keyed by the fragment's OWN capability list.
  it("the authored schemas expose ONLY the model-extractable fields per capability — never cartId/variantId/itemId/allergens", async () => {
    const fresh = await computeOrderCartItemExtractionPromptFragment();
    const byCapability = new Map(
      fresh.capabilities.map((kind) => [
        kind,
        EXTRACTION_SCHEMAS_BY_CAPABILITY.get(kind) as {
          properties: Record<string, unknown>;
          required?: string[];
        },
      ]),
    );
    expect(byCapability.size).toBe(5);
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

  it("RED: a mutated wire schema (an extra capability in the enum) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computeOrderCartItemExtractionPromptFragment();
    const mutated: OrderCartItemExtractionPromptFragment = JSON.parse(
      JSON.stringify(fresh),
    ) as OrderCartItemExtractionPromptFragment;
    const schema = mutated.expressIntentTool.inputSchema as {
      properties: { capability: { enum: string[] } };
    };
    // BKL-255a — the payload sub-schema this used to mutate is no longer on the
    // wire; the capability enum still is, and is still what a rollout slice
    // drifts, so mutating it keeps this gate genuinely sensitive.
    schema.properties.capability.enum.push("order.status.transition");
    expect(canonicalize(mutated)).not.toBe(readGoldenRaw());
  });

  it("REVERT: an unmutated fresh computation is byte-identical again (the gate is not permanently red)", async () => {
    const fresh = await computeOrderCartItemExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });
});
