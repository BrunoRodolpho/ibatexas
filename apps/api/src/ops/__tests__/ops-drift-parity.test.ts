// ops-drift-parity — the boot-time ops-plane parity gate (NEW-032 slice B).
//
// Fail-closed like the chat roster/read gates: every ops-registry tool must be
// composed-router-routable (kind ∈ installed packs) with capability===intentKind,
// and every ops-advertised read (ops_snapshot) must have a registered executor.

import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@claustrum/core";
import { composedIntentKinds } from "@ibatexas/packs-composed";
import { opsPlaneDriftProblems } from "../ops-conductor.js";
import {
  listOpsToolDefinitions,
  type OpsToolRegistryDeps,
} from "../ops-tool-registry.js";

const REGISTRY_DEPS: OpsToolRegistryDeps = {
  medusaAdjudicated: (async () => ({})) as never,
  auditSink: {} as never,
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
};

const OPS_TOOLS = listOpsToolDefinitions(REGISTRY_DEPS);

describe("opsPlaneDriftProblems", () => {
  it("is GREEN for the real ops registry + ops_snapshot executor", () => {
    const problems = opsPlaneDriftProblems({
      opsTools: OPS_TOOLS,
      composedIntentKinds: composedIntentKinds(),
      readExecutorKeys: ["ops_snapshot"],
    });
    expect(problems).toEqual([]);
  });

  it("FAILS when the ops_snapshot read has no registered executor", () => {
    const problems = opsPlaneDriftProblems({
      opsTools: OPS_TOOLS,
      composedIntentKinds: composedIntentKinds(),
      readExecutorKeys: [], // ← dangling advertised read
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("ops_snapshot");
  });

  it("FAILS on a synthetic dangling tool whose kind no installed pack owns", () => {
    const danglingTool = {
      id: "ibatexas.ops.bogus.v1",
      capability: "ops.bogus.kind" as never,
      intentKind: "ops.bogus.kind" as never,
      description: "x",
      inputSchema: {},
      outputSchema: {},
      riskLevel: "low",
      execute: async () => ({}),
    } as unknown as ToolDefinition<unknown, unknown>;
    const problems = opsPlaneDriftProblems({
      opsTools: [...OPS_TOOLS, danglingTool],
      composedIntentKinds: composedIntentKinds(),
      readExecutorKeys: ["ops_snapshot"],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("ops.bogus.kind");
  });
});
