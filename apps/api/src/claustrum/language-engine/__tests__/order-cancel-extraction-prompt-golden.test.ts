// order-cancel-extraction-prompt-golden.test.ts — FE-T12's golden
// BYTE-IDENTITY gate for `order.cancel`, the customer-plane sibling of
// `order-checkout-create-extraction-prompt-golden.test.ts` (see that file's
// header and extraction-prompt-fragment-support.ts's module header for the
// "CUSTOMER-plane vs OPS-plane persona excerpt" rationale).
//
// To regenerate after an intentional change:
//
//   npx tsx -e "
//     import { computeOrderCancelExtractionPromptFragment } from
//       './src/claustrum/language-engine/__tests__/extraction-prompt-fragment-support.ts';
//     import { writeFileSync } from 'node:fs';
//     computeOrderCancelExtractionPromptFragment().then(f =>
//       writeFileSync(
//         'src/claustrum/language-engine/__tests__/__golden__/order-cancel.extraction-prompt-fragment.json',
//         JSON.stringify(f, null, 2) + '\n',
//       ));
//   "  (run from apps/api/), then `ibx journey extraction-consistency --update-binding`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeOrderCancelExtractionPromptFragment,
  type ExtractionPromptFragment,
} from "./extraction-prompt-fragment-support.js";
import { PLANNER_PERSONA } from "../../prompts/personas.js";

const GOLDEN_PATH = fileURLToPath(
  new URL("./__golden__/order-cancel.extraction-prompt-fragment.json", import.meta.url),
);

function readGoldenRaw(): string {
  return readFileSync(GOLDEN_PATH, "utf8");
}

function canonicalize(fragment: ExtractionPromptFragment): string {
  return JSON.stringify(fragment, null, 2) + "\n";
}

describe("extraction-prompt golden byte-identity gate (order.cancel)", () => {
  it("GREEN: the freshly-composed fragment is byte-identical to the committed golden fixture", async () => {
    const fresh = await computeOrderCancelExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });

  it("exposes ONLY reason on the wire — never orderId — and reason is NOT required", async () => {
    const fresh = await computeOrderCancelExtractionPromptFragment();
    const schema = fresh.expressIntentTool.inputSchema as {
      allOf: Array<{
        then: { properties: { payload: { properties: Record<string, unknown>; required?: string[] } } };
      }>;
    };
    const payloadSchema = schema.allOf[0]!.then.properties.payload;
    expect(Object.keys(payloadSchema.properties)).toEqual(["reason"]);
    expect(payloadSchema.required).toBeUndefined();
  });

  it("the personaExcerpt is the FULL PLANNER_PERSONA text (no per-capability paragraph exists on the customer plane)", async () => {
    const fresh = await computeOrderCancelExtractionPromptFragment();
    expect(fresh.personaExcerpt).toBe(PLANNER_PERSONA);
  });

  it("RED: a mutated wire schema (an extra leaked field) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computeOrderCancelExtractionPromptFragment();
    const mutated: ExtractionPromptFragment = JSON.parse(JSON.stringify(fresh)) as ExtractionPromptFragment;
    const schema = mutated.expressIntentTool.inputSchema as {
      allOf: Array<{
        then: { properties: { payload: { properties: Record<string, unknown> } } };
      }>;
    };
    // Simulates a future edit accidentally exposing a forbidden field.
    schema.allOf[0]!.then.properties.payload.properties.orderId = {
      type: "string",
      description: "x",
    };
    expect(canonicalize(mutated)).not.toBe(readGoldenRaw());
  });

  it("RED: a mutated persona excerpt (a hypothetical drift to PLANNER_PERSONA) is NOT byte-identical", async () => {
    const fresh = await computeOrderCancelExtractionPromptFragment();
    const mutated: ExtractionPromptFragment = {
      ...fresh,
      personaExcerpt: fresh.personaExcerpt + " (drifted)",
    };
    expect(canonicalize(mutated)).not.toBe(readGoldenRaw());
  });

  it("REVERT: an unmutated fresh computation is byte-identical again (the gate is not permanently red)", async () => {
    const fresh = await computeOrderCancelExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });
});
