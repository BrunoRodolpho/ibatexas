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
import {
  CAPABILITY_DEFINITIONS,
  generateCapabilityDescriptions,
} from "@ibatexas/packs-composed/capability-definitions";
import {
  IBATEXAS_CAPABILITY_DESCRIPTIONS,
  listIbatexasToolPacks,
} from "../tools/register-ibatexas-tool-packs.js";

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

/**
 * FE-T21 — the VALUE side of "the registered tool roster" family member:
 * `IBATEXAS_CAPABILITY_DESCRIPTIONS` (this file's own module, keyed by
 * `capability` — same keys the tests above already pin). Lives here, not
 * in packages/packs-composed, because `IBATEXAS_CAPABILITY_DESCRIPTIONS`
 * is an apps/api export and packages cannot import apps/api (the reverse
 * of the normal dependency direction) — mirrors why
 * `assertCapabilityGuardRefsWired`'s own tests (FE-T19) live in apps/api
 * too, not in packs-composed.
 */
describe("FE-T21 — generateCapabilityDescriptions vs the real IBATEXAS_CAPABILITY_DESCRIPTIONS", () => {
  it("reproduces the real, live description map byte-for-byte (all 18 entries)", () => {
    const generated = generateCapabilityDescriptions(CAPABILITY_DEFINITIONS);
    expect(generated).toEqual(IBATEXAS_CAPABILITY_DESCRIPTIONS);
  });

  it("has exactly 18 entries, matching the pinned roster size", () => {
    expect(Object.keys(IBATEXAS_CAPABILITY_DESCRIPTIONS)).toHaveLength(18);
    expect(
      Object.keys(generateCapabilityDescriptions(CAPABILITY_DEFINITIONS)),
    ).toHaveLength(18);
  });
});
