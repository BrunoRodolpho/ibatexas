// ops-drift-parity — the boot-time ops-plane parity gate (NEW-032 slice B).
//
// Fail-closed like the chat roster/read gates: every ops-registry tool must be
// composed-router-routable (kind ∈ installed packs) with capability===intentKind,
// and every ops-advertised read (ops_snapshot) must have a registered executor.

import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@claustrum/core";
import { composedIntentKinds } from "@ibatexas/packs-composed";
import {
  CAPABILITY_DEFINITIONS,
  generateOpsForbiddenDestructiveKinds,
} from "@ibatexas/catalog";
import { opsPlaneDriftProblems } from "../ops-conductor.js";
import {
  listOpsToolDefinitions,
  type OpsToolRegistryDeps,
} from "../ops-tool-registry.js";

// FE-4 CONTRACT (FE-T26): opsPlaneDriftProblems's forbiddenOpsKinds is now
// REQUIRED — every call below supplies the real generated set.
const FORBIDDEN_KINDS = generateOpsForbiddenDestructiveKinds(CAPABILITY_DEFINITIONS);

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
  // BKL-088 — the alert-resolve + incident-close SYSTEM-write layers.
  opsAlertSvc: {
    resolveAlertFromEnvelope: async () => ({ result: { status: "RESOLVED" } }),
  },
  incidentSvc: {
    closeIncidentFromEnvelope: async () => ({ result: { status: "RESOLVED" } }),
  },
  // SCN-127 — the schedule-override write layer + cache invalidation.
  scheduleSvc: { upsertOverride: async () => ({ date: "2026-07-10", isOpen: false }) },
  invalidateScheduleCache: async () => ({ ok: true }),
};

const OPS_TOOLS = listOpsToolDefinitions(REGISTRY_DEPS);

describe("opsPlaneDriftProblems", () => {
  it("is GREEN for the real ops registry + both advertised read executors", () => {
    const problems = opsPlaneDriftProblems({
      opsTools: OPS_TOOLS,
      composedIntentKinds: composedIntentKinds(),
      // Both staff-advertised reads (NEW-032 ops_snapshot + NEW-012
      // ops_sales_analytics) must have a registered executor.
      readExecutorKeys: ["ops_snapshot", "ops_sales_analytics"],
      forbiddenOpsKinds: FORBIDDEN_KINDS,
    });
    expect(problems).toEqual([]);
  });

  it("registers the six governed ops verbs incl. the BKL-088 resolution verbs (capability===intentKind, all pack-owned)", () => {
    const caps = OPS_TOOLS.map((t) => t.capability as unknown as string);
    // The two OWNED BKL-088 verbs are present AND composed-router-routable.
    expect(caps).toContain("ops.alert.resolve.staff");
    expect(caps).toContain("incident.ticket.close.staff");
    const kinds = new Set(composedIntentKinds());
    expect(kinds.has("ops.alert.resolve.staff")).toBe(true);
    expect(kinds.has("incident.ticket.close.staff")).toBe(true);
    // The SYSTEM-write kinds stay OFF the composed surface (D10 — a distinct
    // domain-internal layer, deliberately absent from KNOWN/composed).
    expect(kinds.has("ops.alert.resolve")).toBe(false);
    expect(kinds.has("incident.ticket.close")).toBe(false);
  });

  it("FAILS when the ops_snapshot read has no registered executor", () => {
    const problems = opsPlaneDriftProblems({
      opsTools: OPS_TOOLS,
      composedIntentKinds: composedIntentKinds(),
      readExecutorKeys: [], // ← dangling advertised read
      forbiddenOpsKinds: FORBIDDEN_KINDS,
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("ops_snapshot");
  });

  it("is GREEN for advertised⊆renderable with the real render-template keys (BKL-100)", () => {
    // No renderableReadKeys override → the real OPS_READ_RENDER_TEMPLATE_KEYS,
    // which has a template for both advertised reads.
    const problems = opsPlaneDriftProblems({
      opsTools: OPS_TOOLS,
      composedIntentKinds: composedIntentKinds(),
      readExecutorKeys: ["ops_snapshot", "ops_sales_analytics"],
      forbiddenOpsKinds: FORBIDDEN_KINDS,
    });
    expect(problems).toEqual([]);
  });

  it("FAILS advertised⊆renderable when an advertised read has NO render template (BKL-100)", () => {
    const problems = opsPlaneDriftProblems({
      opsTools: OPS_TOOLS,
      composedIntentKinds: composedIntentKinds(),
      readExecutorKeys: ["ops_snapshot", "ops_sales_analytics"],
      // ops_sales_analytics is advertised but has no render template here.
      renderableReadKeys: ["ops_snapshot"],
      forbiddenOpsKinds: FORBIDDEN_KINDS,
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("ops_sales_analytics");
    expect(problems.join("\n")).toContain("render template");
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
      readExecutorKeys: ["ops_snapshot", "ops_sales_analytics"],
      forbiddenOpsKinds: FORBIDDEN_KINDS,
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("ops.bogus.kind");
  });
});
