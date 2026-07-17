// payment-pix-regenerate-extraction-prompt-golden.test.ts — the FE-T11 golden
// BYTE-IDENTITY gate for `payment.pix.regenerate`, the customer-plane
// money-tier sibling of FE-T10's `payment-refund-issue-extraction-prompt-
// golden.test.ts`.
//
// Owner ruling (FE-T10, extended to T11-14 by that ticket's own precedent
// note): a money-tier extraction schema sits under BOTH this FE-T06-style
// golden gate AND the FE-T08 acknowledgment layer
// (extraction-schema-binding.json) FROM BIRTH — not deferred.
//
// Pins the composed per-capability extraction-prompt fragment for
// `payment.pix.regenerate` — the exact `express_intent` tool JSON the model
// receives on the wire (wire-schemas.ts's registry entry, composed through
// the REAL `buildToolSurface`, driven via `createIbatexasPlanner` — never a
// reimplementation) PLUS the (unmodified, in full) `PLANNER_PERSONA` — the
// customer-plane persona this capability is shown, which carries no
// per-capability paragraph to excerpt (see extraction-prompt-fragment-
// support.ts's header). Editing `payment-pix-regenerate.schema.ts`,
// `wire-schemas.ts`'s registry, `buildToolSurface`'s composition, or
// `PLANNER_PERSONA` itself all change this byte-identical fixture — and per
// FE-T08, regenerating it without ALSO re-committing
// `extraction-schema-binding.json` (after reviewing `ibx journey
// extraction-accuracy`'s impact) fails the separate, CERTIFYING
// `checkSchemaBinding` gate.
//
// To regenerate after an intentional change:
//
//   npx tsx -e "
//     import { computePaymentPixRegenerateExtractionPromptFragment } from
//       './src/claustrum/language-engine/__tests__/extraction-prompt-fragment-support.ts';
//     import { writeFileSync } from 'node:fs';
//     computePaymentPixRegenerateExtractionPromptFragment().then(f =>
//       writeFileSync(
//         'src/claustrum/language-engine/__tests__/__golden__/payment-pix-regenerate.extraction-prompt-fragment.json',
//         JSON.stringify(f, null, 2) + '\n',
//       ));
//   "  (run from apps/api/), then `ibx journey extraction-consistency --update-binding`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computePaymentPixRegenerateExtractionPromptFragment,
  type ExtractionPromptFragment,
} from "./extraction-prompt-fragment-support.js";

const GOLDEN_PATH = fileURLToPath(
  new URL(
    "./__golden__/payment-pix-regenerate.extraction-prompt-fragment.json",
    import.meta.url,
  ),
);

function readGoldenRaw(): string {
  return readFileSync(GOLDEN_PATH, "utf8");
}

function canonicalize(fragment: ExtractionPromptFragment): string {
  return JSON.stringify(fragment, null, 2) + "\n";
}

describe("extraction-prompt golden byte-identity gate (payment.pix.regenerate)", () => {
  it("GREEN: the freshly-composed fragment is byte-identical to the committed golden fixture", async () => {
    const fresh = await computePaymentPixRegenerateExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });

  it("exposes ZERO fields on the wire — payload is a closed empty object, never orderId", async () => {
    const fresh = await computePaymentPixRegenerateExtractionPromptFragment();
    const schema = fresh.expressIntentTool.inputSchema as {
      allOf: Array<{
        then: {
          properties: {
            payload: { properties: Record<string, unknown>; additionalProperties?: boolean };
          };
        };
      }>;
    };
    const payload = schema.allOf[0]!.then.properties.payload;
    expect(Object.keys(payload.properties)).toEqual([]);
    expect(payload.additionalProperties).toBe(false);
  });

  it("RED: a mutated wire schema (a leaked orderId field) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computePaymentPixRegenerateExtractionPromptFragment();
    const mutated: ExtractionPromptFragment = JSON.parse(JSON.stringify(fresh)) as ExtractionPromptFragment;
    const schema = mutated.expressIntentTool.inputSchema as {
      allOf: Array<{
        then: { properties: { payload: { properties: Record<string, unknown> } } };
      }>;
    };
    // Simulates a future edit accidentally exposing the forbidden identifier.
    schema.allOf[0]!.then.properties.payload.properties.orderId = {
      type: "string",
      description: "x",
    };
    expect(canonicalize(mutated)).not.toBe(readGoldenRaw());
  });

  it("RED: a mutated persona (a hypothetical drift to PLANNER_PERSONA) is NOT byte-identical", async () => {
    const fresh = await computePaymentPixRegenerateExtractionPromptFragment();
    const mutated: ExtractionPromptFragment = {
      ...fresh,
      personaExcerpt: fresh.personaExcerpt + " (drifted)",
    };
    expect(canonicalize(mutated)).not.toBe(readGoldenRaw());
  });

  it("REVERT: an unmutated fresh computation is byte-identical again (the gate is not permanently red)", async () => {
    const fresh = await computePaymentPixRegenerateExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });
});
