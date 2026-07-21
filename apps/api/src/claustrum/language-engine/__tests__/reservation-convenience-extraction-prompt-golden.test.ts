// reservation-convenience-extraction-prompt-golden.test.ts — the FE-T14
// golden BYTE-IDENTITY gate for the pack-reservations family
// (reservation.create, reservation.modify, reservation.cancel,
// reservation.waitlist.join).
//
// To regenerate after an intentional change:
//
//   npx tsx -e "
//     import { computeReservationConvenienceExtractionPromptFragment } from
//       './src/claustrum/language-engine/__tests__/reservation-convenience-extraction-prompt-fragment-support.ts';
//     import { writeFileSync } from 'node:fs';
//     computeReservationConvenienceExtractionPromptFragment().then(f =>
//       writeFileSync(
//         'src/claustrum/language-engine/__tests__/__golden__/reservation-convenience.extraction-prompt-fragment.json',
//         JSON.stringify(f, null, 2) + '\n',
//       ));
//   "  (run from apps/api/), then `ibx journey extraction-consistency --update-binding`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeReservationConvenienceExtractionPromptFragment,
  type ReservationConvenienceExtractionPromptFragment,
} from "./reservation-convenience-extraction-prompt-fragment-support.js";

const GOLDEN_PATH = fileURLToPath(
  new URL("./__golden__/reservation-convenience.extraction-prompt-fragment.json", import.meta.url),
);

function readGoldenRaw(): string {
  return readFileSync(GOLDEN_PATH, "utf8");
}

function canonicalize(fragment: ReservationConvenienceExtractionPromptFragment): string {
  return JSON.stringify(fragment, null, 2) + "\n";
}

describe("extraction-prompt golden byte-identity gate (reservation.create/modify/cancel/waitlist.join, FE-T14)", () => {
  it("GREEN: the freshly-composed fragment is byte-identical to the committed golden fixture", async () => {
    const fresh = await computeReservationConvenienceExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });

  it("exposes ONLY the model-extractable fields per capability — never reservationId or specialRequests", async () => {
    const fresh = await computeReservationConvenienceExtractionPromptFragment();
    const schema = fresh.expressIntentTool.inputSchema as {
      allOf: Array<{
        if: { properties: { capability: { const: string } } };
        then: { properties: { payload: { properties: Record<string, unknown>; required?: string[] } } };
      }>;
    };
    expect(schema.allOf).toHaveLength(4);
    const byCapability = new Map(
      schema.allOf.map((clause) => [
        clause.if.properties.capability.const,
        clause.then.properties.payload,
      ]),
    );
    expect([...byCapability.keys()].sort()).toEqual([
      "reservation.cancel",
      "reservation.create",
      "reservation.modify",
      "reservation.waitlist.join",
    ]);
    for (const payload of byCapability.values()) {
      const keys = Object.keys(payload.properties);
      expect(keys).not.toContain("reservationId");
      expect(keys).not.toContain("specialRequests");
    }
    // FE-D27 — timeSlotId is now optional (the NL date/time alternative), so only
    // partySize is required for create/waitlist.
    expect(byCapability.get("reservation.create")!.required).toEqual(["partySize"]);
    expect(byCapability.get("reservation.modify")!.required).toBeUndefined();
    expect(byCapability.get("reservation.cancel")!.required).toBeUndefined();
    expect(byCapability.get("reservation.waitlist.join")!.required).toEqual(["partySize"]);
  });

  it("RED: a mutated wire schema (an extra leaked field) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computeReservationConvenienceExtractionPromptFragment();
    const mutated: ReservationConvenienceExtractionPromptFragment = JSON.parse(
      JSON.stringify(fresh),
    ) as ReservationConvenienceExtractionPromptFragment;
    const schema = mutated.expressIntentTool.inputSchema as {
      allOf: Array<{ then: { properties: { payload: { properties: Record<string, unknown> } } } }>;
    };
    schema.allOf[0]!.then.properties.payload.properties.reservationId = {
      type: "string",
      description: "x",
    };
    expect(canonicalize(mutated)).not.toBe(readGoldenRaw());
  });

  it("REVERT: an unmutated fresh computation is byte-identical again (the gate is not permanently red)", async () => {
    const fresh = await computeReservationConvenienceExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });
});
