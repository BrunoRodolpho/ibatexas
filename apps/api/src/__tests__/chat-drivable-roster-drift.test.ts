/**
 * T1a-2 — chat-drivable roster drift gate.
 *
 * `@ibatexas/packs-composed` exports `CHAT_DRIVABLE_TOOL_KINDS`: the data
 * mirror of the 18 LLM-callable mutating tool capability ids registered by
 * `listIbatexasToolPacks()` here in apps/api. The journey gates
 * (`ibx journey lint` / `coverage`, DR-5) consume the mirror because an
 * apps/api export is unreachable from packages/* by design.
 *
 * This test is the fail-closed pin (same spirit as `toolRosterDrift`):
 * if the live roster and the mirror ever diverge — a tool added, dropped,
 * or renamed without updating the composed data export — the api suite
 * goes red instead of the journey gates silently linting against a stale
 * chat surface.
 */

import { describe, expect, it } from "vitest";
import { CHAT_DRIVABLE_TOOL_KINDS } from "@ibatexas/packs-composed";
import { listIbatexasToolPacks } from "../tools/register-ibatexas-tool-packs.js";

describe("T1a-2 — chat-drivable roster drift", () => {
  it("CHAT_DRIVABLE_TOOL_KINDS has no duplicates", () => {
    expect(new Set(CHAT_DRIVABLE_TOOL_KINDS).size).toBe(
      CHAT_DRIVABLE_TOOL_KINDS.length,
    );
  });

  it("mirrors the live registered roster exactly (both directions)", () => {
    const live = listIbatexasToolPacks().map(
      (t) => t.capability as unknown as string,
    );
    // Same cardinality + same membership = set equality both ways.
    expect(CHAT_DRIVABLE_TOOL_KINDS).toHaveLength(live.length);
    expect(new Set(CHAT_DRIVABLE_TOOL_KINDS)).toEqual(new Set(live));
  });

  it("pins the verified WS3 roster size (18)", () => {
    expect(CHAT_DRIVABLE_TOOL_KINDS).toHaveLength(18);
  });

  it("every mirrored kind keys capability === intentKind on the live tool", () => {
    const byCapability = new Map(
      listIbatexasToolPacks().map((t) => [
        t.capability as unknown as string,
        t.intentKind as unknown as string,
      ]),
    );
    for (const kind of CHAT_DRIVABLE_TOOL_KINDS) {
      expect(byCapability.get(kind), `kind ${kind} must be registered`).toBe(
        kind,
      );
    }
  });
});

// FE-4 CONTRACT (FE-T26) — RETIRED-AS-TAUTOLOGICAL: the "FE-T21 —
// generateCapabilityDescriptions vs the real IBATEXAS_CAPABILITY_
// DESCRIPTIONS" describe block that lived here compared
// `generateCapabilityDescriptions(CAPABILITY_DEFINITIONS)` against
// `IBATEXAS_CAPABILITY_DESCRIPTIONS` (register-ibatexas-tool-packs.ts).
// This ticket repointed that constant to literally BE
// `generateCapabilityDescriptions(CAPABILITY_DEFINITIONS)` — the two sides
// are now the same expression, so the comparison always passes by
// construction and proves nothing (FE-4.3's "generated-vs-generated"
// tautology). Retired rather than left in place vacuously passing; the
// surviving independent check for this data is `claustrum/prompts/
// __tests__/ibatexas-prompts.capability-fragments.test.ts` (FE-T22),
// which verifies the descriptions actually drive the REAL rendered prompt
// fragments — a genuine runtime-materialization check this repoint didn't
// touch. Recorded in docs/architecture/design/fe4-drift-gates.md.
