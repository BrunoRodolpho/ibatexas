// Contract pins for the shared prompt-surface walk.
//
// This helper has TWO consumers (the F-65b date guard, and F-67's catalog
// completeness axis), so its contract is worth pinning directly rather than
// only through whatever its callers happen to assert. Each case below exists
// because getting it wrong produces a FALSE FINDING in a consumer, not merely
// a weaker one.

import { describe, expect, it } from "vitest";
import {
  asText,
  collectSurfaces,
  personaExports,
  promptTextExports,
} from "../prompt-surfaces.js";

describe("prompt-surfaces helper contract", () => {
  it("asText normalizes BOTH authored shapes and rejects non-text", () => {
    // The `string[]` arm is currently unexercised by any export (see the module
    // header). Pinning it here means a future array-authored persona is covered
    // on the day it lands, rather than silently skipped.
    expect(asText("a persona")).toBe("a persona");
    expect(asText(["line one", "line two"])).toBe("line one\nline two");
    expect(asText(["mixed", 42])).toBeNull();
    expect(asText(undefined)).toBeNull();
    expect(asText({ not: "text" })).toBeNull();
  });

  it("personaExports EXCLUDES non-prompt string exports", () => {
    // `EXPRESS_INTENT_TOOL` is a tool name, not prompt text. A consumer asking
    // "is every persona catalogued?" over the unfiltered walk would report it
    // as an uncatalogued persona — a false finding, which is the whole reason
    // the exclusion exists.
    const names = personaExports().map((e) => e.name);
    expect(names).not.toContain("EXPRESS_INTENT_TOOL");
    expect(promptTextExports().map((e) => e.name)).toContain("EXPRESS_INTENT_TOOL");
  });

  it("personaExports covers personas a catalog-only walk would miss", () => {
    // The reason this walk exists at all: the catalog is hand-maintained, so a
    // catalog-only enumeration is blind to whatever it happens to be missing
    // that day. OPS_CLAIM_PLANNER_PERSONA was exactly that case when this file
    // was written — live via `ops-conductor.ts`, absent from PROMPT_CATALOG.
    //
    // The name of this case used to say "the persona PROMPT_CATALOG omits",
    // which stopped being true when #570 catalogued it. The assertion below was
    // always the durable one (the walk reaches the persona, regardless of
    // catalog membership), so only the name and this comment needed correcting
    // — but a name that states an expired fact sends the next reader hunting a
    // defect that no longer exists. Same rot class as the assertion #573
    // removed, one altitude down.
    expect(personaExports().map((e) => e.name)).toContain("OPS_CLAIM_PLANNER_PERSONA");
  });

  it("every persona carries non-empty text, and every surface is attributable", () => {
    for (const { name, text } of personaExports()) {
      expect(text.length, name).toBeGreaterThan(0);
    }
    // A site id with no origin prefix cannot be traced back to a file by the
    // human reading a failure, which is what makes a red actionable.
    for (const [siteId, text] of collectSurfaces()) {
      expect(siteId, siteId).toMatch(/^(persona|catalog|capability|wire):/);
      expect(typeof text, siteId).toBe("string");
    }
  });
});
