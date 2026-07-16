// order-checkout-create-extraction-prompt-golden.test.ts — FE-T12's golden
// BYTE-IDENTITY gate for `order.checkout.create`, the FIRST customer-plane
// capability under this gate (see extraction-prompt-fragment-support.ts's
// module header — "CUSTOMER-plane vs OPS-plane persona excerpt").
//
// Pins the composed per-capability extraction-prompt fragment for
// `order.checkout.create` — the exact `express_intent` tool JSON the model
// receives on the wire (wire-schemas.ts's registry entry, composed through
// the REAL `buildToolSurface`, driven via `createIbatexasPlanner` — never a
// reimplementation) PLUS the full `PLANNER_PERSONA` text (the customer
// persona has no per-capability paragraph to excerpt — unlike the ops
// golden gates, which slice a marker-delimited paragraph out of
// `OPS_PLANNER_PERSONA`). Editing `order-checkout-create.schema.ts`,
// `wire-schemas.ts`'s registry, `buildToolSurface`'s composition, or
// `PLANNER_PERSONA` itself all change this byte-identical fixture.
//
// To regenerate after an intentional change:
//
//   npx tsx -e "
//     import { computeOrderCheckoutCreateExtractionPromptFragment } from
//       './src/claustrum/language-engine/__tests__/extraction-prompt-fragment-support.ts';
//     import { writeFileSync } from 'node:fs';
//     computeOrderCheckoutCreateExtractionPromptFragment().then(f =>
//       writeFileSync(
//         'src/claustrum/language-engine/__tests__/__golden__/order-checkout-create.extraction-prompt-fragment.json',
//         JSON.stringify(f, null, 2) + '\n',
//       ));
//   "  (run from apps/api/), then `ibx journey extraction-consistency --update-binding`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeOrderCheckoutCreateExtractionPromptFragment,
  type ExtractionPromptFragment,
} from "./extraction-prompt-fragment-support.js";
import { PLANNER_PERSONA } from "../../prompts/personas.js";

const GOLDEN_PATH = fileURLToPath(
  new URL(
    "./__golden__/order-checkout-create.extraction-prompt-fragment.json",
    import.meta.url,
  ),
);

function readGoldenRaw(): string {
  return readFileSync(GOLDEN_PATH, "utf8");
}

function canonicalize(fragment: ExtractionPromptFragment): string {
  return JSON.stringify(fragment, null, 2) + "\n";
}

describe("extraction-prompt golden byte-identity gate (order.checkout.create)", () => {
  it("GREEN: the freshly-composed fragment is byte-identical to the committed golden fixture", async () => {
    const fresh = await computeOrderCheckoutCreateExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });

  it("exposes ONLY paymentMethod on the wire — never cartId/pixDetails/email/cpf", async () => {
    const fresh = await computeOrderCheckoutCreateExtractionPromptFragment();
    const schema = fresh.expressIntentTool.inputSchema as {
      allOf: Array<{ then: { properties: { payload: { properties: Record<string, unknown> } } } }>;
    };
    const payloadProps = schema.allOf[0]!.then.properties.payload.properties;
    expect(Object.keys(payloadProps)).toEqual(["paymentMethod"]);
  });

  it("the personaExcerpt is the FULL PLANNER_PERSONA text (no per-capability paragraph exists on the customer plane)", async () => {
    const fresh = await computeOrderCheckoutCreateExtractionPromptFragment();
    expect(fresh.personaExcerpt).toBe(PLANNER_PERSONA);
  });

  it("RED: a mutated wire schema (an extra leaked field) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computeOrderCheckoutCreateExtractionPromptFragment();
    const mutated: ExtractionPromptFragment = JSON.parse(JSON.stringify(fresh)) as ExtractionPromptFragment;
    const schema = mutated.expressIntentTool.inputSchema as {
      allOf: Array<{
        then: { properties: { payload: { properties: Record<string, unknown> } } };
      }>;
    };
    // Simulates a future edit accidentally exposing a forbidden field.
    schema.allOf[0]!.then.properties.payload.properties.cartId = {
      type: "string",
      description: "x",
    };
    expect(canonicalize(mutated)).not.toBe(readGoldenRaw());
  });

  it("RED: a mutated persona excerpt (a hypothetical drift to PLANNER_PERSONA) is NOT byte-identical", async () => {
    const fresh = await computeOrderCheckoutCreateExtractionPromptFragment();
    const mutated: ExtractionPromptFragment = {
      ...fresh,
      personaExcerpt: fresh.personaExcerpt + " (drifted)",
    };
    expect(canonicalize(mutated)).not.toBe(readGoldenRaw());
  });

  it("REVERT: an unmutated fresh computation is byte-identical again (the gate is not permanently red)", async () => {
    const fresh = await computeOrderCheckoutCreateExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });
});
