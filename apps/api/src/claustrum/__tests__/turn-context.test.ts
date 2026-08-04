// turn-context — the ONE owner of the per-turn ambient-context choreography (R4-S2).
//
// The five production ingresses no longer hand-assemble the trio, so this suite is
// where the composition's properties are pinned:
//   - THE NESTING the module documents: funnel publish → wire → workflow → thunk.
//     Recorded through wrappers that DELEGATE to the real modules, so the order
//     assertion and the behavioural assertions below observe the same run.
//   - CLOSE ORDERING in one `finally`, on success AND on a thunk throw — the funnel
//     publish drops after the thunk either way, and both ALS wrappers unwind.
//   - THE DECLARED SUBSETS, asserted BOTH as config and BEHAVIOURALLY through the
//     contexts' own APIs: `wire-only` wires neither the workflow binding nor the
//     funnel context, and its wire capture really works (so `wire: true` is not
//     decorative).
//   - FAIL-CLOSED FUNNEL ABSENCE: under `wire-only`, `decideL0` stands down on the
//     same purely-social utterance it fires on under `customer-full`. That is the
//     omission being safe rather than merely undeclared.
//   - THE CONFIRM-WINDOW DERIVATION, the one spelling the two customer ingresses
//     used to carry separately.
//
// The recording wrappers are `importOriginal` delegates, NOT stubs: every context
// below is the production module doing its real work.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParkedEnvelope } from "@claustrum/core";

const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("../wire-capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wire-capture.js")>();
  return {
    ...actual,
    beginWireTurn: <T>(fn: () => Promise<T>): Promise<T> => {
      calls.push("beginWireTurn");
      return actual.beginWireTurn(fn);
    },
  };
});

vi.mock("../workflow/workflow-turn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workflow/workflow-turn.js")>();
  return {
    ...actual,
    beginWorkflowTurn: <T>(
      binding: import("../workflow/workflow-turn.js").WorkflowTurnBinding,
      fn: () => Promise<T>,
    ): Promise<T> => {
      calls.push("beginWorkflowTurn");
      return actual.beginWorkflowTurn(binding, fn);
    },
  };
});

vi.mock("../funnel-tier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../funnel-tier.js")>();
  return {
    ...actual,
    openFunnelTurn: (
      turnId: string,
      context: import("../funnel-tier.js").FunnelTurnContext,
    ): void => {
      calls.push("openFunnelTurn");
      actual.openFunnelTurn(turnId, context);
    },
    closeFunnelTurn: (turnId: string): void => {
      calls.push("closeFunnelTurn");
      actual.closeFunnelTurn(turnId);
    },
  };
});

const { decideL0, funnelTurnContext } = await import("../funnel-tier.js");
const { captureWireExchange, claimWireExchanges, sealWireCall } = await import(
  "../wire-capture.js"
);
const { currentWorkflowChannel, currentWorkflowTurnId } = await import(
  "../workflow/workflow-turn.js"
);
const {
  deriveConfirmWindowOpen,
  runTurnWithContexts,
  TURN_CONTEXT_SUBSETS,
} = await import("../turn-context.js");

/** A minimal park — the derivation reads only the list's LENGTH. */
function parked(hash: string): ParkedEnvelope {
  return {
    envelope: {
      intentHash: hash,
      kind: "product.availability.set",
    } as ParkedEnvelope["envelope"],
    confirmationToken: `tok-${hash}`,
    userPrompt: "86 a picanha",
    parkedAt: "2026-07-04T11:59:00.000Z",
  };
}

/** A purely social utterance — the only shape L0 ever claims. */
const SOCIAL = "oi, tudo bem?";

/** Record ONE wire exchange from inside the turn and seal it under `turnId`, the
 *  way the relay + `emitModelCallTrace` do. Returns what a flush would claim. */
function driveWireCapture(turnId: string): number {
  captureWireExchange({
    model: "nemotron",
    request: { messages: [] },
    response: { choices: [] },
    at: "2026-07-04T12:00:00.000Z",
  });
  sealWireCall(turnId);
  return claimWireExchanges(turnId).length;
}

let turnSeq = 0;
/** A fresh turnId per test — the funnel map and the wire buffer are both keyed by
 *  it and both process-global. */
function nextTurnId(): string {
  turnSeq += 1;
  return `t_ctx_${turnSeq}`;
}

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. THE NESTING
// ═══════════════════════════════════════════════════════════════════════════════

describe("nesting order", () => {
  it("customer-full applies funnel publish → wire → workflow → thunk", async () => {
    const turnId = nextTurnId();
    await runTurnWithContexts({
      subset: "customer-full",
      turnId,
      channel: "web",
      pendingConfirmations: undefined,
      thunk: async () => {
        calls.push("thunk");
      },
    });

    expect(calls).toEqual([
      "openFunnelTurn",
      "beginWireTurn",
      "beginWorkflowTurn",
      "thunk",
      "closeFunnelTurn",
    ]);
  });

  it("wire-only applies wire → thunk and nothing else", async () => {
    await runTurnWithContexts({
      subset: "wire-only",
      thunk: async () => {
        calls.push("thunk");
      },
    });

    expect(calls).toEqual(["beginWireTurn", "thunk"]);
  });

  it("all three customer-full contexts are live INSIDE the thunk, together", async () => {
    const turnId = nextTurnId();
    const seen = await runTurnWithContexts({
      subset: "customer-full",
      turnId,
      channel: "whatsapp",
      pendingConfirmations: undefined,
      thunk: async () => ({
        funnel: funnelTurnContext(turnId),
        workflowTurnId: currentWorkflowTurnId(),
        workflowChannel: currentWorkflowChannel(),
        wireExchanges: driveWireCapture(turnId),
      }),
    });

    expect(seen.funnel).toEqual({ confirmWindowOpen: false });
    expect(seen.workflowTurnId).toBe(turnId);
    expect(seen.workflowChannel).toBe("whatsapp");
    expect(seen.wireExchanges).toBe(1);
  });

  it("the thunk's resolved value is returned unchanged", async () => {
    const value = { text: "olá", nested: [1, 2] };
    await expect(
      runTurnWithContexts({ subset: "wire-only", thunk: async () => value }),
    ).resolves.toBe(value);
  });

  it("concurrent customer-full turns each read their OWN binding", async () => {
    const a = nextTurnId();
    const b = nextTurnId();
    const observe = (turnId: string, channel: string): Promise<string | undefined> =>
      runTurnWithContexts({
        subset: "customer-full",
        turnId,
        channel,
        pendingConfirmations: undefined,
        thunk: async () => {
          // Yield, so the two turns are genuinely interleaved before either reads.
          await new Promise((resolve) => setImmediate(resolve));
          return currentWorkflowTurnId();
        },
      });

    await expect(Promise.all([observe(a, "web"), observe(b, "whatsapp")])).resolves.toEqual([
      a,
      b,
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CLOSE ORDERING — one `finally`, both exits
// ═══════════════════════════════════════════════════════════════════════════════

describe("close ordering", () => {
  it("on SUCCESS the funnel publish drops after the thunk, and both wrappers unwind", async () => {
    const turnId = nextTurnId();
    await runTurnWithContexts({
      subset: "customer-full",
      turnId,
      channel: "web",
      pendingConfirmations: undefined,
      thunk: async () => {
        expect(funnelTurnContext(turnId)).toBeDefined();
        calls.push("thunk");
      },
    });

    expect(calls.indexOf("closeFunnelTurn")).toBeGreaterThan(calls.indexOf("thunk"));
    expect(funnelTurnContext(turnId)).toBeUndefined();
    expect(currentWorkflowTurnId()).toBeUndefined();
  });

  it("on a thunk THROW the funnel publish still drops, and the error propagates", async () => {
    const turnId = nextTurnId();
    const boom = new Error("handleTurn exploded");

    await expect(
      runTurnWithContexts({
        subset: "customer-full",
        turnId,
        channel: "web",
        pendingConfirmations: [parked("aaaa11112222")],
        thunk: async () => {
          calls.push("thunk");
          throw boom;
        },
      }),
    ).rejects.toBe(boom);

    expect(calls).toEqual([
      "openFunnelTurn",
      "beginWireTurn",
      "beginWorkflowTurn",
      "thunk",
      "closeFunnelTurn",
    ]);
    expect(funnelTurnContext(turnId)).toBeUndefined();
    expect(currentWorkflowTurnId()).toBeUndefined();
  });

  it("a SYNCHRONOUS throw from the thunk closes the funnel too", async () => {
    const turnId = nextTurnId();
    const boom = new Error("threw before the first await");

    await expect(
      runTurnWithContexts({
        subset: "customer-full",
        turnId,
        channel: "web",
        pendingConfirmations: undefined,
        thunk: (): Promise<never> => {
          calls.push("thunk");
          throw boom;
        },
      }),
    ).rejects.toBe(boom);

    expect(calls.at(-1)).toBe("closeFunnelTurn");
    expect(funnelTurnContext(turnId)).toBeUndefined();
  });

  it("a wire-only throw leaves no context behind either", async () => {
    const boom = new Error("ops turn exploded");
    await expect(
      runTurnWithContexts({
        subset: "wire-only",
        thunk: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);

    expect(calls).toEqual(["beginWireTurn"]);
    expect(currentWorkflowTurnId()).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. THE DECLARED SUBSETS
// ═══════════════════════════════════════════════════════════════════════════════

describe("subset declarations", () => {
  it("customer-full declares all three contexts and omits nothing", () => {
    const declared = TURN_CONTEXT_SUBSETS["customer-full"];
    expect(declared).toMatchObject({
      name: "customer-full",
      wire: true,
      workflow: true,
      funnel: true,
    });
    expect(declared.omissions).toEqual([]);
  });

  it("wire-only declares wire ONLY, with both omissions citing their record", () => {
    const declared = TURN_CONTEXT_SUBSETS["wire-only"];
    expect(declared).toMatchObject({
      name: "wire-only",
      wire: true,
      workflow: false,
      funnel: false,
    });
    // An omission without a cited record is the thing the field exists to prevent.
    expect(declared.omissions).toHaveLength(2);
    expect(declared.omissions[0]).toContain("workflow-turn.ts:37-43");
    expect(declared.omissions[1]).toContain("funnel-tier.ts:334-337");
  });

  it("wire-only WIRES NEITHER the workflow binding nor the funnel context", async () => {
    const turnId = nextTurnId();
    const seen = await runTurnWithContexts({
      subset: "wire-only",
      thunk: async () => ({
        funnel: funnelTurnContext(turnId),
        workflowTurnId: currentWorkflowTurnId(),
        workflowChannel: currentWorkflowChannel(),
      }),
    });

    expect(seen.funnel).toBeUndefined();
    expect(seen.workflowTurnId).toBeUndefined();
    expect(seen.workflowChannel).toBeUndefined();
    // …and the funnel module was never touched at all.
    expect(calls).not.toContain("openFunnelTurn");
    expect(calls).not.toContain("closeFunnelTurn");
  });

  it("wire-only STILL captures wire truth — `wire: true` is load-bearing", async () => {
    const turnId = nextTurnId();
    await expect(
      runTurnWithContexts({
        subset: "wire-only",
        thunk: async () => driveWireCapture(turnId),
      }),
    ).resolves.toBe(1);
  });

  it("an exchange captured OUTSIDE any subset is dropped (the reason wire is universal)", () => {
    const turnId = nextTurnId();
    expect(driveWireCapture(turnId)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. FAIL-CLOSED FUNNEL ABSENCE
// ═══════════════════════════════════════════════════════════════════════════════

describe("fail-closed funnel absence", () => {
  it("customer-full with no parks lets L0 CLAIM a purely social turn", async () => {
    const turnId = nextTurnId();
    await expect(
      runTurnWithContexts({
        subset: "customer-full",
        turnId,
        channel: "web",
        pendingConfirmations: undefined,
        thunk: async () =>
          decideL0({ text: SOCIAL, context: funnelTurnContext(turnId) }),
      }),
    ).resolves.toEqual({ kind: "greeting" });
  });

  it("wire-only makes L0 stand down on the SAME utterance — no publish, no L0", async () => {
    const turnId = nextTurnId();
    await expect(
      runTurnWithContexts({
        subset: "wire-only",
        thunk: async () =>
          decideL0({ text: SOCIAL, context: funnelTurnContext(turnId) }),
      }),
    ).resolves.toBeUndefined();
  });

  it("an OPEN confirm window makes L0 stand down under customer-full (FE-D32)", async () => {
    const turnId = nextTurnId();
    await expect(
      runTurnWithContexts({
        subset: "customer-full",
        turnId,
        channel: "web",
        pendingConfirmations: [parked("aaaa11112222")],
        thunk: async () =>
          decideL0({ text: SOCIAL, context: funnelTurnContext(turnId) }),
      }),
    ).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. THE CONFIRM-WINDOW DERIVATION (one spelling)
// ═══════════════════════════════════════════════════════════════════════════════

describe("deriveConfirmWindowOpen", () => {
  it("is FALSE with no park list at all (no loaded session / no array)", () => {
    expect(deriveConfirmWindowOpen(undefined)).toBe(false);
  });

  it("is FALSE on an EMPTY park list", () => {
    expect(deriveConfirmWindowOpen([])).toBe(false);
  });

  it("is TRUE on one park", () => {
    expect(deriveConfirmWindowOpen([parked("aaaa11112222")])).toBe(true);
  });

  it("is TRUE on several parks", () => {
    expect(
      deriveConfirmWindowOpen([parked("aaaa11112222"), parked("bbbb33334444")]),
    ).toBe(true);
  });

  it("is what the PUBLISHED context carries, for each case", async () => {
    const cases: ReadonlyArray<{
      readonly parks: ReadonlyArray<ParkedEnvelope> | undefined;
      readonly expected: boolean;
    }> = [
      { parks: undefined, expected: false },
      { parks: [], expected: false },
      { parks: [parked("aaaa11112222")], expected: true },
      { parks: [parked("aaaa11112222"), parked("bbbb33334444")], expected: true },
    ];

    for (const testCase of cases) {
      const turnId = nextTurnId();
      const published = await runTurnWithContexts({
        subset: "customer-full",
        turnId,
        channel: "web",
        pendingConfirmations: testCase.parks,
        thunk: async () => funnelTurnContext(turnId),
      });
      expect(published).toEqual({ confirmWindowOpen: testCase.expected });
    }
  });
});
