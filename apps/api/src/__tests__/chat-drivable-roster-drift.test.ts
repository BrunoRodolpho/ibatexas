/**
 * T1a-2 — chat-drivable roster drift gate.
 *
 * `@ibatexas/packs-composed` exports `CHAT_DRIVABLE_TOOL_KINDS`: the data
 * mirror of the 20 LLM-callable mutating tool capability ids registered by
 * `listIbatexasToolPacks()` here in apps/api (post-FE-T09 D-a: 18→20). The
 * journey gates (`ibx journey lint` / `coverage`, DR-5) consume the mirror
 * because an apps/api export is unreachable from packages/* by design.
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

  it("pins the verified WS3 roster size (20, post-FE-T09 D-a)", () => {
    expect(CHAT_DRIVABLE_TOOL_KINDS).toHaveLength(20);
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

// FE-T26 review NIT (accepted, Opus review of PR #267) — the DESCRIPTIONS
// repoint above decoupled each `makeTool({...description: "..."})` inline
// literal (register-ibatexas-tool-packs.ts) from
// `IBATEXAS_CAPABILITY_DESCRIPTIONS`: they were identical BY CONSTRUCTION
// before this ticket (the map used to read `.description` off these same
// tool objects), and are now two independently-editable strings with no
// gate pinning them equal. `capability-fragments.test.ts` (cited above)
// verifies the GENERATED map drives the real prompt; it says nothing about
// whether the INLINE literal has silently drifted from it. The describe
// block below closes that gap with a genuine value-equality check, walking
// the real runtime tool registry (`listIbatexasToolPacks()`), not a
// re-derivation of either side.
//
// Whether the inline literal is itself ever LLM-facing (raised in review,
// for a future delete-the-inline-literals decision) — traced the installed
// dependency tree (`@claustrum/core` 0.7.0 + `@claustrum/anthropic` +
// `@claustrum/openai` + `@claustrum/channel-web` + `@claustrum/channel-
// whatsapp`). `@claustrum/core`'s `ToolRegistry.resolveCapabilities(ctx)`
// DOES copy `tool.description` into a returned `CapabilityDescriptor`
// (`tools/registry.ts`'s `descriptorOf`) — but `resolveCapabilities()` has
// ZERO call sites anywhere in this repo's own source (`apps/api`,
// `packages/*`) or in any installed `@claustrum/*` package; only
// `resolveTool()` (dispatch, ignores `.description`) is ever actually
// called on the registry `apps/api/src/claustrum-bootstrap.ts` builds.
// Separately, `@claustrum/anthropic`/`@claustrum/openai`'s provider layer
// DOES thread a generic `description` field into the real model-API wire
// tool schema (`provider.ts`'s `req.tools.map(...description...)`) — but
// that list is caller-supplied, and per CLAUDE.md rule #9 ibatexas's
// planner sends the model exactly one tool (`express_intent`), never these
// 18 individual `ToolDefinition`s. Net: as of `@claustrum/core@0.7.0`, the
// inline literals are NOT read by anything reachable at runtime today —
// but `resolveCapabilities()` is still live on the public `ToolRegistry`
// contract, so this is "unread today," not "structurally dead": a future
// caller (or a `@claustrum/core` bump wiring `resolveCapabilities` into the
// model-facing surface) could start reading it. Deleting the literals now
// would be safe against everything currently reachable; keeping this test
// as the tripwire until that contract is re-verified at the next
// `@claustrum/core` bump is the more conservative call this ticket makes,
// not a decision to delete them.
describe("FE-T26 review NIT — inline tool descriptions pinned to the generated map", () => {
  const GENERATED = generateCapabilityDescriptions(CAPABILITY_DEFINITIONS);

  it("every live tool's inline description === generateCapabilityDescriptions(CAPABILITY_DEFINITIONS)'s value for its capability", () => {
    const tools = listIbatexasToolPacks();
    // POSITIVE control: cardinality, so a future roster shrink can't make
    // the loop below pass vacuously over zero tools.
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const capability = tool.capability as unknown as string;
      expect(
        GENERATED[capability],
        `capability "${capability}" must have a generated description`,
      ).toBeDefined();
      expect(
        tool.description,
        `tool ${tool.id}'s inline description must match the generated ` +
          `description for capability "${capability}"`,
      ).toBe(GENERATED[capability]);
    }
  });
});
