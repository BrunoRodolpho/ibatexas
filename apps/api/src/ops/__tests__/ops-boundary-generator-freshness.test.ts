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
//   2. Proves the ops-plane boot gate would behave IDENTICALLY if fed the
//      generated set instead of the hand-authored one — WITHOUT repointing
//      production code (the ticket's "nothing repointed" constraint).
//      `opsPlaneDriftProblems`'s BKL-096 forbidden-verb check is extracted
//      to `forbiddenOpsVerbProblems(opsTools, forbidden = FORBIDDEN_OPS_
//      DESTRUCTIVE_KINDS)` (ops-verb-scope.ts, review fix) — a pure,
//      parameterized function, not a hand-copied re-implementation that
//      could silently drift from the real message text. This test drives
//      that REAL function directly with the generated set, against the same
//      two probes ops-forbidden-destructive-drift.test.ts already exercises
//      against the real constant: the real 8-verb registry (must stay
//      GREEN) and a synthetic forbidden-tool injection (must FLAG, with
//      byte-identical problem text to the real-constant run).

import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@claustrum/core";
import {
  CAPABILITY_DEFINITIONS,
  generateOpsForbiddenDestructiveKinds,
} from "@ibatexas/packs-composed/capability-definitions";

import {
  FORBIDDEN_OPS_DESTRUCTIVE_KINDS,
  forbiddenOpsVerbProblems,
} from "../ops-verb-scope.js";
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

describe("BKL-096 boot-gate equivalence — the GENERATED forbidden set drives the REAL forbiddenOpsVerbProblems identically to the real constant (FE-T24)", () => {
  const generatedForbidden = generateOpsForbiddenDestructiveKinds(CAPABILITY_DEFINITIONS);

  it("is GREEN on the real 8-verb ops registry using the GENERATED set (matches the real constant's own green boot state)", () => {
    expect(forbiddenOpsVerbProblems(OPS_TOOLS, generatedForbidden)).toEqual([]);
    // Same real registry, same real (hand-authored) constant, same REAL
    // function called with its own default — the baseline this proves
    // equivalence AGAINST.
    expect(forbiddenOpsVerbProblems(OPS_TOOLS)).toEqual([]);
  });

  it("FLAGS a synthetic forbidden ops tool using the GENERATED set — byte-identical problem text to the real constant", () => {
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
    // Real function, generated set.
    const generatedProblems = forbiddenOpsVerbProblems(withForbiddenTool, generatedForbidden);
    // Real function, its own default (FORBIDDEN_OPS_DESTRUCTIVE_KINDS) —
    // exactly what opsPlaneDriftProblems calls in production.
    const realProblems = forbiddenOpsVerbProblems(withForbiddenTool);

    expect(generatedProblems.length).toBeGreaterThan(0);
    // Byte-identical outcome — including the full "…owner ratifies a
    // propose-path (OPS-007/008/011)…" message text, since both runs go
    // through the SAME real function — not just "both non-empty".
    expect(generatedProblems).toEqual(realProblems);
    expect(generatedProblems.join("\n")).toContain("order.cancel");
    expect(generatedProblems.join("\n")).toContain("OPS-007/008/011");
  });
});
