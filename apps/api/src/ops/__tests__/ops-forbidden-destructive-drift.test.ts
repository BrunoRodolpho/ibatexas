// ops-forbidden-destructive-drift — BKL-096, defense in depth.
//
// The two-person / separation-of-duty DESTRUCTIVE verbs (order.cancel force-
// cancel, payment.waive, payment.status.force) are unreachable by the ops persona
// TODAY via TWO independent fail-closed layers: (1) none is in the ops tool
// registry (ops-tool-registry.ts advertises 8 verbs); (2) none is in the staff-
// role matrix (staff-role-matrix.ts), so an `admin:` envelope carrying one REFUSEs
// `kind_not_in_staff_matrix` at the composed router. That posture is SOUND but
// IMPLICIT. This suite makes the exclusion EXPLICIT + drift-guarded: it pins that
// none of FORBIDDEN_OPS_DESTRUCTIVE_KINDS can enter the ops REGISTRY or the ops
// planner's advertised surface on EITHER ingress scope, with a POSITIVE control so
// the assertions can never pass vacuously. It does NOT build a propose-path — the
// owner-ratification on whether the persona may ever PROPOSE these is deferred
// (OPS-007/008/011). It also asserts the ops-advertised PROJECTION kind
// order.status.transition cannot leak force-cancel semantics (BKL-090 terminal
// gate).

import { describe, expect, it } from "vitest";
import { adjudicate } from "@adjudicate/core/kernel";
import { buildEnvelope } from "@adjudicate/core";
import type { ToolDefinition } from "@claustrum/core";
import { composedIntentKinds } from "@ibatexas/packs-composed";
import {
  opsCapabilityPlanner,
  OPS_ALERT_RESOLVE_STAFF_KIND,
  OPS_FOREIGN_ADVERTISED_KIND,
  OPS_FOREIGN_ADVERTISED_REFUND_KIND,
  OPS_FOREIGN_ADVERTISED_TRANSITION_KIND,
  OPS_INCIDENT_CLOSE_STAFF_KIND,
  OPS_SCHEDULE_OVERRIDE_SET_KIND,
  type OpsContext,
  type OpsState,
} from "@ibatexas/pack-ops";
import {
  ordersPolicyBundle,
  type OrderIntentKind,
  type OrderPayload,
  type OrderState,
} from "@ibatexas/pack-orders";
import { opsPlaneDriftProblems } from "../ops-conductor.js";
import {
  listOpsToolDefinitions,
  type OpsToolRegistryDeps,
} from "../ops-tool-registry.js";
import {
  excludedKindsForScope,
  FORBIDDEN_OPS_DESTRUCTIVE_KINDS,
  scopeCapabilityPlanner,
} from "../ops-verb-scope.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** The pack-owned destructive verb kinds this contract forbids — taken from the
 *  source-of-truth constant so the assertions below track any edit to it. */
const FORBIDDEN = [...FORBIDDEN_OPS_DESTRUCTIVE_KINDS];

/** The eight governed ops verbs the persona MAY drive today (the positive
 *  control set — the drift test must confirm these ARE advertised so an empty
 *  allowlist can never make the ∩-with-forbidden assertions pass vacuously). */
const ALLOWED_OPS_VERBS = [
  "product.availability.set",
  "product.price.set",
  // SCN-114 — the daily-special-by-message verb.
  "menu.special.set",
  OPS_ALERT_RESOLVE_STAFF_KIND,
  OPS_INCIDENT_CLOSE_STAFF_KIND,
  OPS_SCHEDULE_OVERRIDE_SET_KIND,
  OPS_FOREIGN_ADVERTISED_KIND,
  OPS_FOREIGN_ADVERTISED_TRANSITION_KIND,
  OPS_FOREIGN_ADVERTISED_REFUND_KIND,
];

const STAFF_STATE: OpsState = {
  ctx: { channel: "staff", customerId: null, staffId: "staff_1" },
};
const STAFF_CTX: OpsContext = {
  channel: "staff",
  customerId: null,
  staffId: "staff_1",
};

/** Minimal registry deps (mirrors ops-drift-parity.test.ts) — only the SHAPE of
 *  the 8 tool definitions matters here, never the executor bodies. */
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

// ── (a) the ops tool registry excludes every forbidden verb ──────────────────

describe("BKL-096 — forbidden verbs are absent from the ops tool registry", () => {
  const capabilities = OPS_TOOLS.map((t) => String(t.capability));
  const intentKinds = OPS_TOOLS.map((t) => String(t.intentKind));

  it("pins the forbidden set to exactly the three two-person destructive verbs", () => {
    expect([...FORBIDDEN_OPS_DESTRUCTIVE_KINDS].sort()).toEqual([
      "order.cancel",
      "payment.status.force",
      "payment.waive",
    ]);
  });

  it("no ops tool advertises a forbidden destructive verb (capability OR intentKind)", () => {
    for (const forbidden of FORBIDDEN) {
      expect(capabilities).not.toContain(forbidden);
      expect(intentKinds).not.toContain(forbidden);
    }
  });

  it("POSITIVE control: the registry DOES advertise the eight governed ops verbs", () => {
    // Without this the "not.toContain" above could pass on an empty registry.
    for (const verb of ALLOWED_OPS_VERBS) {
      expect(capabilities).toContain(verb);
    }
    expect(capabilities).toHaveLength(ALLOWED_OPS_VERBS.length);
  });
});

// ── (b)+(c) the ops planner advertises no forbidden verb on ANY ingress ──────

describe("BKL-096 — forbidden verbs are absent from the ops planner surface", () => {
  it("(b) STAFF-probe dashboard planner: allowedIntents ∩ forbidden = ∅ (+ positive control)", () => {
    const plan = opsCapabilityPlanner.plan(STAFF_STATE, STAFF_CTX);
    for (const forbidden of FORBIDDEN) {
      expect(plan.allowedIntents).not.toContain(forbidden);
    }
    // POSITIVE control: the staff probe DOES advertise all eight governed verbs,
    // so the ∅-intersection above is a real subtraction, not a vacuous pass.
    for (const verb of ALLOWED_OPS_VERBS) {
      expect(plan.allowedIntents).toContain(verb);
    }
  });

  it("(c) neither ingress scope (dashboard | whatsapp) advertises a forbidden verb", () => {
    for (const scope of ["dashboard", "whatsapp"] as const) {
      const scoped = scopeCapabilityPlanner(
        opsCapabilityPlanner,
        excludedKindsForScope(scope),
      );
      const plan = scoped.plan(STAFF_STATE, STAFF_CTX);
      for (const forbidden of FORBIDDEN) {
        expect(plan.allowedIntents).not.toContain(forbidden);
      }
      // Positive control per scope: dashboard advertises all 8; whatsapp drops the
      // irreversible refund (BKL-086) but still advertises the reversible verbs —
      // proving the scope filter never silently empties the allowlist.
      expect(plan.allowedIntents).toContain("product.availability.set");
      expect(plan.allowedIntents).toContain(OPS_FOREIGN_ADVERTISED_TRANSITION_KIND);
      expect(plan.allowedIntents.length).toBeGreaterThanOrEqual(
        ALLOWED_OPS_VERBS.length - 1,
      );
    }
  });
});

// ── boot drift gate: the ops registry fails closed on a forbidden entry ──────

describe("BKL-096 — opsPlaneDriftProblems fails closed on a forbidden ops tool", () => {
  it("is GREEN on the real 8-verb ops registry (no forbidden false-positive)", () => {
    const problems = opsPlaneDriftProblems({
      opsTools: OPS_TOOLS,
      composedIntentKinds: composedIntentKinds(),
      // Both staff-advertised reads (NEW-032 + NEW-012) have registered executors.
      readExecutorKeys: ["ops_snapshot", "ops_sales_analytics"],
    });
    expect(problems).toEqual([]);
  });

  it("FLAGS a synthetic ops tool that registers a forbidden destructive verb", () => {
    // `order.cancel` is composed-router-routable with capability===intentKind, so
    // toolRosterDrift is satisfied — ONLY the BKL-096 forbidden gate should fire,
    // proving the boot check catches the verb by identity, not incidentally.
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
    });
    expect(problems.length).toBeGreaterThan(0);
    const joined = problems.join("\n");
    expect(joined).toContain("FORBIDDEN");
    expect(joined).toContain("order.cancel");
  });
});

// ── the ops PROJECTION kind can't leak force-cancel semantics (BKL-090) ──────

describe("BKL-096 — the advertised order.status.transition can't force a terminal jump", () => {
  it("REFUSEs an admin: transition out of a CANCELED (terminal) status", () => {
    const decision = adjudicate(
      buildEnvelope({
        kind: "order.status.transition" as OrderIntentKind,
        payload: { orderId: "o-1", newStatus: "preparing" } as OrderPayload,
        actor: { principal: "user", sessionId: "admin:staff_1" },
        taint: "UNTRUSTED",
        nonce: "n-terminal",
        createdAt: "2026-07-04T12:00:00.000Z",
      }),
      {
        ctx: {
          channel: "web",
          customerId: null,
          cartId: null,
          orderId: "o-1",
          fulfillmentStatus: "canceled",
        },
      } as OrderState,
      ordersPolicyBundle,
    );
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind !== "REFUSE") return;
    // The projection-kind kitchen-advance is BKL-090-legality-gated: a terminal
    // (canceled/delivered) current status has no legal next state, so a
    // force-cancel-shaped jump can never EXECUTE through it.
    expect(decision.refusal.code).toBe("order.status.terminal");
  });
});
