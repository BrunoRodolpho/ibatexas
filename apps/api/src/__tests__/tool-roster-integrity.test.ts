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
import { Channel } from "@ibatexas/types";
import { ordersPack } from "@ibatexas/pack-orders";
import { paymentsPack } from "@ibatexas/pack-payments";
import { reservationsPack } from "@ibatexas/pack-reservations";
import { customerOnboardingPack } from "@ibatexas/pack-customer-onboarding";
import { whatsappPack } from "@ibatexas/pack-whatsapp";
import {
  agentCtxFromCapsule,
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
];

// WS4 — pack-owned intents advertised by paymentsCapabilityPlanner that ship NO
// `@ibatexas/tools` handler, so they are intentionally NOT registered. The
// roster asserts registered ⊆ pack-owned (not the reverse), so these dangle.
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
    expect(caps).toHaveLength(17);
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

  // WS4 — the 2 payment kinds the planner advertises but no handler backs are
  // pack-owned yet NOT registered. This pins the "left for WS4" decision: if a
  // handler is ever added, this test must be updated alongside the roster.
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
