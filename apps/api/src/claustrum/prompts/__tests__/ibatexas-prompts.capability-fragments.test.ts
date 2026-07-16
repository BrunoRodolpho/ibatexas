// FE-T22 — FE-4 MIGRATE 3, "prompt hints" family, loop-closing test.
//
// `generateCapabilityDescriptions` (FE-T21) is verified byte-for-byte against
// the real `IBATEXAS_CAPABILITY_DESCRIPTIONS` export in
// apps/api/src/__tests__/chat-drivable-roster-drift.test.ts. That closes half
// the loop (generator → hand list). This test closes the OTHER half (hand
// list → what the LLM actually sees): `ibatexasPromptFragments()` builds one
// `PromptFragment` per `IBATEXAS_CAPABILITY_DESCRIPTIONS` entry
// (`capabilityFragment` in `../ibatexas-prompts.ts`), so together the two
// tests prove the generator's projection is what is actually assembled into
// the responder-grounded prompt surface — no separate generator was needed
// for "prompt hints" (per FE-T22's own scope note).
//
// No prompt overrides are loaded in this test (the module-level snapshot in
// prompt-overrides.ts starts empty and nothing here calls
// loadPromptOverrides), so resolvePrompt(id, fallback) always returns
// fallback — the fragment content equals the compiled-in description exactly.

import { describe, expect, it } from "vitest";

import {
  CAPABILITY_DEFINITIONS,
  generateCapabilityDescriptions,
} from "@ibatexas/packs-composed/capability-definitions";

import { ibatexasPromptFragments, RESPONDER_GROUNDED_SURFACE } from "../ibatexas-prompts.js";

describe("ibatexasPromptFragments — capability fragments mirror generateCapabilityDescriptions (FE-T22 prompt hints)", () => {
  const generated = generateCapabilityDescriptions(CAPABILITY_DEFINITIONS);
  const fragments = ibatexasPromptFragments();
  const byId = new Map(fragments.map((f) => [f.id, f]));

  it("projects exactly 20 capability descriptions, matching the 20 chat-tier definitions (post-FE-T09 D-a: 18→20)", () => {
    expect(Object.keys(generated)).toHaveLength(20);
  });

  it("every generated {kind: description} has a matching capability fragment, byte-identical content", async () => {
    for (const [kind, description] of Object.entries(generated)) {
      const fragment = byId.get(`ibatexas/capability.${kind}`);
      expect(fragment, `fragment for "${kind}" must be registered`).toBeDefined();
      const content = await fragment!.content({
        cognition: undefined as never,
        capabilities: [kind],
      });
      expect(content).toBe(`- ${kind}: ${description}`);
    }
  });

  it("carries no capability fragment for a kind the generator does not project (no stale/orphaned prompt fragment)", () => {
    const generatedKinds = new Set(Object.keys(generated));
    const capabilityFragmentIds = fragments
      .map((f) => f.id)
      .filter((id) => id.startsWith("ibatexas/capability."));
    expect(capabilityFragmentIds).toHaveLength(generatedKinds.size);
    for (const id of capabilityFragmentIds) {
      const kind = id.slice("ibatexas/capability.".length);
      expect(generatedKinds.has(kind), `orphaned fragment id "${id}"`).toBe(true);
    }
  });

  it("every capability fragment applies only on the responder-grounded surface", () => {
    for (const id of [...byId.keys()].filter((k) => k.startsWith("ibatexas/capability."))) {
      const fragment = byId.get(id)!;
      const kind = id.slice("ibatexas/capability.".length);
      expect(
        fragment.applies({
          cognition: undefined as never,
          capabilities: [kind],
          extra: { surface: RESPONDER_GROUNDED_SURFACE },
        }),
      ).toBe(true);
      expect(
        fragment.applies({
          cognition: undefined as never,
          capabilities: [kind],
          extra: { surface: "planner" },
        }),
      ).toBe(false);
    }
  });
});
