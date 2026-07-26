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
import { EXTRACTION_SCHEMAS_BY_CAPABILITY } from "../wire-schemas.js";
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

  // BKL-255a — this used to read each capability's payload schema back off the
  // `express_intent` wire surface (the `allOf` clauses). Those are gone: the
  // engine dropped them at decode (LE2-004), so the planner no longer sends
  // them. The per-capability field inventory is still live and still
  // load-bearing — `ALLOWED_PAYLOAD_FIELD_NAMES_BY_CAPABILITY` derives the
  // parse-seam filter from it — so this now reads the AUTHORED registry,
  // keyed by the fragment's OWN capability list so the coupling to the
  // planner's allowed-intent set survives.
  it("the authored schemas expose ONLY the model-extractable fields per capability — never allergenExclusions/name/email/cpf/sessionId", async () => {
    const fresh = await computeCustomerWhatsappConvenienceExtractionPromptFragment();
    const byCapability = new Map(
      fresh.capabilities.map((kind) => [
        kind,
        EXTRACTION_SCHEMAS_BY_CAPABILITY.get(kind) as { properties: Record<string, unknown> },
      ]),
    );
    expect(byCapability.size).toBe(3);
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
    // customer.pix.details.save is EMPTY — zero PII fields authored.
    expect(byCapability.get("customer.pix.details.save")!.properties).toEqual({});
    expect(Object.keys(byCapability.get("customer.preferences.update")!.properties).sort()).toEqual([
      "dietary_restrictions",
      "favorite_categories",
    ]);
    expect(Object.keys(byCapability.get("whatsapp.handoff.request")!.properties)).toEqual(["reason"]);
  });

  it("RED: a mutated wire schema (an extra capability in the enum) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computeCustomerWhatsappConvenienceExtractionPromptFragment();
    const mutated: CustomerWhatsappConvenienceExtractionPromptFragment = JSON.parse(
      JSON.stringify(fresh),
    ) as CustomerWhatsappConvenienceExtractionPromptFragment;
    const schema = mutated.expressIntentTool.inputSchema as {
      properties: { capability: { enum: string[] } };
    };
    // BKL-255a — the payload sub-schema this used to mutate is no longer on the
    // wire, so a leaked-field drift can no longer reach the golden. The
    // capability enum IS still on the wire and is still what a rollout slice
    // drifts; mutating it keeps this gate genuinely sensitive.
    schema.properties.capability.enum.push("order.status.transition");
    expect(canonicalize(mutated)).not.toBe(readGoldenRaw());
  });

  it("REVERT: an unmutated fresh computation is byte-identical again (the gate is not permanently red)", async () => {
    const fresh = await computeCustomerWhatsappConvenienceExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });
});
