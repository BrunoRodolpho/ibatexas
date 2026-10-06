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
// support.ts's header). Editing `wire-schemas.ts`'s registry MEMBERSHIP,
// `buildToolSurface`'s composition, or `PLANNER_PERSONA` itself all change
// this byte-identical fixture — and per FE-T08, regenerating it without ALSO
// re-committing `extraction-schema-binding.json` (after reviewing `ibx journey
// extraction-accuracy`'s impact) fails the separate, CERTIFYING
// `checkSchemaBinding` gate.
//
// SCOPE NARROWED (BKL-255a): editing `payment-pix-regenerate.schema.ts`'s
// FIELDS no longer moves this fixture — the authored payload schemas left the
// wire when `buildToolSurface` dropped the `allOf` the engine discarded at
// decode (LE2-004). This capability's zero-field payload was never enforced by
// the wire anyway; the thing that actually strips a hallucinated `orderId` is
// the plan-time filter (`ALLOWED_PAYLOAD_FIELD_NAMES_BY_CAPABILITY`, see the
// FE-T11 note in ibatexas-planner.ts), which still reads this schema.
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
import { EXTRACTION_SCHEMAS_BY_CAPABILITY } from "../wire-schemas.js";
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

  // BKL-255a — this used to read the payload schema back off the
  // `express_intent` wire surface (the `allOf` clause). That clause is gone:
  // the engine dropped it at decode (LE2-004), so the planner no longer sends
  // it. The zero-field inventory is still live and still load-bearing — it is
  // exactly what makes `ALLOWED_PAYLOAD_FIELD_NAMES_BY_CAPABILITY` strip a
  // hallucinated `orderId` at the parse seam (the enforcement half that
  // actually closes this, per the FE-T11 note in ibatexas-planner.ts) — so
  // this now reads the AUTHORED registry directly.
  it("the authored schema exposes ZERO fields — payload is a closed empty object, never orderId", () => {
    const payload = EXTRACTION_SCHEMAS_BY_CAPABILITY.get("payment.pix.regenerate") as {
      properties: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(Object.keys(payload.properties)).toEqual([]);
    expect(payload.additionalProperties).toBe(false);
  });

  it("RED: a mutated wire schema (a leaked orderId field) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computePaymentPixRegenerateExtractionPromptFragment();
    const mutated: ExtractionPromptFragment = JSON.parse(JSON.stringify(fresh)) as ExtractionPromptFragment;
    const schema = mutated.expressIntentTool.inputSchema as {
      properties: { capability: { enum: string[] } };
    };
    // BKL-255a — the payload sub-schema this used to mutate is no longer on the
    // wire; the capability enum still is, and is still what a rollout slice
    // drifts, so mutating it keeps this gate genuinely sensitive.
    schema.properties.capability.enum.push("order.status.transition");
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
