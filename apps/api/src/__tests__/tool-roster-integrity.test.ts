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
// P0-8: the six first-party packs are named in exactly ONE site — the
// composed package. This test consumes the same composition boot does.
import {
  IBATEXAS_COMPOSED_CAPABILITY_PLANNERS,
  IBATEXAS_COMPOSED_PACKS,
  composedIntentKinds,
} from "@ibatexas/packs-composed";
import {
  CAPABILITY_DEFINITIONS,
  generateChatDrivableToolKinds,
} from "@ibatexas/packs-composed/capability-definitions";
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

// FE-T22 — the real chat-surfaced-kinds set, computed exactly like
// claustrum-bootstrap.ts computes it for the live boot call: every
// tier:"chat" CapabilityDefinition whose surfaces includes "chat".
const CHAT_SURFACED_KINDS: ReadonlySet<string> = new Set(
  generateChatDrivableToolKinds(CAPABILITY_DEFINITIONS),
);

/**
 * Run the gate over the real boot composition, capturing WARN output.
 * Defaults `chatSurfacedKinds` to the real surface-derived set (matching
 * live boot wiring) when the option is OMITTED. Pass `{ chatSurfacedKinds:
 * undefined }` explicitly (an `in`-check, not `??`, distinguishes "omitted"
 * from "present but undefined" — a bare optional-parameter default cannot,
 * since JS substitutes the default for an explicitly-passed `undefined` too)
 * to probe the gate's behavior with NO exemption granted (pre-FE-T22 shape,
 * minus the retired hand-written whitelist).
 */
function runBootDrift(
  options: { chatSurfacedKinds?: ReadonlySet<string> } = {},
): { problems: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const chatSurfacedKinds =
    "chatSurfacedKinds" in options ? options.chatSurfacedKinds : CHAT_SURFACED_KINDS;
  const problems = toolRosterDrift(listIbatexasToolPacks(), PACK_INTENT_UNION, {
    planners: IBATEXAS_COMPOSED_CAPABILITY_PLANNERS,
    onWarn: (m) => warnings.push(m),
    chatSurfacedKinds,
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

  it("composes the six first-party packs (guards a hollowed composition)", () => {
    expect(IBATEXAS_COMPOSED_PACKS).toHaveLength(6);
    expect(IBATEXAS_COMPOSED_CAPABILITY_PLANNERS).toHaveLength(6);
  });

  // The staff-chat exception: reservation.checkin/complete are STAFF-ROUTE-ONLY
  // BY DESIGN (live chat pins staffId:null; admin routes build envelopes
  // directly), yet the reservations planner advertises them for a staff
  // session. The surface-derived `chatSurfacedKinds` exemption must absorb
  // that — and must not be vacuous.
  it("the staff probe really advertises the surface-exempted staff kinds (non-vacuous)", () => {
    const staff = ROSTER_DRIFT_CONTEXTS.find((c) => c.name === "staff");
    expect(staff).toBeDefined();
    const advertised = new Set(
      IBATEXAS_COMPOSED_CAPABILITY_PLANNERS.flatMap((p) => [
        ...p.plan(staff!.state, staff!.context).allowedIntents,
      ]),
    );
    expect(advertised.has("reservation.checkin")).toBe(true);
    expect(advertised.has("reservation.complete")).toBe(true);
    // NEW-032 slice C1: the ops planner advertises product.availability.set
    // under the staff probe — proves the exemption is non-vacuous.
    expect(advertised.has("product.availability.set")).toBe(true);
  });

  it("exempts reservation.checkin/complete under the staff context (no drift)", () => {
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

  it("a synthetic planner-advertised-but-unregistered kind under authed-customer FAILS drift, EVEN WITH the production chatSurfacedKinds wired in", () => {
    // Re-creates the exact dangle P0-7 de-advertised: a planner offers
    // `payment.method.switch` (pack-owned, no registered tool, NOT
    // tier:"chat") to an authenticated customer.
    //
    // FE-T22 post-review load-bearing regression test: this MUST pass the
    // real production chatSurfacedKinds (not omit it, leaving the leg in
    // strict/undefined mode) — omitting it would never exercise the bug the
    // review caught, where a context-independent chatSurfacedKinds exemption
    // would have ALSO exempted this customer-facing dangle (payment.method.
    // switch is not chat-surfaced, so it would wrongly pass under the old,
    // unscoped exemption). Red under the pre-fix context-independent
    // exemption; green after scoping the exemption to `chatSurfaceExempt`
    // probes (today just "staff") via RosterDriftContext.chatSurfaceExempt.
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
    expect(CHAT_SURFACED_KINDS.has("payment.method.switch")).toBe(false);
    const problems = toolRosterDrift(listIbatexasToolPacks(), PACK_INTENT_UNION, {
      planners: [...IBATEXAS_COMPOSED_CAPABILITY_PLANNERS, synthetic],
      onWarn: () => {},
      chatSurfacedKinds: CHAT_SURFACED_KINDS,
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

  it("a synthetic planner-advertised-but-unregistered kind under staff IS exempted by the production chatSurfacedKinds (the mirror case — exemption still works where it should)", () => {
    // Symmetric to the authed-customer test above: the SAME kind
    // (payment.method.switch, not chat-surfaced), advertised under the
    // STAFF probe instead, must be EXEMPTED — proving chatSurfaceExempt
    // scoping didn't overcorrect into blanket strictness.
    const synthetic: CapabilityPlanner<unknown, unknown> = {
      plan(state) {
        const ctx = (
          state as { ctx?: { staffId?: string | null } }
        ).ctx;
        const isStaff = (ctx?.staffId ?? null) !== null;
        return {
          visibleReadTools: [],
          allowedIntents: isStaff ? ["payment.method.switch"] : [],
        };
      },
    };
    const problems = toolRosterDrift(listIbatexasToolPacks(), PACK_INTENT_UNION, {
      planners: [...IBATEXAS_COMPOSED_CAPABILITY_PLANNERS, synthetic],
      onWarn: () => {},
      chatSurfacedKinds: CHAT_SURFACED_KINDS,
    });
    expect(problems.some((p) => p.includes("payment.method.switch"))).toBe(false);
  });
});

// ── FE-T22 — chatSurfacedKinds pinned equivalence to the retired whitelist ──
//
// The retired `ADVERTISED_NOT_REGISTERED_WHITELIST` hand-listed exactly these
// 10 `<context>:<kind>` pairs (recovered from the pre-deletion const, all
// under the "staff" context: reservation.checkin/.complete + 8 ops-plane
// verbs). This is the safety net the ticket requires: pin the pre-deletion
// set as literals, then prove the surface-derived `chatSurfacedKinds`
// projection reproduces the exact same allowed (exempted) set — and that the
// exemption is doing real work, not vacuously passing because nothing probes
// it.
const PRE_DELETION_WHITELIST_PAIRS: ReadonlyArray<{
  readonly context: string;
  readonly kind: string;
}> = [
  { context: "staff", kind: "reservation.checkin" },
  { context: "staff", kind: "reservation.complete" },
  { context: "staff", kind: "product.availability.set" },
  { context: "staff", kind: "product.price.set" },
  { context: "staff", kind: "menu.special.set" },
  { context: "staff", kind: "order.status.transition" },
  { context: "staff", kind: "payment.refund.issue" },
  { context: "staff", kind: "ops.alert.resolve.staff" },
  { context: "staff", kind: "incident.ticket.close.staff" },
  { context: "staff", kind: "schedule.override.set" },
];

describe("FE-T22 — chatSurfacedKinds replaces ADVERTISED_NOT_REGISTERED_WHITELIST (pinned equivalence)", () => {
  it("the surface-derived set is exactly the 18 chat-tier kinds (T19's CHAT_DRIVABLE_TOOL_KINDS exemplar)", () => {
    expect(CHAT_SURFACED_KINDS.size).toBe(18);
  });

  it("none of the 10 pre-deletion whitelist kinds is chat-surfaced (every one is exempt by construction)", () => {
    for (const { kind } of PRE_DELETION_WHITELIST_PAIRS) {
      expect(CHAT_SURFACED_KINDS.has(kind), kind).toBe(false);
    }
  });

  it("the composed planners still advertise all 10 pre-deletion kinds under their pinned context (the exemption is non-vacuous)", () => {
    const advertisedByContext = new Map<string, Set<string>>();
    for (const probe of ROSTER_DRIFT_CONTEXTS) {
      advertisedByContext.set(
        probe.name,
        new Set(
          IBATEXAS_COMPOSED_CAPABILITY_PLANNERS.flatMap((p) => [
            ...p.plan(probe.state, probe.context).allowedIntents,
          ]),
        ),
      );
    }
    for (const { context, kind } of PRE_DELETION_WHITELIST_PAIRS) {
      expect(
        advertisedByContext.get(context)?.has(kind),
        `${context}:${kind} must still be advertised — else the exemption test below would be vacuous`,
      ).toBe(true);
    }
  });

  it("runBootDrift with the real surface-derived chatSurfacedKinds set reports zero problems for all 10 pairs (unchanged from the pre-deletion whitelist)", () => {
    const { problems } = runBootDrift();
    for (const { kind } of PRE_DELETION_WHITELIST_PAIRS) {
      expect(
        problems.some((p) => p.includes(kind)),
        `${kind} must not be flagged now that the surface-derived exemption is wired in`,
      ).toBe(false);
    }
  });

  it("runBootDrift WITHOUT any exemption (chatSurfacedKinds explicitly undefined) FAILS on all 10 pre-deletion pairs — proving the exemption is load-bearing, not a no-op", () => {
    const { problems } = runBootDrift({ chatSurfacedKinds: undefined });
    for (const { context, kind } of PRE_DELETION_WHITELIST_PAIRS) {
      expect(
        problems.some((p) => p.includes(`"${context}"`) && p.includes(kind)),
        `${context}:${kind} must be flagged as a problem with no exemption granted`,
      ).toBe(true);
    }
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
