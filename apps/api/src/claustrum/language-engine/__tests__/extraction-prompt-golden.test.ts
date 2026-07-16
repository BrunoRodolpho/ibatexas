// extraction-prompt-golden.test.ts — the golden BYTE-IDENTITY gate (FE-T06).
//
// Pins the composed per-capability extraction-prompt fragment for
// `order.status.transition` — the exact `express_intent` tool JSON the model
// receives on the wire (wire-schemas.ts's registry entry, composed through
// the REAL `buildToolSurface`, driven via `createIbatexasPlanner` — never a
// reimplementation) PLUS the `OPS_PLANNER_PERSONA` excerpt describing this
// capability. This is "the thing a rollout slice (T11-14) would accidentally
// drift": editing `order-status-transition.schema.ts`, `wire-schemas.ts`'s
// registry, `buildToolSurface`'s composition, or the persona paragraph for
// THIS capability all change this byte-identical fixture.
//
// Mirrors the codegen-freshness gate idiom (FE-4.3 — "regenerate in a clean
// tree; fail on any diff from the committed generated artifacts"): a
// committed JSON fixture (`__golden__/order-status-transition.extraction-
// prompt-fragment.json`) vs. a FRESH computation, byte-for-byte. To
// regenerate after an intentional change:
//
//   npx tsx -e "
//     import { computeOrderStatusTransitionExtractionPromptFragment } from
//       './src/claustrum/language-engine/__tests__/extraction-prompt-fragment-support.ts';
//     import { writeFileSync } from 'node:fs';
//     computeOrderStatusTransitionExtractionPromptFragment().then(f =>
//       writeFileSync(
//         'src/claustrum/language-engine/__tests__/__golden__/order-status-transition.extraction-prompt-fragment.json',
//         JSON.stringify(f, null, 2) + '\n',
//       ));
//   "  (run from apps/api/)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeOrderStatusTransitionExtractionPromptFragment,
  extractOrderStatusTransitionPersonaExcerpt,
  type ExtractionPromptFragment,
} from "./extraction-prompt-fragment-support.js";

const GOLDEN_PATH = fileURLToPath(
  new URL("./__golden__/order-status-transition.extraction-prompt-fragment.json", import.meta.url),
);

function readGoldenRaw(): string {
  return readFileSync(GOLDEN_PATH, "utf8");
}

function canonicalize(fragment: ExtractionPromptFragment): string {
  return JSON.stringify(fragment, null, 2) + "\n";
}

describe("extraction-prompt golden byte-identity gate (order.status.transition)", () => {
  it("GREEN: the freshly-composed fragment is byte-identical to the committed golden fixture", async () => {
    const fresh = await computeOrderStatusTransitionExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });

  it("RED: a mutated wire schema (an extra enum value) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computeOrderStatusTransitionExtractionPromptFragment();
    const mutated: ExtractionPromptFragment = JSON.parse(JSON.stringify(fresh)) as ExtractionPromptFragment;
    const schema = mutated.expressIntentTool.inputSchema as {
      allOf: Array<{ then: { properties: { payload: { properties: { newStatus: { enum: string[] } } } } } }>;
    };
    // Simulates a rollout slice accidentally widening the enum (or any other
    // schema-registry drift) — the golden gate must catch it.
    schema.allOf[0]!.then.properties.payload.properties.newStatus.enum.push("archived");
    expect(canonicalize(mutated)).not.toBe(readGoldenRaw());
  });

  it("RED: a mutated persona excerpt (a hypothetical drift to the order.status.transition paragraph) is NOT byte-identical", async () => {
    const fresh = await computeOrderStatusTransitionExtractionPromptFragment();
    const mutated: ExtractionPromptFragment = {
      ...fresh,
      personaExcerpt: fresh.personaExcerpt + " (drifted)",
    };
    expect(canonicalize(mutated)).not.toBe(readGoldenRaw());
  });

  it("REVERT: an unmutated fresh computation is byte-identical again (the gate is not permanently red)", async () => {
    const fresh = await computeOrderStatusTransitionExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });

  it("the persona-excerpt extractor throws (rather than silently producing an empty diff) when its markers vanish", () => {
    expect(() => extractOrderStatusTransitionPersonaExcerpt("no markers here")).toThrow(
      /no longer contains the marker/,
    );
    expect(() =>
      extractOrderStatusTransitionPersonaExcerpt("Em order.status.transition, ... (no next marker)"),
    ).toThrow(/no longer contains the boundary marker/);
  });
});
