// extraction-prompt-golden.test.ts — the golden BYTE-IDENTITY gate (FE-T06).
//
// Pins the composed per-capability extraction-prompt fragment for
// `order.status.transition` — the exact `express_intent` tool JSON the model
// receives on the wire (wire-schemas.ts's registry entry, composed through
// the REAL `buildToolSurface`, driven via `createIbatexasPlanner` — never a
// reimplementation) PLUS the `OPS_PLANNER_PERSONA` excerpt describing this
// capability. This is "the thing a rollout slice (T11-14) would accidentally
// drift": editing `wire-schemas.ts`'s registry MEMBERSHIP, `buildToolSurface`'s
// composition, or the persona paragraph for THIS capability all change this
// byte-identical fixture.
//
// SCOPE NARROWED (BKL-255a): editing `order-status-transition.schema.ts`'s
// FIELDS no longer moves this fixture. The authored payload schemas used to
// ride the wire as `allOf`/`if-then` clauses, but the engine dropped them at
// decode (LE2-004) and `buildToolSurface` no longer emits them — so the
// fragment now pins the capability enum, the tool description and the persona,
// not the payload shape. Payload-shape drift is caught elsewhere: the
// per-capability `*.schema.test.ts` files, `schema-lint-gate.test.ts`, and the
// "the authored schema exposes ONLY …" case below, which reads the registry
// directly.
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

  it("RED: a mutated wire schema (an extra capability in the enum) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computeOrderStatusTransitionExtractionPromptFragment();
    const mutated: ExtractionPromptFragment = JSON.parse(JSON.stringify(fresh)) as ExtractionPromptFragment;
    const schema = mutated.expressIntentTool.inputSchema as {
      properties: { capability: { enum: string[] } };
    };
    // BKL-255a — this used to widen the payload's own `newStatus` enum, which
    // is no longer on the wire (the engine dropped the `allOf` carrying it at
    // decode — LE2-004). The CAPABILITY enum is still on the wire and is still
    // what a rollout slice drifts; widening it is the same drift class the
    // golden gate must catch.
    schema.properties.capability.enum.push("order.cancel");
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
