/**
 * RC-A1 Phase A.3 — tool-roster integrity gate.
 *
 * The capability-key blocker (cycle-4 discovery): claustrum's `dispatchDecision`
 * resolves a tool via `capsule.tools.resolveTool(envelope.kind)`, but the
 * registry keys tools by `capability` (tool-registry.ts `byCapability`). If
 * `capability !== intentKind`, every kernel-approved EXECUTE fails with
 * `tool_unresolved`. This test is the drift detector that keeps the
 * reconciliation (`capability := intentKind`, every kind pack-owned) from
 * silently regressing. The same `toolRosterDrift()` helper is run fail-closed at
 * boot in claustrum-bootstrap.ts.
 */

import { describe, expect, it } from "vitest";
import { ordersPack } from "@ibatexas/pack-orders";
import { paymentsPack } from "@ibatexas/pack-payments";
import { reservationsPack } from "@ibatexas/pack-reservations";
import { customerOnboardingPack } from "@ibatexas/pack-customer-onboarding";
import { whatsappPack } from "@ibatexas/pack-whatsapp";
import {
  listIbatexasToolPacks,
  toolRosterDrift,
} from "../tools/register-ibatexas-tool-packs.js";

// The integrity-gate target set: unionOf(packs.flatMap(p => p.intents)).
const PACKS = [
  ordersPack,
  paymentsPack,
  reservationsPack,
  customerOnboardingPack,
  whatsappPack,
] as ReadonlyArray<{ readonly intents: ReadonlyArray<string> }>;

const PACK_INTENT_UNION: string[] = PACKS.flatMap((p) => [...p.intents]);

describe("RC-A1 Phase A — tool roster integrity", () => {
  it("has at least one registered tool (guards against a silently empty roster)", () => {
    expect(listIbatexasToolPacks().length).toBeGreaterThan(0);
  });

  it("every tool has capability === intentKind (dispatch resolves by kind)", () => {
    for (const tool of listIbatexasToolPacks()) {
      expect(
        tool.capability as unknown as string,
        `tool ${tool.id} capability must equal intentKind`,
      ).toBe(tool.intentKind as unknown as string);
    }
  });

  it("every tool's intentKind is owned by an installed pack", () => {
    const union = new Set(PACK_INTENT_UNION);
    for (const tool of listIbatexasToolPacks()) {
      const kind = tool.intentKind as unknown as string;
      expect(
        union.has(kind),
        `tool ${tool.id} intentKind "${kind}" must be in the pack intent union`,
      ).toBe(true);
    }
  });

  it("toolRosterDrift reports zero problems for the live roster", () => {
    expect(toolRosterDrift(listIbatexasToolPacks(), PACK_INTENT_UNION)).toEqual(
      [],
    );
  });

  it("toolRosterDrift flags a mis-keyed tool as tool_unresolved risk", () => {
    const misKeyed = [
      { id: "bad.tool.v1", capability: "cart.add_item", intentKind: "order.item.add" },
    ] as unknown as ReturnType<typeof listIbatexasToolPacks>;
    const problems = toolRosterDrift(misKeyed, PACK_INTENT_UNION);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("tool_unresolved");
  });

  it("toolRosterDrift flags a tool whose kind no pack owns", () => {
    const orphan = [
      { id: "orphan.tool.v1", capability: "nope.unknown", intentKind: "nope.unknown" },
    ] as unknown as ReturnType<typeof listIbatexasToolPacks>;
    const problems = toolRosterDrift(orphan, PACK_INTENT_UNION);
    expect(problems.some((p) => p.includes("not owned by any installed pack"))).toBe(
      true,
    );
  });
});
