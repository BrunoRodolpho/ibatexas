/**
 * R4-S3 — the CONSUMING-SURFACE probe for the customer harness's per-turn
 * AMBIENT CONTEXT leg.
 *
 * `runCustomerTurn` used to hand-compose the choreography that
 * `../claustrum/turn-context.ts` owns (funnel publish + wire capture + the
 * workflow turn binding, in that nesting, closed in that order). It now consumes
 * the module's `customer-full` subset instead. Nothing in the suite asserted that
 * consumption, and the harness is the seam 27 e2e files drive their turns
 * through — so a revert to a bare `handleTurn(capsule, message)` would take every
 * one of those files' ambient contexts away with it, and the ones that do not
 * READ a context would stay green while doing it. That is the born-guarded gap
 * this file closes.
 *
 * ── HOW THE THREE LEGS ARE OBSERVED, AND WHY EACH SOURCE IS INDEPENDENT ──────
 *
 * The observation point is an injected `TelemetryPort` — the harness's declared
 * once-per-turn seam, and `handleTurn`'s step 7 (OBSERVE), so it runs INSIDE the
 * turn with all three contexts live and inside the funnel publish window. It is a
 * public seam production writes tier attribution at, not a private internal.
 *
 * Each leg is read from ITS OWN source, so no assertion here is shadowed by
 * another leg's failure:
 *   - FUNNEL   — `funnelTurnContext(record.turnId)`, a turnId-keyed map read, with
 *                the turnId coming from the CONDUCTOR's own `TurnRecord` rather
 *                than from the workflow binding.
 *   - WORKFLOW — `currentWorkflowTurnId()` / `currentWorkflowChannel()`, its own
 *                AsyncLocalStorage.
 *   - WIRE     — capture an exchange and seal it; `claimWireExchanges` is
 *                non-empty iff a wire context was armed. Capture outside a
 *                context is dropped by design (wire-capture.ts:25-26), so the
 *                sealed count IS the arming.
 *
 * The wire leg is also the pin that distinguishes CONSUMING the module from
 * re-hand-composing it: the retired hand-mirror armed funnel and workflow but
 * never wire, so it fails this file even though it satisfies the other three.
 *
 * ── WHY THE FUNNEL LEG IS A PAIR ────────────────────────────────────────────
 *
 * "confirmWindowOpen is false" is satisfied by a hardcoded `false` and by a
 * context that was never derived from anything. So the CONTROL (no park ⟹ false)
 * is only meaningful next to the TREATMENT (a session holding a park ⟹ true),
 * which is what proves the harness feeds the module the session's REAL
 * `pendingConfirmations` and lets `deriveConfirmWindowOpen` — the one spelling —
 * answer. Both arms also assert the context is PRESENT: an absent context is
 * fail-closed ("nobody told us"), which is a different state from `false`.
 */

import { describe, expect, it, vi } from "vitest";
import type { TelemetryPort, TurnRecord } from "@claustrum/core";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
// Type-only, so it does not defeat the `vi.mock` hoisting the value imports below
// work around — and so the channel union is the harness's, never a copy of it.
import type { CustomerChannel } from "./customer-e2e-harness.js";
import "./setup.js";

const { redisFake } = vi.hoisted(() => ({
  redisFake: { strings: new Map<string, string>() },
}));

// Client-boundary mock only — a turn's resolver reads the active cart from Redis.
vi.mock("redis", () => {
  const client = {
    isOpen: true,
    on: () => client,
    connect: async () => client,
    quit: async () => undefined,
    get: async (k: string) => redisFake.strings.get(k) ?? null,
    set: async (k: string, v: string) => {
      redisFake.strings.set(k, String(v));
      return "OK";
    },
    setEx: async (k: string, _t: number, v: string) => {
      redisFake.strings.set(k, String(v));
      return "OK";
    },
    del: async (k: string) => (redisFake.strings.delete(k) ? 1 : 0),
    hGetAll: async () => ({}),
    hSet: async () => 1,
    hDel: async () => 1,
    expire: async () => 1,
    multi: () => {
      const chain: Record<string, unknown> = {
        hSet: () => chain,
        expire: () => chain,
        exec: async () => [],
      };
      return chain;
    },
    duplicate: () => client,
  };
  return { createClient: () => client };
});

const { funnelTurnContext } = await import("../claustrum/funnel-tier.js");
const { captureWireExchange, claimWireExchanges, sealWireCall } = await import(
  "../claustrum/wire-capture.js"
);
const { currentWorkflowChannel, currentWorkflowTurnId } = await import(
  "../claustrum/workflow/workflow-turn.js"
);
const {
  composeCustomerConductor,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulCustomerSession,
  runCustomerTurn,
  scriptedModel,
  HARNESS_NOW,
} = await import("./customer-e2e-harness.js");

/** What the three contexts looked like from INSIDE `handleTurn`. */
interface ContextSnapshot {
  /** `undefined` = no publish at all (fail-closed), distinct from `{false}`. */
  readonly funnel: { readonly confirmWindowOpen: boolean } | undefined;
  readonly workflowTurnId: string | undefined;
  readonly workflowChannel: string | undefined;
  /** Exchanges that sealed under this turn — 0 iff wire was never armed. */
  readonly wireSealed: number;
}

/**
 * Drive ONE real customer turn and report what the ambient contexts were while it
 * ran. `seedPark` runs against the session BEFORE the turn, so the park is loaded
 * into `capsule.loadedSession` the same way a resumable confirm window is.
 */
async function runProbeTurn(opts: {
  channel?: CustomerChannel;
  seedPark?: boolean;
}): Promise<{ snapshot: ContextSnapshot; turnId: string }> {
  const channel = opts.channel ?? "web";
  const customerId = `cust-r4s3-${channel}${opts.seedPark === true ? "-parked" : ""}`;
  const session = makeStatefulCustomerSession(channel);

  if (opts.seedPark === true) {
    const parked = buildEnvelope({
      kind: "order.checkout.create",
      payload: {},
      actor: { principal: "llm", role: "customer", sessionId: `conv-${customerId}` },
      taint: "UNTRUSTED",
      nonce: "r4s3-park",
    }) as IntentEnvelope;
    await session.parkPendingConfirmation(
      `${channel}:${customerId}`,
      parked,
      "r4s3-confirmation-token",
      "Confirma o pedido?",
    );
  }

  let snapshot: ContextSnapshot | undefined;
  const probeTelemetry: TelemetryPort = {
    emitTurn: async (record: TurnRecord) => {
      // Wire: push an exchange into whatever context is ambient, then seal it
      // under this turn. Both calls are designed no-ops outside a context.
      captureWireExchange({
        model: "r4s3-probe",
        request: { probe: "request" },
        response: { probe: "response" },
        at: HARNESS_NOW,
      });
      sealWireCall(record.turnId);
      snapshot = {
        funnel: funnelTurnContext(record.turnId),
        workflowTurnId: currentWorkflowTurnId(),
        workflowChannel: currentWorkflowChannel(),
        wireSealed: claimWireExchanges(record.turnId).length,
      };
    },
    emitLLMTrace: async () => {},
    emitMemoryAccess: async () => {},
  };

  const harness = composeCustomerConductor({
    model: scriptedModel([]),
    session,
    adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
    telemetry: probeTelemetry,
    ...(channel === "whatsapp" ? { withWhatsApp: true } : {}),
  });

  const out = await runCustomerTurn(harness, {
    customerId,
    conversationId: `conv-${customerId}`,
    // Deliberately NOT social-only (L0 would short-circuit before OBSERVE) and
    // deliberately not an affirmative (it must not resume the seeded park).
    text: "queria saber sobre o cardápio de hoje",
    channel,
  });

  if (snapshot === undefined) {
    throw new Error(
      "[r4s3] telemetry.emitTurn never ran — the probe observed nothing, so no assertion below is meaningful",
    );
  }
  return { snapshot, turnId: out.turnId };
}

describe("R4-S3 — runCustomerTurn drives handleTurn inside the customer-full turn-context subset", () => {
  it("publishes this turn's FUNNEL CONTEXT: inside handleTurn a turn with no parked confirmation is confirmWindowOpen=false, NOT an absent context", async () => {
    const { snapshot } = await runProbeTurn({});

    expect(snapshot.funnel).toBeDefined();
    expect(snapshot.funnel).toEqual({ confirmWindowOpen: false });
  });

  it("derives confirmWindowOpen from the session's REAL pendingConfirmations: inside handleTurn a session holding a park is confirmWindowOpen=true", async () => {
    const { snapshot } = await runProbeTurn({ seedPark: true });

    expect(snapshot.funnel).toBeDefined();
    expect(snapshot.funnel).toEqual({ confirmWindowOpen: true });
  });

  it("binds the WORKFLOW TURN: inside handleTurn currentWorkflowTurnId() is this turn's id and currentWorkflowChannel() is the channel the turn arrived on", async () => {
    const web = await runProbeTurn({ channel: "web" });
    const whatsapp = await runProbeTurn({ channel: "whatsapp" });

    expect(web.snapshot.workflowTurnId).toBe(web.turnId);
    expect(whatsapp.snapshot.workflowTurnId).toBe(whatsapp.turnId);
    // The channel PAIR: a binding hardcoded to either plane fails one arm.
    expect(web.snapshot.workflowChannel).toBe("web");
    expect(whatsapp.snapshot.workflowChannel).toBe("whatsapp");
  });

  it("arms WIRE CAPTURE: an exchange captured inside handleTurn seals into this turn's buffer instead of being dropped for want of a context", async () => {
    const { snapshot } = await runProbeTurn({});

    expect(snapshot.wireSealed).toBe(1);
  });

  it("closes the funnel context when the turn settles: the SAME turn id that resolved a context inside handleTurn resolves none after", async () => {
    const { snapshot, turnId } = await runProbeTurn({});

    // The during-arm is not decoration — without it "absent after" is satisfied
    // by a context that was never published, and this test would pass with the
    // whole consumption deleted (which is exactly what it did before it was
    // paired). The pair makes the CLOSE the only thing it can be measuring.
    expect(snapshot.funnel).toBeDefined();
    expect(funnelTurnContext(turnId)).toBeUndefined();
  });
});
