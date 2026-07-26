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
import { EXTRACTION_SCHEMAS_BY_CAPABILITY } from "../wire-schemas.js";
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

  // BKL-255a — this used to read each capability's payload schema back off the
  // `express_intent` wire surface (the `allOf` clauses). Those are gone: the
  // engine dropped them at decode (LE2-004), so the planner no longer sends
  // them. The per-capability field inventory is still live and still
  // load-bearing — `ALLOWED_PAYLOAD_FIELD_NAMES_BY_CAPABILITY` derives the
  // parse-seam filter from it — so this now reads the AUTHORED registry,
  // keyed by the fragment's OWN capability list.
  it("the authored schemas expose ONLY the model-extractable fields per capability — never reservationId or specialRequests", async () => {
    const fresh = await computeReservationConvenienceExtractionPromptFragment();
    const byCapability = new Map(
      fresh.capabilities.map((kind) => [
        kind,
        EXTRACTION_SCHEMAS_BY_CAPABILITY.get(kind) as {
          properties: Record<string, unknown>;
          required?: string[];
        },
      ]),
    );
    expect(byCapability.size).toBe(4);
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

  it("RED: a mutated wire schema (an extra capability in the enum) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computeReservationConvenienceExtractionPromptFragment();
    const mutated: ReservationConvenienceExtractionPromptFragment = JSON.parse(
      JSON.stringify(fresh),
    ) as ReservationConvenienceExtractionPromptFragment;
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
    const fresh = await computeReservationConvenienceExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });
});
