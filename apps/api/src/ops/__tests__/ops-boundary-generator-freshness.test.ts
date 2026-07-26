// FE-4 CONTRACT (FE-T26) — ops-boundary family, target 2: the BKL-096
// forbidden-verb boot gate, now sourced SOLELY from `CapabilityDefinition`.
//
// History: FE-T24 authored `generateOpsForbiddenDestructiveKinds` and
// proved it byte-identical to the hand-authored `FORBIDDEN_OPS_
// DESTRUCTIVE_KINDS` (`../ops-verb-scope.ts`); FE-T25 extracted the
// forbidden-verb check into `forbiddenOpsVerbProblems` and repointed the
// real boot call to the generated set while keeping the hand constant
// alive as the function's DEFAULT parameter. This ticket (FE-T26) DELETES
// `FORBIDDEN_OPS_DESTRUCTIVE_KINDS` — its 3 kinds now live as
// `CapabilityDefinition.opsForbiddenDestructive: true` — and makes
// `forbiddenOpsVerbProblems`'s `forbidden` parameter REQUIRED (no default),
// so this file's old "byte-identical to the real constant" comparisons no
// longer have a second, independent side to diff against — RETIRED below,
// with rationale, rather than left referencing a deleted symbol.
//
// What SURVIVES: `generateOpsForbiddenDestructiveKinds`'s pure behavior is
// covered in packages/packs-composed's own capability-definitions.
// ops-boundary-family.test.ts (unaffected by this ticket). This file keeps
// the REAL boot-gate proof — `opsPlaneDriftProblems` (the actual export
// claustrum-bootstrap.ts calls), driven with the generated set, still
// fails closed on a real runtime/DI mismatch (a synthetic forbidden ops
// tool injected into the registry) — the genuine independent-runtime-
// materialization check FE-4.3 requires (`opsTools` is the real DI
// registry; only `forbidden` is CapabilityDefinition-derived).

import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@claustrum/core";
import { composedIntentKinds } from "@ibatexas/packs-composed";
import {
  CAPABILITY_DEFINITIONS,
  generateOpsForbiddenDestructiveKinds,
} from "@ibatexas/catalog";

import { opsPlaneDriftProblems } from "../ops-conductor.js";
import { forbiddenOpsVerbProblems } from "../ops-verb-scope.js";
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
const FORBIDDEN_KINDS = generateOpsForbiddenDestructiveKinds(CAPABILITY_DEFINITIONS);

describe("generateOpsForbiddenDestructiveKinds — the single source (FE-T26)", () => {
  it("projects exactly the 3 known forbidden kinds", () => {
    expect([...FORBIDDEN_KINDS].sort()).toEqual([
      "order.cancel",
      "payment.status.force",
      "payment.waive",
    ]);
  });
});

describe("forbiddenOpsVerbProblems — driven by the sole (generated) source (FE-T26)", () => {
  it("is GREEN on the real 8-verb ops registry", () => {
    expect(forbiddenOpsVerbProblems(OPS_TOOLS, FORBIDDEN_KINDS)).toEqual([]);
  });

  it("FLAGS a synthetic forbidden ops tool, message text intact", () => {
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

    const problems = forbiddenOpsVerbProblems([...OPS_TOOLS, forbiddenTool], FORBIDDEN_KINDS);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("order.cancel");
    expect(problems.join("\n")).toContain("OPS-007/008/011");
  });
});

// ── the FULL opsPlaneDriftProblems gate (FE-T25, re-verified post-CONTRACT) ──
//
// Drives the actual boot-anchor export claustrum-bootstrap.ts calls, with
// its REQUIRED `forbiddenOpsKinds` parameter — the real production wiring,
// proving the gate still fails closed on a real runtime/DI mismatch
// end-to-end, now that the generated set is the ONLY set.

describe("the FULL opsPlaneDriftProblems gate, sourced solely from CapabilityDefinition (FE-T26)", () => {
  it("is GREEN on the real 8-verb ops registry", () => {
    const problems = opsPlaneDriftProblems({
      opsTools: OPS_TOOLS,
      composedIntentKinds: composedIntentKinds(),
      readExecutorKeys: ["ops_snapshot", "ops_sales_analytics"],
      forbiddenOpsKinds: FORBIDDEN_KINDS,
    });
    expect(problems).toEqual([]);
  });

  it("REGRESSION PROOF: a REAL runtime/DI mismatch (a synthetic forbidden ops tool injected into the registry) FAILS CLOSED through the FULL gate — load-bearing end-to-end, not just at the helper level", () => {
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

    const problems = opsPlaneDriftProblems({
      opsTools: [...OPS_TOOLS, forbiddenTool],
      composedIntentKinds: composedIntentKinds(),
      readExecutorKeys: ["ops_snapshot", "ops_sales_analytics"],
      forbiddenOpsKinds: FORBIDDEN_KINDS,
    });
    expect(problems.length).toBeGreaterThan(0);
    const joined = problems.join("\n");
    expect(joined).toContain("FORBIDDEN");
    expect(joined).toContain("order.cancel");
  });
});
