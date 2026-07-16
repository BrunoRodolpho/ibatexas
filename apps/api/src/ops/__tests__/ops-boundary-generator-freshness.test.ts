// FE-T24 — FE-4 MIGRATE 4b (the FINAL migrate batch): ops-boundary family,
// target 2 — FORBIDDEN_OPS_DESTRUCTIVE_KINDS freshness + boot-gate
// equivalence.
//
// `FORBIDDEN_OPS_DESTRUCTIVE_KINDS` (../ops-verb-scope.ts, BKL-096) is
// apps/api-owned, so its freshness test lives here (packages cannot import
// apps/*) — `generateOpsForbiddenDestructiveKinds`'s pure behavior is
// covered in packages/packs-composed's own
// capability-definitions.ops-boundary-family.test.ts.
//
// This file does TWO things generate-and-diff alone cannot:
//   1. Byte-identity against the REAL committed constant.
//   2. Proves the ops-plane boot gate (`opsPlaneDriftProblems`'s BKL-096
//      forbidden-verb check) would behave IDENTICALLY if fed the generated
//      set instead of the hand-authored one — WITHOUT repointing production
//      code (the ticket's "nothing repointed" constraint). `opsPlaneDrift
//      Problems` reads `FORBIDDEN_OPS_DESTRUCTIVE_KINDS` as a module-level
//      import, not a parameter, so this re-implements the EXACT check loop
//      (see ops-conductor.ts's own BKL-096 comment) parameterized on a
//      forbidden set, and runs it against the same two probes
//      ops-forbidden-destructive-drift.test.ts already exercises against
//      the real constant: the real 8-verb registry (must stay GREEN) and a
//      synthetic forbidden-tool injection (must FLAG). Identical outcomes
//      on both probes, using the GENERATED set, is the equivalence proof.

import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@claustrum/core";
import {
  CAPABILITY_DEFINITIONS,
  generateOpsForbiddenDestructiveKinds,
} from "@ibatexas/packs-composed/capability-definitions";

import { FORBIDDEN_OPS_DESTRUCTIVE_KINDS } from "../ops-verb-scope.js";
import {
  listOpsToolDefinitions,
  type OpsToolRegistryDeps,
} from "../ops-tool-registry.js";

// Minimal registry deps — only the SHAPE of the 8 tool definitions matters
// here, never the executor bodies (mirrors ops-forbidden-destructive-drift
// .test.ts / ops-drift-parity.test.ts's own fixture).
const REGISTRY_DEPS: OpsToolRegistryDeps = {
  medusaAdjudicated: (async () => ({})) as never,
  auditSink: {} as never,
  readProductBrlVariantIds: async () => ["variant_1"],
  orderCmdSvc: {
    writeAdjudicatedNote: async () => ({ noteId: "n", orderId: "o" }),
    writeAdjudicatedStatusTransition: async () => ({
      version: 2,
      previousStatus: "preparing",
      newStatus: "ready",
      displayId: 1,
      customerId: null,
    }),
  },
  dailySpecialSvc: {
    list: async () => [],
    create: async () => ({ id: "special_1" }),
    update: async () => ({ id: "special_1" }),
  },
  publishOrderStatusChanged: async () => {},
  paymentCmdSvc: {
    writeAdjudicatedRefund: async () => ({
      version: 2,
      previousStatus: "paid",
      newStatus: "refunded",
      totalRefundedCentavos: 100,
      refundAmountCentavos: 100,
      orderId: "o",
      method: "pix",
    }),
  },
  publishPaymentStatusChanged: async () => {},
  appendRefundEventLog: async () => {},
  opsAlertSvc: {
    resolveAlertFromEnvelope: async () => ({ result: { status: "RESOLVED" } }),
  },
  incidentSvc: {
    closeIncidentFromEnvelope: async () => ({ result: { status: "RESOLVED" } }),
  },
  scheduleSvc: { upsertOverride: async () => ({ date: "2026-07-10", isOpen: false }) },
  invalidateScheduleCache: async () => ({ ok: true }),
};

const OPS_TOOLS = listOpsToolDefinitions(REGISTRY_DEPS);

describe("generateOpsForbiddenDestructiveKinds — byte-identical to the real FORBIDDEN_OPS_DESTRUCTIVE_KINDS (FE-T24)", () => {
  it("projects a Set equal to the real committed constant", () => {
    const generated = generateOpsForbiddenDestructiveKinds(CAPABILITY_DEFINITIONS);
    expect(generated).toEqual(FORBIDDEN_OPS_DESTRUCTIVE_KINDS);
  });

  it("pins the real constant's contents too, guarding against both sides drifting together silently", () => {
    expect([...FORBIDDEN_OPS_DESTRUCTIVE_KINDS].sort()).toEqual([
      "order.cancel",
      "payment.status.force",
      "payment.waive",
    ]);
  });
});

/**
 * Re-implements opsPlaneDriftProblems's BKL-096 forbidden-verb check loop
 * verbatim (see ops-conductor.ts), parameterized on the forbidden set — the
 * substitution point production code does not expose, so equivalence is
 * proven by re-running the SAME probes against this local copy instead of
 * repointing the real function.
 */
function forbiddenVerbProblems(
  opsTools: ReadonlyArray<ToolDefinition<unknown, unknown>>,
  forbidden: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  for (const tool of opsTools) {
    const capability = String(tool.capability);
    const intentKind = String(tool.intentKind);
    if (forbidden.has(capability) || forbidden.has(intentKind)) {
      problems.push(
        `ops registry advertises FORBIDDEN two-person destructive verb ` +
          `"${capability}" (tool ${tool.id})`,
      );
    }
  }
  return problems;
}

describe("BKL-096 boot-gate equivalence — the GENERATED forbidden set behaves identically to the real one (FE-T24)", () => {
  const generatedForbidden = generateOpsForbiddenDestructiveKinds(CAPABILITY_DEFINITIONS);

  it("is GREEN on the real 8-verb ops registry using the GENERATED set (matches the real constant's own green boot state)", () => {
    expect(forbiddenVerbProblems(OPS_TOOLS, generatedForbidden)).toEqual([]);
    // Same real registry, same real (hand-authored) constant — the baseline
    // this proves equivalence AGAINST.
    expect(forbiddenVerbProblems(OPS_TOOLS, FORBIDDEN_OPS_DESTRUCTIVE_KINDS)).toEqual([]);
  });

  it("FLAGS a synthetic forbidden ops tool using the GENERATED set — identically to the real constant", () => {
    const forbiddenTool = {
      id: "ibatexas.ops.forceCancel.v1",
      capability: "order.cancel" as never,
      intentKind: "order.cancel" as never,
      description: "x",
      inputSchema: {},
      outputSchema: {},
      riskLevel: "high",
      execute: async () => ({}),
    } as unknown as ToolDefinition<unknown, unknown>;

    const withForbiddenTool = [...OPS_TOOLS, forbiddenTool];
    const generatedProblems = forbiddenVerbProblems(withForbiddenTool, generatedForbidden);
    const realProblems = forbiddenVerbProblems(withForbiddenTool, FORBIDDEN_OPS_DESTRUCTIVE_KINDS);

    expect(generatedProblems.length).toBeGreaterThan(0);
    // Byte-identical outcome, not just "both non-empty" — proves the
    // generated set isn't merely a superset/subset that happens to catch it.
    expect(generatedProblems).toEqual(realProblems);
    expect(generatedProblems.join("\n")).toContain("order.cancel");
  });
});
