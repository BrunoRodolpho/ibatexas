// customer-whatsapp-convenience-extraction-prompt-golden.test.ts — the
// FE-T14 golden BYTE-IDENTITY gate for the pack-customer-onboarding +
// pack-whatsapp family (customer.preferences.update, customer.pix.details.
// save, whatsapp.handoff.request).
//
// To regenerate after an intentional change:
//
//   npx tsx -e "
//     import { computeCustomerWhatsappConvenienceExtractionPromptFragment } from
//       './src/claustrum/language-engine/__tests__/customer-whatsapp-convenience-extraction-prompt-fragment-support.ts';
//     import { writeFileSync } from 'node:fs';
//     computeCustomerWhatsappConvenienceExtractionPromptFragment().then(f =>
//       writeFileSync(
//         'src/claustrum/language-engine/__tests__/__golden__/customer-whatsapp-convenience.extraction-prompt-fragment.json',
//         JSON.stringify(f, null, 2) + '\n',
//       ));
//   "  (run from apps/api/), then `ibx journey extraction-consistency --update-binding`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeCustomerWhatsappConvenienceExtractionPromptFragment,
  type CustomerWhatsappConvenienceExtractionPromptFragment,
} from "./customer-whatsapp-convenience-extraction-prompt-fragment-support.js";

const GOLDEN_PATH = fileURLToPath(
  new URL("./__golden__/customer-whatsapp-convenience.extraction-prompt-fragment.json", import.meta.url),
);

function readGoldenRaw(): string {
  return readFileSync(GOLDEN_PATH, "utf8");
}

function canonicalize(fragment: CustomerWhatsappConvenienceExtractionPromptFragment): string {
  return JSON.stringify(fragment, null, 2) + "\n";
}

describe("extraction-prompt golden byte-identity gate (customer.preferences.update/customer.pix.details.save/whatsapp.handoff.request, FE-T14)", () => {
  it("GREEN: the freshly-composed fragment is byte-identical to the committed golden fixture", async () => {
    const fresh = await computeCustomerWhatsappConvenienceExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });

  it("exposes ONLY the model-extractable fields per capability — never allergenExclusions/name/email/cpf/sessionId", async () => {
    const fresh = await computeCustomerWhatsappConvenienceExtractionPromptFragment();
    const schema = fresh.expressIntentTool.inputSchema as {
      allOf: Array<{
        if: { properties: { capability: { const: string } } };
        then: { properties: { payload: { properties: Record<string, unknown> } } };
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
      "customer.pix.details.save",
      "customer.preferences.update",
      "whatsapp.handoff.request",
    ]);
    for (const payload of byCapability.values()) {
      const keys = Object.keys(payload.properties);
      expect(keys).not.toContain("allergenExclusions");
      expect(keys).not.toContain("allergens");
      expect(keys).not.toContain("name");
      expect(keys).not.toContain("email");
      expect(keys).not.toContain("cpf");
      expect(keys).not.toContain("sessionId");
    }
    // customer.pix.details.save is EMPTY — zero PII fields on the wire.
    expect(byCapability.get("customer.pix.details.save")!.properties).toEqual({});
    expect(Object.keys(byCapability.get("customer.preferences.update")!.properties).sort()).toEqual([
      "dietary_restrictions",
      "favorite_categories",
    ]);
    expect(Object.keys(byCapability.get("whatsapp.handoff.request")!.properties)).toEqual(["reason"]);
  });

  it("RED: a mutated wire schema (a leaked PII field) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computeCustomerWhatsappConvenienceExtractionPromptFragment();
    const mutated: CustomerWhatsappConvenienceExtractionPromptFragment = JSON.parse(
      JSON.stringify(fresh),
    ) as CustomerWhatsappConvenienceExtractionPromptFragment;
    const schema = mutated.expressIntentTool.inputSchema as {
      allOf: Array<{ then: { properties: { payload: { properties: Record<string, unknown> } } } }>;
    };
    schema.allOf[0]!.then.properties.payload.properties.email = {
      type: "string",
      description: "x",
    };
    expect(canonicalize(mutated)).not.toBe(readGoldenRaw());
  });

  it("REVERT: an unmutated fresh computation is byte-identical again (the gate is not permanently red)", async () => {
    const fresh = await computeCustomerWhatsappConvenienceExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });
});
