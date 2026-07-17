// order-amend-granular-extraction-prompt-golden.test.ts — the FE-T14
// BACKFILL golden BYTE-IDENTITY gate for the three FE-T09 granular
// post-checkout amend kinds (order.amend.add_item / update_qty /
// remove_item).
//
// FE-T09 authored these schemas + registered them on the wire but never
// pinned a golden fragment or a schema-binding entry for them (unlike
// order.status.transition/payment.refund.issue, which got both from
// birth) — this closes that gap, mirroring the FE-T13 read-tool-roster
// golden idiom: ONE fixture for the whole related group (they are all
// composed through the exact same `buildToolSurface` branch, and always
// appear together in the customer planner's allowed-intent set — see
// surfaces.json), not one file per capability.
//
// NO persona excerpt — see order-amend-granular-extraction-prompt-
// fragment-support.ts's header for why (PLANNER_PERSONA, unlike
// OPS_PLANNER_PERSONA, has no per-capability paragraph structure).
//
// To regenerate after an intentional change:
//
//   npx tsx -e "
//     import { computeOrderAmendGranularExtractionPromptFragment } from
//       './src/claustrum/language-engine/__tests__/order-amend-granular-extraction-prompt-fragment-support.ts';
//     import { writeFileSync } from 'node:fs';
//     computeOrderAmendGranularExtractionPromptFragment().then(f =>
//       writeFileSync(
//         'src/claustrum/language-engine/__tests__/__golden__/order-amend-granular.extraction-prompt-fragment.json',
//         JSON.stringify(f, null, 2) + '\n',
//       ));
//   "  (run from apps/api/), then `ibx journey extraction-consistency --update-binding`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeOrderAmendGranularExtractionPromptFragment,
  type OrderAmendGranularExtractionPromptFragment,
} from "./order-amend-granular-extraction-prompt-fragment-support.js";

const GOLDEN_PATH = fileURLToPath(
  new URL("./__golden__/order-amend-granular.extraction-prompt-fragment.json", import.meta.url),
);

function readGoldenRaw(): string {
  return readFileSync(GOLDEN_PATH, "utf8");
}

function canonicalize(fragment: OrderAmendGranularExtractionPromptFragment): string {
  return JSON.stringify(fragment, null, 2) + "\n";
}

describe("extraction-prompt golden byte-identity gate (order.amend.add_item/update_qty/remove_item, FE-T14 backfill)", () => {
  it("GREEN: the freshly-composed fragment is byte-identical to the committed golden fixture", async () => {
    const fresh = await computeOrderAmendGranularExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });

  it("exposes ONLY {item, quantity?} / {item, quantity} / {item} — never orderId/variantId/itemId/allergens", async () => {
    const fresh = await computeOrderAmendGranularExtractionPromptFragment();
    const schema = fresh.expressIntentTool.inputSchema as {
      allOf: Array<{
        if: { properties: { capability: { const: string } } };
        then: { properties: { payload: { properties: Record<string, unknown>; required?: string[] } } };
      }>;
    };
    expect(schema.allOf).toHaveLength(3);
    const byCapability = new Map(
      schema.allOf.map((clause) => [
        clause.if.properties.capability.const,
        clause.then.properties.payload,
      ]),
    );
    expect([...byCapability.keys()].sort()).toEqual([
      "order.amend.add_item",
      "order.amend.remove_item",
      "order.amend.update_qty",
    ]);
    for (const payload of byCapability.values()) {
      expect(Object.keys(payload.properties).sort()).not.toContain("orderId");
      expect(Object.keys(payload.properties).sort()).not.toContain("variantId");
      expect(Object.keys(payload.properties).sort()).not.toContain("itemId");
      expect(Object.keys(payload.properties).sort()).not.toContain("allergens");
    }
    expect(byCapability.get("order.amend.add_item")!.required).toEqual(["item"]);
    expect(byCapability.get("order.amend.update_qty")!.required).toEqual(["item", "quantity"]);
    expect(byCapability.get("order.amend.remove_item")!.required).toEqual(["item"]);
  });

  it("RED: a mutated wire schema (an extra leaked field) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computeOrderAmendGranularExtractionPromptFragment();
    const mutated: OrderAmendGranularExtractionPromptFragment = JSON.parse(
      JSON.stringify(fresh),
    ) as OrderAmendGranularExtractionPromptFragment;
    const schema = mutated.expressIntentTool.inputSchema as {
      allOf: Array<{ then: { properties: { payload: { properties: Record<string, unknown> } } } }>;
    };
    schema.allOf[0]!.then.properties.payload.properties.orderId = {
      type: "string",
      description: "x",
    };
    expect(canonicalize(mutated)).not.toBe(readGoldenRaw());
  });

  it("REVERT: an unmutated fresh computation is byte-identical again (the gate is not permanently red)", async () => {
    const fresh = await computeOrderAmendGranularExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });
});
