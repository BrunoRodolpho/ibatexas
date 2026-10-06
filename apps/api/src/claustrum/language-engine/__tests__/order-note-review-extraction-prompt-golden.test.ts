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
import { EXTRACTION_SCHEMAS_BY_CAPABILITY } from "../wire-schemas.js";
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

  // BKL-255a — this used to read each capability's payload schema back off the
  // `express_intent` wire surface (the `allOf` clauses). Those are gone: the
  // engine dropped them at decode (LE2-004), so the planner no longer sends
  // them. The per-capability field inventory is still live and still
  // load-bearing — `ALLOWED_PAYLOAD_FIELD_NAMES_BY_CAPABILITY` derives the
  // parse-seam filter from it — so this now reads the AUTHORED registry,
  // keyed by the fragment's OWN capability list.
  it("the authored schemas expose ONLY the model-extractable fields per capability — never orderId/productId/isInternal", async () => {
    const fresh = await computeOrderNoteReviewExtractionPromptFragment();
    const byCapability = new Map(
      fresh.capabilities.map((kind) => [
        kind,
        EXTRACTION_SCHEMAS_BY_CAPABILITY.get(kind) as {
          properties: Record<string, unknown>;
          required?: string[];
        },
      ]),
    );
    expect(byCapability.size).toBe(2);
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

  it("RED: a mutated wire schema (an extra capability in the enum) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computeOrderNoteReviewExtractionPromptFragment();
    const mutated: OrderNoteReviewExtractionPromptFragment = JSON.parse(
      JSON.stringify(fresh),
    ) as OrderNoteReviewExtractionPromptFragment;
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
    const fresh = await computeOrderNoteReviewExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });
});
