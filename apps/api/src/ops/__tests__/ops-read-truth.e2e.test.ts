// ops-read-truth.e2e — BKL-100 crown-jewel proof: a staff READ answer is
// deterministically rendered from the ACTUAL read result (or an honest "couldn't
// check" line), NEVER a model-authored number — driven END-TO-END through the REAL
// composeOpsConductor + a full handleTurn (the same wiring production runs), so
// the capture buffer → responder render seam is proven, not mocked.
//
// Three rows:
//   Truth=5   — the executor returns caixa.ordersCount 5; the scripted model would
//               say "7 pedidos". The reply carries the TRUE 5 and NOT the model's 7,
//               and the responder makes ZERO model calls (2× total = plan + enrich).
//   Read err  — the executor THROWS; the reply is the honest zero-digit line.
//   Clamp     — no read is captured; the model draft states an ungrounded number;
//               the ops plane demotes it, while the customer plane (dep absent)
//               leaves the identical draft untouched.

import { describe, expect, it } from "vitest";
import type { Decision } from "@adjudicate/core";
import type {
  CognitiveState,
  ExplainerPort,
  ModelProvider,
  Plan,
} from "@claustrum/core";
import { createIbatexasResponder } from "../../claustrum/ibatexas-responder.js";
import { createOpsResolver } from "../ops-resolver.js";
import { OPS_SNAPSHOT_READ_TOOL } from "../ops-read-executor.js";
import {
  OPS_SNAPSHOT_UNAVAILABLE_PTBR,
  OPS_UNGROUNDED_CLAMP_PTBR,
} from "../ops-read-render.js";
import {
  buildOpsTools,
  composeOpsDeps,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulSession,
  runOpsTurn,
  scriptedModel,
} from "./ops-e2e-harness.js";

/** A shape-complete snapshot whose ONLY notable figure is caixa.ordersCount = 5;
 *  the number 7 appears in NO field, so a "7" in the reply could only be the
 *  model's fabrication. */
const TRUTH_SNAPSHOT = {
  now: "2026-07-04T21:00:00.000Z",
  opsAlerts: { open: 2, bySeverity: { low: 0, medium: 1, high: 1 } },
  incidents: { open: 1 },
  kitchen: {
    activeTickets: 3,
    oldestTicketAgeMs: 120_000,
    queueDepth: [{ status: "preparing", count: 3 }],
  },
  caixa: {
    date: "2026-07-04",
    ordersCount: 5,
    grossCentavos: 50_000,
    settledCentavos: 50_000,
    refundedCentavos: 0,
    netCentavos: 50_000,
  },
  degraded: [],
};

function buildReadHarness(opts: {
  execute: () => Promise<unknown>;
  responderText: string;
}) {
  const sink = makeCapturingAuditSink();
  const session = makeStatefulSession();
  const { tools } = buildOpsTools({}, sink);
  const adjudicator = makeAuditedAdjudicator({ sink });
  const model = scriptedModel(
    [{ id: "r-1", name: OPS_SNAPSHOT_READ_TOOL, input: {} }],
    { responderText: opts.responderText },
  );
  const deps = composeOpsDeps({
    adjudicator,
    session,
    tools,
    model,
    buildResolver: (staffId: string) =>
      createOpsResolver({
        staffId,
        tenantId: "ibatexas",
        lookupProduct: async () => null,
        lookupOrder: async () => null,
      }),
    opsReadToolExecutors: { [OPS_SNAPSHOT_READ_TOOL]: opts.execute },
  });
  return { deps, model };
}

describe("BKL-100 e2e — a captured read renders the truth, never the model's number", () => {
  it("executor caixa.ordersCount=5, model would say 7 → reply has 5 and NOT 7; responder makes no model call", async () => {
    const { deps, model } = buildReadHarness({
      execute: async () => TRUTH_SNAPSHOT,
      responderText: "Hoje foram 7 pedidos.", // the fabrication that must never win
    });
    const out = await runOpsTurn(deps, {
      role: "OWNER",
      staffId: "owner1",
      text: "como estão as vendas hoje?",
    });
    // The deterministic render carries the TRUE figure, and the model's fabricated
    // "7 pedidos" never appears (the "7" in the date 2026-07-04 is not it).
    expect(out.response).toContain("5 pedidos");
    expect(out.response).not.toContain("7 pedidos");
    expect(out.response).toContain("Panorama operacional");
    // The responder authored NOTHING: complete was called exactly twice — the
    // planner propose pass + the one-hop enrichment re-prompt — and NOT a third
    // time for the responder (the render short-circuited it).
    expect(model.complete).toHaveBeenCalledTimes(2);
  });

  it("executor THROWS → honest zero-digit 'couldn't check' line, no fabricated number", async () => {
    const { deps, model } = buildReadHarness({
      execute: async () => {
        throw new Error("day-close projection down");
      },
      responderText: "Hoje foram 7 pedidos.",
    });
    const out = await runOpsTurn(deps, {
      role: "OWNER",
      staffId: "owner1",
      text: "como foi o dia?",
    });
    expect(out.response).toBe(OPS_SNAPSHOT_UNAVAILABLE_PTBR);
    // Zero digits — the failure can never be mistaken for a value.
    expect(/\d/.test(out.response)).toBe(false);
    // Still only plan + enrichment; the responder short-circuited to the honest line.
    expect(model.complete).toHaveBeenCalledTimes(2);
  });
});

describe("BKL-100 e2e — the ungrounded-fact clamp is ops-plane only", () => {
  it("no read captured + a fabricated number → clamped on the ops plane", async () => {
    const sink = makeCapturingAuditSink();
    const session = makeStatefulSession();
    const { tools } = buildOpsTools({}, sink);
    const adjudicator = makeAuditedAdjudicator({ sink });
    // NO tool call fired → no read captured → the responder falls through to its
    // conversational model draft, which states an ungrounded number.
    const model = scriptedModel([], { responderText: "temos 7 reservas hoje" });
    const deps = composeOpsDeps({
      adjudicator,
      session,
      tools,
      model,
      buildResolver: (staffId: string) =>
        createOpsResolver({
          staffId,
          tenantId: "ibatexas",
          lookupProduct: async () => null,
          lookupOrder: async () => null,
        }),
      opsReadToolExecutors: { [OPS_SNAPSHOT_READ_TOOL]: async () => TRUTH_SNAPSHOT },
    });
    const out = await runOpsTurn(deps, {
      role: "OWNER",
      staffId: "owner1",
      text: "quantas reservas temos?",
    });
    expect(out.response).toBe(OPS_UNGROUNDED_CLAMP_PTBR);
  });

  it("the customer plane (no readAnswer dep) leaves the SAME draft untouched", () => {
    // The direct responder is the customer plane: it never receives the ops-only
    // readAnswer dep, so the identical draft passes through byte-for-byte.
    const explainer: ExplainerPort = { render: (r) => (r as { userFacing: string }).userFacing };
    const model: ModelProvider = {
      complete: async () => ({
        model: "mock",
        stopReason: "end_turn",
        text: "temos 7 reservas hoje",
        toolCalls: [],
        inputTokens: 1,
        outputTokens: 1,
      }),
      stream: () => {
        throw new Error("unused");
      },
      embed: async () => {
        throw new Error("unused");
      },
    };
    const responder = createIbatexasResponder({ model, modelId: "mock", explainer });
    const cognition = {
      perception: { text: "oi", channel: "web", receivedAt: "2026-07-04T00:00:00.000Z" },
      turnId: "cust-1",
    } as unknown as CognitiveState;
    const decision = {
      kind: "REFUSE",
      refusal: { kind: "BUSINESS_RULE", code: "empty_plan", userFacing: "x" },
      basis: [],
    } as unknown as Decision;
    return responder
      .respond({ cognition, decision, plan: { envelopes: [] } as Plan })
      .then((draft) => {
        expect(draft.text).toBe("temos 7 reservas hoje");
      });
  });
});
