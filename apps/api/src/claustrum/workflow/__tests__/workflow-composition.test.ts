// LE2-021 — the two decisions extracted out of the workflow composition root.
//
// Both were previously inline in `buildWorkflowRuntime`, unreachable from a test
// and RE-IMPLEMENTED in the e2e harness. That second half is the reason these
// matter more than their size suggests: the harness's copy of the dispatch
// closure used `list().find(...)` where production used `resolveTool`, and the
// divergence was invisible for exactly as long as neither had a test.

import { describe, expect, it } from "vitest";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import {
  activityIdentityBase,
  activitySessionArg,
  CART_ID_ACTIVITY_KINDS,
  feasibilityActor,
  ORDER_CTX_ACTIVITY_KINDS,
  resolveActivityTool,
  stampOrderActivityPayload,
} from "../workflow-composition.js";

function envelope(
  actor: Record<string, unknown> = { principal: "llm", sessionId: "s-1" },
): IntentEnvelope {
  return buildEnvelope({
    kind: "order.reorder",
    payload: {},
    actor: actor as never,
    taint: "UNTRUSTED",
    nonce: "n-1",
  }) as IntentEnvelope;
}

describe("activityIdentityBase — WHO an activity is adjudicated as", () => {
  it("carries the bound channel through, unmodified", () => {
    // The load-bearing one. `canCheckout` reads the channel, so a WhatsApp
    // activity adjudicated as "web" meets the wrong rules on real money.
    expect(
      activityIdentityBase(envelope({ customerId: "c1" }), "whatsapp", "ibatexas").channel,
    ).toBe("whatsapp");
  });

  it("falls back to web ONLY when no turn is bound", () => {
    // Not a default for conversational traffic — every conversational path binds
    // a channel. This is the degrade for a caller outside a bound turn, and it
    // has to be a consistent identity rather than `undefined`.
    expect(activityIdentityBase(envelope(), undefined, "ibatexas").channel).toBe("web");
  });

  it("DERIVES isAuthenticated from the resolved customer id, never from a claim", () => {
    // The actor rides an envelope, so anything it asserted about its own
    // authentication would be a self-report. Presence of a resolved id is the
    // only fact here an upstream stage established — so an actor that claims to
    // be authenticated while carrying no customer id is NOT.
    expect(
      activityIdentityBase(envelope({ customerId: "c1" }), "web", "t").isAuthenticated,
    ).toBe(true);
    expect(activityIdentityBase(envelope(), "web", "t").isAuthenticated).toBe(false);
    expect(
      activityIdentityBase(
        envelope({ isAuthenticated: true, authenticated: true }),
        "web",
        "t",
      ).isAuthenticated,
    ).toBe(false);
  });

  it("normalises an absent customer id to null, not undefined", () => {
    // `loadCartCtx` and the guards downstream distinguish "no customer" from
    // "field missing"; only one of them is a value they can reason about.
    expect(activityIdentityBase(envelope(), "web", "t").customerId).toBeNull();
  });

  it("pins staffId to null — a workflow acts for the confirming customer only", () => {
    expect(
      activityIdentityBase(envelope({ customerId: "c1", staffId: "st-9" }), "web", "t")
        .staffId,
    ).toBeNull();
  });

  it("falls back to the ibatexas tenant when none is configured", () => {
    expect(activityIdentityBase(envelope(), "web", undefined).tenantId).toBe("ibatexas");
    expect(activityIdentityBase(envelope(), "web", "outra").tenantId).toBe("outra");
  });
});

describe("activitySessionArg", () => {
  it("passes the actor's session handle through", () => {
    expect(activitySessionArg(envelope({ sessionId: "conv-1" }))).toEqual({
      sessionId: "conv-1",
    });
  });

  it("OMITS the key entirely when there is no session — never `{sessionId: undefined}`", () => {
    // The cart loader branches on key presence, so an explicit undefined and an
    // absent key are different inputs to it.
    const arg = activitySessionArg(envelope({ principal: "llm" }));
    expect(arg).toEqual({});
    expect("sessionId" in arg).toBe(false);
  });
});

describe("resolveActivityTool — WHICH implementation an activity runs", () => {
  /** A registry double that records which question was asked. */
  function registry(): {
    readonly asked: string[];
    readonly resolveTool: (kind: string) => { id: string };
  } {
    const asked: string[] = [];
    return {
      asked,
      resolveTool: (kind: string) => {
        asked.push(kind);
        return { id: `resolved:${kind}` };
      },
    };
  }

  it("asks the registry to RESOLVE the kind — the last-write-wins question", () => {
    // Not `list().find(...)`. The registry keeps every registration for a
    // capability and `list()` is insertion-ordered, so a find takes the FIRST
    // while the conductor's dispatch takes the winner. An activity that ran a
    // shadowed implementation would be a different mutation from the one a
    // parsed request performs, with an identical audit row.
    const reg = registry();
    const tool = resolveActivityTool(reg as never, envelope(), { turnId: "t" });
    expect(reg.asked).toEqual(["order.reorder"]);
    expect((tool as unknown as { id: string }).id).toBe("resolved:order.reorder");
  });

  it("THROWS for a missing registry, naming the kind", () => {
    // A silent no-op would report a SUCCESSFUL step in the trace for a mutation
    // that never ran — the most misleading row an operator could be shown.
    expect(() => resolveActivityTool(undefined, envelope(), {})).toThrow(
      /no tool registry for activity kind order\.reorder/,
    );
  });
});

// ── LE2-023 · the host-resolved payload stamp ───────────────────────────────
//
// The fields no `WorkflowParamSource` may carry: an ORDER ID (an identifier, so
// never model-authored) and the BKL-103 `actorId` PROPOSER STAMP (without which
// an escalated in-saga cancel is unapprovable — the customer is told a human
// will review it and no human can).

describe("stampOrderActivityPayload — LE2-023", () => {
  const IDENT = { customerId: "cus_1", orderId: "order_prev_9" };

  it("stamps orderId and actorId for an order-ctx activity", () => {
    const out = stampOrderActivityPayload({
      capability: "order.cancel",
      payload: {},
      customerId: IDENT.customerId,
      orderId: IDENT.orderId,
    });
    expect(out).toEqual({ orderId: "order_prev_9", actorId: "cus_1" });
  });

  it("leaves a NON-order activity's payload byte-identical", () => {
    // The stamp is opt-in by kind. `order.reorder` and `order.coupon.apply` are
    // both `order.`-prefixed and both want cart state, which is exactly why the
    // gate is a named set and not a prefix test.
    const payload = { code: "BEMVINDO10" };
    for (const capability of ["order.reorder", "order.coupon.apply"]) {
      expect(
        stampOrderActivityPayload({
          capability,
          payload,
          customerId: IDENT.customerId,
          orderId: IDENT.orderId,
        }),
      ).toBe(payload);
    }
  });

  it("NEVER overwrites an authored binding", () => {
    // A workflow that declared its own value said something deliberate; silently
    // replacing it would make the definition a lie about what runs.
    const out = stampOrderActivityPayload({
      capability: "order.cancel",
      payload: { orderId: "order_authored", actorId: "actor_authored" },
      customerId: IDENT.customerId,
      orderId: IDENT.orderId,
    });
    expect(out).toEqual({ orderId: "order_authored", actorId: "actor_authored" });
  });

  it("stamps NOTHING it cannot resolve, leaving the guards armed", () => {
    // Fail-safe in the direction that keeps `requireOrderIdForMutation` able to
    // REFUSE. A placeholder would produce an envelope that looks well-formed to
    // every guard and names no real order.
    expect(
      stampOrderActivityPayload({
        capability: "order.cancel",
        payload: {},
        customerId: null,
        orderId: undefined,
      }),
    ).toEqual({});

    expect(
      stampOrderActivityPayload({
        capability: "order.cancel",
        payload: {},
        customerId: "cus_1",
        orderId: undefined,
      }),
    ).toEqual({ actorId: "cus_1" });
  });

  it("gates on order.cancel and nothing else, for now", () => {
    expect([...ORDER_CTX_ACTIVITY_KINDS]).toEqual(["order.cancel"]);
  });
});

describe("feasibilityActor — WHICH identity a pre-check projection is grounded under", () => {
  // The LE2-023 defect this closes: `checkFeasibility` was called with the bare
  // `plannerEnvelopeActor`, which carries no customerId, so every auth-gated fact
  // read absent and the FIRST pre-check refused the workflow for every customer
  // alive. See the function's own doc.
  const ENVELOPE_ACTOR = { principal: "llm", sessionId: "conv-1" } as never;

  it("adds the customer the planner already derived, keeping the rest intact", () => {
    const actor = feasibilityActor(ENVELOPE_ACTOR, { ctx: { customerId: "cus_1" } });
    expect(actor.customerId).toBe("cus_1");
    // The envelope actor's own fields survive — the session handle is what the
    // cart read is keyed on, so dropping it would break the other half.
    expect(actor.principal).toBe("llm");
    expect(actor.sessionId).toBe("conv-1");
  });

  it("returns the actor UNCHANGED when there is no customer", () => {
    // Fail-closed, and the same object rather than a copy: a guest projection
    // must stay customer-less so every owner-scoped read is skipped rather than
    // run against an empty id.
    for (const derived of [
      undefined,
      {},
      { ctx: {} },
      { ctx: { customerId: null } },
      { ctx: { customerId: "" } },
      { ctx: { customerId: "   " } },
      { ctx: { customerId: 42 } },
    ]) {
      expect(feasibilityActor(ENVELOPE_ACTOR, derived)).toBe(ENVELOPE_ACTOR);
    }
  });

  it("trims, because a padded id is not an id", () => {
    expect(feasibilityActor(ENVELOPE_ACTOR, { ctx: { customerId: " cus_2 " } }).customerId).toBe(
      "cus_2",
    );
  });

  it("NON-VACUITY — the bare envelope actor really does carry no customer", () => {
    // Without this, the first case above could be passing because every actor
    // happens to have a customerId already. It does not, and that absence IS the
    // bug this function exists to close.
    expect(
      (ENVELOPE_ACTOR as { customerId?: unknown }).customerId,
    ).toBeUndefined();
  });
});

describe("stampOrderActivityPayload — the CART id half (LE2-023)", () => {
  // `requireCartIdForCartOps` reads `payload.cartId`, and a cart id is an
  // identifier, so no `WorkflowParamSource` may carry it. Without this stamp the
  // swap-for-coupon route's last step is REFUSED and the saga never completes.

  it("stamps the session cart onto order.coupon.apply", () => {
    expect(
      stampOrderActivityPayload({
        capability: "order.coupon.apply",
        payload: { code: "BEMVINDO10" },
        customerId: "cus_1",
        orderId: undefined,
        cartId: "cart_rebuilt",
      }),
    ).toEqual({ code: "BEMVINDO10", cartId: "cart_rebuilt" });
  });

  it("stamps NOTHING when there is no session cart — the guard then REFUSEs", () => {
    // Fail-safe in the direction that leaves the guard armed. A placeholder
    // would produce an envelope that looks well-formed and names no real cart.
    expect(
      stampOrderActivityPayload({
        capability: "order.coupon.apply",
        payload: { code: "X" },
        customerId: "cus_1",
        orderId: undefined,
        cartId: undefined,
      }),
    ).toEqual({ code: "X" });
  });

  it("never overwrites an AUTHORED cartId", () => {
    // A workflow that bound its own value said something deliberate, and
    // silently replacing it would make the definition a lie about what runs.
    expect(
      stampOrderActivityPayload({
        capability: "order.coupon.apply",
        payload: { code: "X", cartId: "cart_authored" },
        customerId: "cus_1",
        orderId: undefined,
        cartId: "cart_session",
      }),
    ).toEqual({ code: "X", cartId: "cart_authored" });
  });

  it("does NOT stamp a cart onto a kind that did not ask for one", () => {
    // The de-vacuuming control: the set is what gates this, not the presence of
    // a cartId argument.
    expect(
      stampOrderActivityPayload({
        capability: "order.reorder",
        payload: {},
        customerId: "cus_1",
        orderId: "order_1",
        cartId: "cart_session",
      }),
    ).toEqual({});
  });

  it("keeps the two stamps on DISJOINT kinds — a cancel gets no cartId", () => {
    // order.cancel takes the order/actor stamp and must not acquire a cart id
    // it has no use for; order.coupon.apply takes the cart stamp and must not
    // acquire an actorId. Separate sets, separate branches, asserted together
    // so a future merge of the two cannot go unnoticed.
    expect(
      stampOrderActivityPayload({
        capability: "order.cancel",
        payload: {},
        customerId: "cus_1",
        orderId: "order_1",
        cartId: "cart_session",
      }),
    ).toEqual({ orderId: "order_1", actorId: "cus_1" });
    expect([...CART_ID_ACTIVITY_KINDS]).toEqual(["order.coupon.apply"]);
    expect([...ORDER_CTX_ACTIVITY_KINDS]).toEqual(["order.cancel"]);
  });
});
