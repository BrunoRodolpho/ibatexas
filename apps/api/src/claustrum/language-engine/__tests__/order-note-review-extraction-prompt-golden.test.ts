// order-note-review-extraction-prompt-golden.test.ts — the FE-T14 golden
// BYTE-IDENTITY gate for the pack-orders free-text family (order.note.add,
// order.review.submit).
//
// To regenerate after an intentional change:
//
//   npx tsx -e "
//     import { computeOrderNoteReviewExtractionPromptFragment } from
//       './src/claustrum/language-engine/__tests__/order-note-review-extraction-prompt-fragment-support.ts';
//     import { writeFileSync } from 'node:fs';
//     computeOrderNoteReviewExtractionPromptFragment().then(f =>
//       writeFileSync(
//         'src/claustrum/language-engine/__tests__/__golden__/order-note-review.extraction-prompt-fragment.json',
//         JSON.stringify(f, null, 2) + '\n',
//       ));
//   "  (run from apps/api/), then `ibx journey extraction-consistency --update-binding`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeOrderNoteReviewExtractionPromptFragment,
  type OrderNoteReviewExtractionPromptFragment,
} from "./order-note-review-extraction-prompt-fragment-support.js";

const GOLDEN_PATH = fileURLToPath(
  new URL("./__golden__/order-note-review.extraction-prompt-fragment.json", import.meta.url),
);

function readGoldenRaw(): string {
  return readFileSync(GOLDEN_PATH, "utf8");
}

function canonicalize(fragment: OrderNoteReviewExtractionPromptFragment): string {
  return JSON.stringify(fragment, null, 2) + "\n";
}

describe("extraction-prompt golden byte-identity gate (order.note.add/order.review.submit, FE-T14)", () => {
  it("GREEN: the freshly-composed fragment is byte-identical to the committed golden fixture", async () => {
    const fresh = await computeOrderNoteReviewExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });

  it("exposes ONLY the model-extractable fields per capability — never orderId/productId/isInternal", async () => {
    const fresh = await computeOrderNoteReviewExtractionPromptFragment();
    const schema = fresh.expressIntentTool.inputSchema as {
      allOf: Array<{
        if: { properties: { capability: { const: string } } };
        then: { properties: { payload: { properties: Record<string, unknown>; required?: string[] } } };
      }>;
    };
    expect(schema.allOf).toHaveLength(2);
    const byCapability = new Map(
      schema.allOf.map((clause) => [
        clause.if.properties.capability.const,
        clause.then.properties.payload,
      ]),
    );
    expect([...byCapability.keys()].sort()).toEqual(["order.note.add", "order.review.submit"]);
    for (const payload of byCapability.values()) {
      const keys = Object.keys(payload.properties);
      expect(keys).not.toContain("orderId");
      expect(keys).not.toContain("productId");
      expect(keys).not.toContain("isInternal");
    }
    expect(byCapability.get("order.note.add")!.required).toEqual(["body"]);
    expect(byCapability.get("order.review.submit")!.required).toEqual(["rating"]);
  });

  it("RED: a mutated wire schema (an extra leaked field) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computeOrderNoteReviewExtractionPromptFragment();
    const mutated: OrderNoteReviewExtractionPromptFragment = JSON.parse(
      JSON.stringify(fresh),
    ) as OrderNoteReviewExtractionPromptFragment;
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
    const fresh = await computeOrderNoteReviewExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });
});
