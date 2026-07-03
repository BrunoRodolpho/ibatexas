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
import type { Capsule } from "@claustrum/core";
import type { CapabilityPlanner } from "@adjudicate/core/llm";
import { Channel } from "@ibatexas/types";
// P0-8: the five first-party packs are named in exactly ONE site — the
// composed package. This test consumes the same composition boot does.
import {
  IBATEXAS_COMPOSED_CAPABILITY_PLANNERS,
  IBATEXAS_COMPOSED_PACKS,
  composedIntentKinds,
} from "@ibatexas/packs-composed";
import {
  agentCtxFromCapsule,
  listIbatexasToolPacks,
  readToolRosterDrift,
  toolRosterDrift,
  ROSTER_DRIFT_CONTEXTS,
} from "../tools/register-ibatexas-tool-packs.js";

// The integrity-gate target set — derived from the composed pack list itself.
const PACK_INTENT_UNION: ReadonlyArray<string> = composedIntentKinds();

// WS3 — the VERIFIED LLM-callable mutating roster. Every entry is a capability
// string confirmed === its pack intentKind and a handler confirmed exported from
// `@ibatexas/tools`. The count is the integrity anchor for (c) below: adding or
// dropping a tool must update this set deliberately.
const EXPECTED_CAPABILITIES = [
  // pack-orders (10)
  "order.cart.ensure",
  "order.item.add",
  "order.item.update",
  "order.item.remove",
  "order.coupon.apply",
  "order.checkout.create",
  "order.cancel",
  "order.amend.request",
  "order.note.add",
  "order.review.submit",
  // pack-reservations (4)
  "reservation.create",
  "reservation.modify",
  "reservation.cancel",
  "reservation.waitlist.join",
  // pack-customer-onboarding (2)
  "customer.preferences.update",
  "customer.pix.details.save",
  // pack-payments (1)
  "payment.pix.regenerate",
  // pack-whatsapp (1) — BKL-030 customer-side escalation on-ramp
  "whatsapp.handoff.request",
];

// WS4 — pack-owned intents that ship NO `@ibatexas/tools` handler, so they are
// intentionally NOT registered. P0-7 de-advertised them in pack-payments (a
// planner-advertised kind with no tool would now FAIL the context-aware drift
// leg); the WS4 backlog restores the advertisement alongside the handlers.
const DANGLING_PAYMENT_KINDS = ["payment.method.switch", "payment.retry"];

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

  // (c) — the roster count matches the verified WS3 set exactly.
  it("registers exactly the verified WS3 roster (count + capabilities)", () => {
    const caps = listIbatexasToolPacks().map(
      (t) => t.capability as unknown as string,
    );
    expect(caps).toHaveLength(EXPECTED_CAPABILITIES.length);
    expect(caps).toHaveLength(18);
    expect(new Set(caps)).toEqual(new Set(EXPECTED_CAPABILITIES));
  });

  // (b) framed as the asymmetric invariant — registered ⊆ pack-owned. Every
  // registered capability is a valid pack intent; we deliberately do NOT require
  // the reverse (pack-owned ⊆ registered) because of the WS4 dangling kinds.
  it("registered ⊆ pack-owned (every registered capability is a valid pack intent)", () => {
    const union = new Set(PACK_INTENT_UNION);
    for (const tool of listIbatexasToolPacks()) {
      const cap = tool.capability as unknown as string;
      expect(union.has(cap), `capability "${cap}" must be pack-owned`).toBe(true);
    }
  });

  // WS4 — the 2 payment kinds without a handler stay pack-owned yet NOT
  // registered (and, since P0-7, NOT planner-advertised). This pins the "left
  // for WS4" decision: when a handler ships, this test must be updated
  // alongside the roster AND the pack planner's advertisement.
  it("leaves payment.method.switch + payment.retry pack-owned but unregistered (WS4)", () => {
    const union = new Set(PACK_INTENT_UNION);
    const registered = new Set(
      listIbatexasToolPacks().map((t) => t.intentKind as unknown as string),
    );
    for (const kind of DANGLING_PAYMENT_KINDS) {
      expect(union.has(kind), `${kind} should be pack-owned`).toBe(true);
      expect(registered.has(kind), `${kind} should NOT be registered (WS4)`).toBe(
        false,
      );
    }
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

// ── P0-7 — context-aware roster drift ────────────────────────────────────────
//
// The advertised surface is context-dependent (planners gate allowedIntents on
// customerId / staffId / isAuthenticated), so the gate probes the named
// contexts in ROSTER_DRIFT_CONTEXTS and asserts advertised ⊆ registered per
// context. The composition under test is the REAL boot composition —
// IBATEXAS_COMPOSED_CAPABILITY_PLANNERS from @ibatexas/packs-composed, exactly
// what claustrum-bootstrap passes.

/** Run the gate over the real boot composition, capturing WARN output. */
function runBootDrift(): { problems: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const problems = toolRosterDrift(listIbatexasToolPacks(), PACK_INTENT_UNION, {
    planners: IBATEXAS_COMPOSED_CAPABILITY_PLANNERS,
    onWarn: (m) => warnings.push(m),
  });
  return { problems, warnings };
}

describe("P0-7 — context-aware roster drift", () => {
  it("probes the two named contexts the design documents (authed-customer, staff)", () => {
    const names = ROSTER_DRIFT_CONTEXTS.map((c) => c.name);
    expect(names).toContain("authed-customer");
    expect(names).toContain("staff");
  });

  it("the real boot composition passes drift (composed planners, all contexts)", () => {
    expect(runBootDrift().problems).toEqual([]);
  });

  it("composes the five first-party packs (guards a hollowed composition)", () => {
    expect(IBATEXAS_COMPOSED_PACKS).toHaveLength(5);
    expect(IBATEXAS_COMPOSED_CAPABILITY_PLANNERS).toHaveLength(5);
  });

  // The staff-chat exception: reservation.checkin/complete are STAFF-ROUTE-ONLY
  // BY DESIGN (live chat pins staffId:null; admin routes build envelopes
  // directly), yet the reservations planner advertises them for a staff
  // session. The whitelist must absorb that — and must not be vacuous.
  it("the staff probe really advertises the whitelisted staff kinds (non-vacuous)", () => {
    const staff = ROSTER_DRIFT_CONTEXTS.find((c) => c.name === "staff");
    expect(staff).toBeDefined();
    const advertised = new Set(
      IBATEXAS_COMPOSED_CAPABILITY_PLANNERS.flatMap((p) => [
        ...p.plan(staff!.state, staff!.context).allowedIntents,
      ]),
    );
    expect(advertised.has("reservation.checkin")).toBe(true);
    expect(advertised.has("reservation.complete")).toBe(true);
  });

  it("whitelists reservation.checkin/complete under the staff context (no drift)", () => {
    const { problems } = runBootDrift();
    expect(
      problems.filter(
        (p) => p.includes("reservation.checkin") || p.includes("reservation.complete"),
      ),
    ).toEqual([]);
  });

  // WARN-only on registered-but-unadvertised: order.review.submit has a
  // registered tool but no planner advertises it under any probed context
  // (reviews arrive via the web flow) — dead chat weight, never a failure.
  it("WARNs (never fails) on registered-but-unadvertised kinds — order.review.submit", () => {
    const { problems, warnings } = runBootDrift();
    expect(problems).toEqual([]);
    expect(warnings.some((w) => w.includes("order.review.submit"))).toBe(true);
    expect(warnings.every((w) => w.includes("WARN only"))).toBe(true);
  });

  it("a synthetic planner-advertised-but-unregistered kind under authed-customer FAILS drift", () => {
    // Re-creates the exact dangle P0-7 de-advertised: a planner offers
    // `payment.method.switch` (pack-owned, no registered tool) to an
    // authenticated customer.
    const synthetic: CapabilityPlanner<unknown, unknown> = {
      plan(state) {
        const ctx = (
          state as {
            ctx?: { isAuthenticated?: boolean; staffId?: string | null };
          }
        ).ctx;
        const authedCustomer =
          ctx?.isAuthenticated === true && (ctx?.staffId ?? null) === null;
        return {
          visibleReadTools: [],
          allowedIntents: authedCustomer ? ["payment.method.switch"] : [],
        };
      },
    };
    const problems = toolRosterDrift(listIbatexasToolPacks(), PACK_INTENT_UNION, {
      planners: [...IBATEXAS_COMPOSED_CAPABILITY_PLANNERS, synthetic],
      onWarn: () => {},
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(
      problems.some(
        (p) =>
          p.includes('"authed-customer"') &&
          p.includes("payment.method.switch") &&
          p.includes("tool_unresolved"),
      ),
    ).toBe(true);
  });
});

// ── BKL-071 — read-side roster drift (readToolRosterDrift) ───────────────────
//
// The READ twin of toolRosterDrift: every read a planner advertises
// (Plan.visibleReadTools, unioned over ROSTER_DRIFT_CONTEXTS) must have a
// registered executor, else the one-hop enrichment loop offers a read the
// runtime cannot execute. Fail-closed leg returns problems; the reverse leg
// (executor keyed to an unadvertised read) is WARN-only. Tests exercise the
// FUNCTION against synthetic executor-key sets derived from the REAL composed
// planners — the live wiring (executor map ⊇ advertised reads) is separately
// pinned by ibatexas-planner.test.ts, which imports the real executor map.

/** The live advertised read surface, unioned across the named drift contexts. */
const ADVERTISED_READS: readonly string[] = [
  ...new Set(
    IBATEXAS_COMPOSED_CAPABILITY_PLANNERS.flatMap((p) =>
      ROSTER_DRIFT_CONTEXTS.flatMap((c) => [
        ...p.plan(c.state, c.context).visibleReadTools,
      ]),
    ),
  ),
];

describe("BKL-071 — read-tool roster drift", () => {
  it("derives a non-vacuous advertised-read surface (guards a hollowed probe)", () => {
    expect(ADVERTISED_READS.length).toBeGreaterThanOrEqual(12);
    expect(ADVERTISED_READS).toContain("get_payment_history");
    expect(ADVERTISED_READS).toContain("get_cart");
  });

  it("reports zero problems when every advertised read has a registered executor", () => {
    expect(
      readToolRosterDrift(IBATEXAS_COMPOSED_CAPABILITY_PLANNERS, ADVERTISED_READS),
    ).toEqual([]);
  });

  it("FAILS (a problem) when an advertised read has no registered executor", () => {
    // Drop the last-wired read from the executor key set → it now dangles.
    const missingOne = ADVERTISED_READS.filter((r) => r !== "get_payment_history");
    const problems = readToolRosterDrift(
      IBATEXAS_COMPOSED_CAPABILITY_PLANNERS,
      missingOne,
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes("get_payment_history"))).toBe(true);
    expect(problems.every((p) => p.includes("no registered executor"))).toBe(true);
  });

  it("WARNs (never fails) when an executor is keyed to an UNadvertised read", () => {
    const warnings: string[] = [];
    const problems = readToolRosterDrift(
      IBATEXAS_COMPOSED_CAPABILITY_PLANNERS,
      [...ADVERTISED_READS, "get_ghost_read"],
      { onWarn: (m) => warnings.push(m) },
    );
    expect(problems).toEqual([]);
    expect(warnings.some((w) => w.includes("get_ghost_read"))).toBe(true);
    expect(warnings.every((w) => w.includes("WARN only"))).toBe(true);
  });
});

// ── WS3 — Capsule → AgentContext adapter ─────────────────────────────────────

/** Minimal Capsule double carrying only the fields agentCtxFromCapsule reads. */
function mkCapsule(over: {
  customerId: string;
  channel?: "whatsapp" | "web";
  role?: "customer" | "staff" | "admin" | "support" | "system";
}): Capsule {
  return {
    customerId: over.customerId,
    channel: over.channel ?? "web",
    conversationId: "conv-xyz",
    actor: {
      principal: "llm",
      sessionId: "conv-xyz",
      ...(over.role ? { role: over.role } : {}),
    },
  } as unknown as Capsule;
}

describe("WS3 — agentCtxFromCapsule", () => {
  it("maps an authenticated customer Capsule onto a customer AgentContext", () => {
    const ctx = agentCtxFromCapsule(mkCapsule({ customerId: "cus_123", channel: "web" }));
    expect(ctx).toEqual({
      channel: Channel.Web,
      sessionId: "conv-xyz",
      customerId: "cus_123",
      userType: "customer",
    });
  });

  it("maps a whatsapp channel kind onto the Channel.WhatsApp enum", () => {
    const ctx = agentCtxFromCapsule(
      mkCapsule({ customerId: "cus_123", channel: "whatsapp" }),
    );
    expect(ctx.channel).toBe(Channel.WhatsApp);
  });

  it("treats a guest: marker as a guest (undefined customerId, userType guest)", () => {
    const ctx = agentCtxFromCapsule(mkCapsule({ customerId: "guest:abc" }));
    expect(ctx.userType).toBe("guest");
    expect(ctx.customerId).toBeUndefined();
    expect("customerId" in ctx).toBe(false);
  });

  it("treats an empty customerId as a guest", () => {
    const ctx = agentCtxFromCapsule(mkCapsule({ customerId: "  " }));
    expect(ctx.userType).toBe("guest");
    expect(ctx.customerId).toBeUndefined();
  });

  it("maps a staff/admin/support actor role onto userType staff", () => {
    for (const role of ["staff", "admin", "support"] as const) {
      const ctx = agentCtxFromCapsule(mkCapsule({ customerId: "stf_1", role }));
      expect(ctx.userType, role).toBe("staff");
      expect(ctx.customerId, role).toBe("stf_1");
    }
  });
});
