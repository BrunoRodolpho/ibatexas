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
import { PLANNER_PERSONA } from "../../prompts/personas.js";
import { EXTRACTION_SCHEMAS_BY_CAPABILITY } from "../wire-schemas.js";
import {
  computeOrderCancelExtractionPromptFragment,
  type ExtractionPromptFragment,
} from "./extraction-prompt-fragment-support.js";

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

  // BKL-255a — this assertion used to read the payload schema back off the
  // `express_intent` wire surface (the `allOf` clause). That clause is gone:
  // the engine dropped it at decode (LE2-004), so the planner no longer sends
  // it. The field inventory it checks is still live and still load-bearing —
  // it is what `ALLOWED_PAYLOAD_FIELD_NAMES_BY_CAPABILITY` derives the
  // parse-seam filter from — so the assertion now reads the AUTHORED registry
  // directly rather than a wire surface that no longer carries it.
  it("the authored schema exposes ONLY reason — never orderId — and reason is NOT required", () => {
    const payloadSchema = EXTRACTION_SCHEMAS_BY_CAPABILITY.get("order.cancel") as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(payloadSchema.properties)).toEqual(["reason"]);
    expect(payloadSchema.required).toBeUndefined();
  });

  it("the personaExcerpt is the FULL PLANNER_PERSONA text (no per-capability paragraph exists on the customer plane)", async () => {
    const fresh = await computeOrderCancelExtractionPromptFragment();
    expect(fresh.personaExcerpt).toBe(PLANNER_PERSONA);
  });

  it("RED: a mutated wire schema (an extra capability in the enum) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computeOrderCancelExtractionPromptFragment();
    const mutated: ExtractionPromptFragment = JSON.parse(JSON.stringify(fresh)) as ExtractionPromptFragment;
    const schema = mutated.expressIntentTool.inputSchema as {
      properties: { capability: { enum: string[] } };
    };
    // BKL-255a — the payload sub-schema this used to mutate is no longer on the
    // wire, so the drift it simulated can no longer reach the golden. The
    // capability enum IS still on the wire and is still the surface a rollout
    // slice drifts; mutating it keeps this gate genuinely sensitive.
    schema.properties.capability.enum.push("order.status.transition");
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
