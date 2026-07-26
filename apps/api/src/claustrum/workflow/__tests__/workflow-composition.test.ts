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
  resolveActivityTool,
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
