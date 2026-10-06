// payment-refund-issue-extraction-prompt-golden.test.ts — the FE-T10 golden
// BYTE-IDENTITY gate for `payment.refund.issue`, the money-tier sibling of
// FE-T06's `extraction-prompt-golden.test.ts`.
//
// Owner ruling (FE-T10): a money-tier extraction schema is the highest-risk
// artifact in this system, so it sits under BOTH the FE-T06 golden gate AND
// the FE-T08 acknowledgment layer (extraction-schema-binding.json) FROM
// BIRTH — not deferred to a later ticket. T11-14 should follow the same
// precedent for any future money-tier capability.
//
// Pins the composed per-capability extraction-prompt fragment for
// `payment.refund.issue` — the exact `express_intent` tool JSON the model
// receives on the wire (wire-schemas.ts's registry entry, composed through
// the REAL `buildToolSurface`, driven via `createIbatexasPlanner` — never a
// reimplementation) PLUS the `OPS_PLANNER_PERSONA` excerpt describing this
// capability. Editing `wire-schemas.ts`'s registry MEMBERSHIP,
// `buildToolSurface`'s composition, or the persona paragraph for THIS
// capability all change this byte-identical fixture — and per FE-T08,
// regenerating it without ALSO re-committing `extraction-schema-binding.json`
// (after reviewing `ibx journey extraction-accuracy`'s impact) fails the
// separate, CERTIFYING `checkSchemaBinding` gate.
//
// SCOPE NARROWED (BKL-255a): editing `payment-refund-issue.schema.ts`'s FIELDS
// no longer moves this fixture — the authored payload schemas left the wire
// when `buildToolSurface` dropped the `allOf` the engine discarded at decode
// (LE2-004). This matters for the money-tier ruling above, so state it
// plainly: the schema-binding gate no longer certifies this capability's
// payload SHAPE, only its enum/persona surface. Payload-shape drift is caught
// by `payment-refund-issue.schema.test.ts`, `schema-lint-gate.test.ts`, and
// the "the authored schema exposes ONLY …" case below.
//
// To regenerate after an intentional change:
//
//   npx tsx -e "
//     import { computePaymentRefundIssueExtractionPromptFragment } from
//       './src/claustrum/language-engine/__tests__/extraction-prompt-fragment-support.ts';
//     import { writeFileSync } from 'node:fs';
//     computePaymentRefundIssueExtractionPromptFragment().then(f =>
//       writeFileSync(
//         'src/claustrum/language-engine/__tests__/__golden__/payment-refund-issue.extraction-prompt-fragment.json',
//         JSON.stringify(f, null, 2) + '\n',
//       ));
//   "  (run from apps/api/), then `ibx journey extraction-consistency --update-binding`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXTRACTION_SCHEMAS_BY_CAPABILITY } from "../wire-schemas.js";
import {
  computePaymentRefundIssueExtractionPromptFragment,
  extractPaymentRefundIssuePersonaExcerpt,
  type ExtractionPromptFragment,
} from "./extraction-prompt-fragment-support.js";

const GOLDEN_PATH = fileURLToPath(
  new URL(
    "./__golden__/payment-refund-issue.extraction-prompt-fragment.json",
    import.meta.url,
  ),
);

function readGoldenRaw(): string {
  return readFileSync(GOLDEN_PATH, "utf8");
}

function canonicalize(fragment: ExtractionPromptFragment): string {
  return JSON.stringify(fragment, null, 2) + "\n";
}

describe("extraction-prompt golden byte-identity gate (payment.refund.issue)", () => {
  it("GREEN: the freshly-composed fragment is byte-identical to the committed golden fixture", async () => {
    const fresh = await computePaymentRefundIssueExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });

  // BKL-255a — this used to read the payload schema back off the
  // `express_intent` wire surface (the `allOf` clause). That clause is gone:
  // the engine dropped it at decode (LE2-004), so the planner no longer sends
  // it. The field inventory is still live and still load-bearing —
  // `ALLOWED_PAYLOAD_FIELD_NAMES_BY_CAPABILITY` derives the parse-seam filter
  // from it — so this now reads the AUTHORED registry directly.
  it("the authored schema exposes ONLY {orderReference, amount, reason} — never orderId/paymentId/refundAmountCentavos", () => {
    const payloadProps = (
      EXTRACTION_SCHEMAS_BY_CAPABILITY.get("payment.refund.issue") as {
        properties: Record<string, unknown>;
      }
    ).properties;
    expect(Object.keys(payloadProps).sort()).toEqual(["amount", "orderReference", "reason"]);
  });

  it("RED: a mutated wire schema (an extra leaked field) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computePaymentRefundIssueExtractionPromptFragment();
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

  it("RED: a mutated persona excerpt (a hypothetical drift to the payment.refund.issue paragraph) is NOT byte-identical", async () => {
    const fresh = await computePaymentRefundIssueExtractionPromptFragment();
    const mutated: ExtractionPromptFragment = {
      ...fresh,
      personaExcerpt: fresh.personaExcerpt + " (drifted)",
    };
    expect(canonicalize(mutated)).not.toBe(readGoldenRaw());
  });

  it("REVERT: an unmutated fresh computation is byte-identical again (the gate is not permanently red)", async () => {
    const fresh = await computePaymentRefundIssueExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });

  it("the persona-excerpt extractor throws (rather than silently producing an empty diff) when its markers vanish", () => {
    expect(() => extractPaymentRefundIssuePersonaExcerpt("no markers here")).toThrow(
      /no longer contains the marker/,
    );
    expect(() =>
      extractPaymentRefundIssuePersonaExcerpt("Em payment.refund.issue, ... (no next marker)"),
    ).toThrow(/no longer contains the boundary marker/);
  });
});
