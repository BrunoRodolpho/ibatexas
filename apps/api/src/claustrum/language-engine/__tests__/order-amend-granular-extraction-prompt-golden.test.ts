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
import { EXTRACTION_SCHEMAS_BY_CAPABILITY } from "../wire-schemas.js";
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

  // BKL-255a — this used to read each capability's payload schema back off the
  // `express_intent` wire surface (the `allOf` clauses). Those are gone: the
  // engine dropped them at decode (LE2-004), so the planner no longer sends
  // them. The per-capability field inventory is still live and still
  // load-bearing — `ALLOWED_PAYLOAD_FIELD_NAMES_BY_CAPABILITY` derives the
  // parse-seam filter from it — so this now reads the AUTHORED registry,
  // keyed by the fragment's OWN capability list.
  it("the authored schemas expose ONLY {item, quantity?} / {item, quantity} / {item} — never orderId/variantId/itemId/allergens", async () => {
    const fresh = await computeOrderAmendGranularExtractionPromptFragment();
    const byCapability = new Map(
      fresh.capabilities.map((kind) => [
        kind,
        EXTRACTION_SCHEMAS_BY_CAPABILITY.get(kind) as {
          properties: Record<string, unknown>;
          required?: string[];
        },
      ]),
    );
    expect(byCapability.size).toBe(3);
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

  it("RED: a mutated wire schema (an extra capability in the enum) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computeOrderAmendGranularExtractionPromptFragment();
    const mutated: OrderAmendGranularExtractionPromptFragment = JSON.parse(
      JSON.stringify(fresh),
    ) as OrderAmendGranularExtractionPromptFragment;
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
    const fresh = await computeOrderAmendGranularExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });
});
