// read-tool-extraction-prompt-golden.test.ts — the FE-T13 golden
// BYTE-IDENTITY gate for the read-tool surface.
//
// Pins the composed extraction-prompt fragment for the 12 chat-plane read
// tools (read-tool-schemas.ts's registry, composed through the REAL
// `buildToolSurface`, driven via `createIbatexasPlanner` — never a
// reimplementation): each tool's exact `{name, description, inputSchema}`
// entry the model receives on the wire. This is the thing a future read-tool
// schema edit would accidentally drift — editing `read-tool-schemas.ts`'s
// registry or `buildToolSurface`'s read-branch composition both change this
// byte-identical fixture. Satisfies the FE-T13 ticket AC: "a coverage report
// shows each status/read verb now has an authored schema + golden fragment,
// off the untyped {type:'object'} blob."
//
// Mirrors the FE-T06 golden idiom (extraction-prompt-golden.test.ts) exactly,
// generalized from ONE capability to the full read roster in one fixture
// (12 near-trivial schemas — one golden file per tool would be file sprawl
// for no additional drift-detection power, since they're all composed
// through the exact same `buildToolSurface` branch).
//
// To regenerate after an intentional change:
//
//   npx tsx -e "
//     import { computeReadToolExtractionPromptFragment } from
//       './src/claustrum/language-engine/__tests__/read-tool-extraction-prompt-fragment-support.ts';
//     import { writeFileSync } from 'node:fs';
//     computeReadToolExtractionPromptFragment().then(f =>
//       writeFileSync(
//         'src/claustrum/language-engine/__tests__/__golden__/read-tools.extraction-prompt-fragment.json',
//         JSON.stringify(f, null, 2) + '\n',
//       ));
//   "  (run from apps/api/)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeReadToolExtractionPromptFragment,
  type ReadToolExtractionPromptFragment,
} from "./read-tool-extraction-prompt-fragment-support.js";

const GOLDEN_PATH = fileURLToPath(
  new URL("./__golden__/read-tools.extraction-prompt-fragment.json", import.meta.url),
);

function readGoldenRaw(): string {
  return readFileSync(GOLDEN_PATH, "utf8");
}

function canonicalize(fragment: ReadToolExtractionPromptFragment): string {
  return JSON.stringify(fragment, null, 2) + "\n";
}

describe("read-tool extraction-prompt golden byte-identity gate (FE-T13, 12-tool roster)", () => {
  it("GREEN: the freshly-composed fragment is byte-identical to the committed golden fixture", async () => {
    const fresh = await computeReadToolExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });

  it("every read tool's inputSchema is additionalProperties:false — the untyped blob (additionalProperties:true) is gone", async () => {
    const fresh = await computeReadToolExtractionPromptFragment();
    for (const read of fresh.reads) {
      const schema = read.inputSchema as { additionalProperties?: unknown; type?: unknown };
      expect(schema.type, `${read.name}.inputSchema.type`).toBe("object");
      expect(schema.additionalProperties, `${read.name}.inputSchema.additionalProperties`).toBe(false);
    }
  });

  it("RED: a mutated read-tool schema (an extra enum value) is NOT byte-identical to the golden fixture", async () => {
    const fresh = await computeReadToolExtractionPromptFragment();
    const mutated: ReadToolExtractionPromptFragment = JSON.parse(
      JSON.stringify(fresh),
    ) as ReadToolExtractionPromptFragment;
    const recs = mutated.reads.find((r) => r.name === "get_recommendations")!;
    const schema = recs.inputSchema as { properties: { context: { enum: string[] } } };
    // Simulates a rollout drift (a widened enum, or any other schema-registry
    // drift) — the golden gate must catch it.
    schema.properties.context.enum.push("checkout");
    expect(canonicalize(mutated)).not.toBe(readGoldenRaw());
  });

  it("REVERT: an unmutated fresh computation is byte-identical again (the gate is not permanently red)", async () => {
    const fresh = await computeReadToolExtractionPromptFragment();
    expect(canonicalize(fresh)).toBe(readGoldenRaw());
  });
});
