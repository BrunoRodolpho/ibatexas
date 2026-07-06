// NEW-032 slice B — responder persona injection.
//
// Pins two properties of `IbatexasResponderDeps.personas`:
//   1. ABSENT → byte-identical to the pre-NEW-032 behavior (the default
//      constants drive each branch). A regression bar for every other plane.
//   2. PRESENT → the injected text REPLACES the default per decision branch
//      (conversational / grounded / escalate), and WINS over the composer.

import { describe, expect, it, vi } from "vitest";
import type { Decision, IntentEnvelope } from "@adjudicate/core";
import type {
  CognitiveState,
  Completion,
  CompletionRequest,
  ExplainerPort,
  ModelProvider,
  Plan,
} from "@claustrum/core";
import {
  createIbatexasResponder,
  RESPONDER_ESCALATE_PTBR,
  RESPONDER_GROUNDED_PERSONA_PTBR,
  RESPONDER_PERSONA_PTBR,
} from "../claustrum/ibatexas-responder.js";

function mockModel(text = "RESPOSTA"): {
  model: ModelProvider;
  complete: ReturnType<typeof vi.fn>;
} {
  const complete = vi.fn(
    async (_req: CompletionRequest): Promise<Completion> => ({
      model: "mock",
      stopReason: "end_turn",
      text,
      toolCalls: [],
      inputTokens: 3,
      outputTokens: 2,
    }),
  );
  const model: ModelProvider = {
    complete,
    stream: () => {
      throw new Error("stream not used");
    },
    embed: async () => {
      throw new Error("embed not used");
    },
  };
  return { model, complete };
}

const explainer: ExplainerPort = {
  render: (refusal) => `REFUSAL:${refusal.code}`,
};

function mkInput(args: {
  decision: Decision;
  envelopeKinds?: string[];
  acted?: unknown;
}): Parameters<ReturnType<typeof createIbatexasResponder>["respond"]>[0] {
  const cognition = {
    perception: { text: "oi", channel: "system", receivedAt: "2026-07-04T00:00:00.000Z" },
    memory: { recentActions: [], facts: [] },
    retrieval: { docs: [] },
    tenantId: "ibatexas",
    locale: "pt-BR",
    conversationId: "admin:staff_1",
    turnId: "turn-1",
  } as unknown as CognitiveState;
  const envelopes = (args.envelopeKinds ?? []).map(
    (kind) => ({ kind, payload: {} }) as unknown as IntentEnvelope,
  );
  return {
    cognition,
    decision: args.decision,
    plan: { envelopes } as Plan,
    ...(args.acted !== undefined ? { acted: args.acted } : {}),
  };
}

const OPS_CONV = "PERSONA_OPS_CONVERSACIONAL";
const OPS_GROUNDED = "PERSONA_OPS_GROUNDED";
const OPS_ESCALATE = "PERSONA_OPS_ESCALATE";

describe("responder persona injection — ABSENT is byte-identical (regression bar)", () => {
  it("conversational branch uses RESPONDER_PERSONA_PTBR when personas absent", async () => {
    const { model, complete } = mockModel("Olá!");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = {
      kind: "REFUSE",
      refusal: { kind: "BUSINESS_RULE", code: "empty_plan", userFacing: "x" },
      basis: [],
    } as unknown as Decision;
    await responder.respond(mkInput({ decision, envelopeKinds: [] }));
    expect((complete.mock.calls[0]![0] as CompletionRequest).system).toBe(
      RESPONDER_PERSONA_PTBR,
    );
  });

  it("grounded branch uses RESPONDER_GROUNDED_PERSONA_PTBR when personas absent", async () => {
    const { model, complete } = mockModel("feito");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    await responder.respond(
      mkInput({ decision, envelopeKinds: ["product.availability.set"] }),
    );
    const system = (complete.mock.calls[0]![0] as CompletionRequest).system ?? "";
    expect(system.startsWith(RESPONDER_GROUNDED_PERSONA_PTBR)).toBe(true);
  });

  it("ESCALATE returns RESPONDER_ESCALATE_PTBR when personas absent", async () => {
    const { model } = mockModel();
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "ESCALATE", basis: [] } as unknown as Decision;
    const draft = await responder.respond(mkInput({ decision }));
    expect(draft.text).toBe(RESPONDER_ESCALATE_PTBR);
  });
});

describe("responder persona injection — PRESENT selects the injected text per branch", () => {
  const personas = {
    conversational: OPS_CONV,
    grounded: OPS_GROUNDED,
    escalate: OPS_ESCALATE,
  };

  it("conversational branch uses the injected persona (wins over composer default)", async () => {
    const { model, complete } = mockModel("Olá colega!");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      personas,
    });
    const decision = {
      kind: "REFUSE",
      refusal: { kind: "BUSINESS_RULE", code: "empty_plan", userFacing: "x" },
      basis: [],
    } as unknown as Decision;
    await responder.respond(mkInput({ decision, envelopeKinds: [] }));
    expect((complete.mock.calls[0]![0] as CompletionRequest).system).toBe(OPS_CONV);
  });

  it("grounded branch uses the injected persona as the system base", async () => {
    const { model, complete } = mockModel("marquei como indisponível");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      personas,
    });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    await responder.respond(
      mkInput({
        decision,
        envelopeKinds: ["product.availability.set"],
        acted: {
          kind: "executed",
          envelope: { kind: "product.availability.set" },
          toolId: "t",
          result: {},
        },
      }),
    );
    const system = (complete.mock.calls[0]![0] as CompletionRequest).system ?? "";
    expect(system.startsWith(OPS_GROUNDED)).toBe(true);
    expect(system.includes(RESPONDER_GROUNDED_PERSONA_PTBR)).toBe(false);
  });

  it("ESCALATE returns the injected escalate line", async () => {
    const { model } = mockModel();
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      personas,
    });
    const decision = { kind: "ESCALATE", basis: [] } as unknown as Decision;
    const draft = await responder.respond(mkInput({ decision }));
    expect(draft.text).toBe(OPS_ESCALATE);
  });
});

// ── BKL-100 — the ops-plane readAnswer dep (render short-circuit + clamp) ──────
describe("responder readAnswer dep (BKL-100)", () => {
  const emptyPlanRefuse = {
    kind: "REFUSE",
    refusal: { kind: "BUSINESS_RULE", code: "empty_plan", userFacing: "x" },
    basis: [],
  } as unknown as Decision;

  it("dep + a captured read on REFUSE-empty-plan → the rendered text IS the reply, model called ZERO times", async () => {
    const { model, complete } = mockModel("7 pedidos (model prose)");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      readAnswer: { render: () => "PANORAMA DETERMINÍSTICO" },
    });
    const draft = await responder.respond(
      mkInput({ decision: emptyPlanRefuse, envelopeKinds: [] }),
    );
    expect(draft.text).toBe("PANORAMA DETERMINÍSTICO");
    // The responder authored NOTHING — no model call on the read turn.
    expect(complete).not.toHaveBeenCalled();
  });

  it("dep present but NO read captured (render → undefined) → conversational model path runs", async () => {
    const { model, complete } = mockModel("Olá colega!");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      readAnswer: { render: () => undefined },
    });
    const draft = await responder.respond(
      mkInput({ decision: emptyPlanRefuse, envelopeKinds: [] }),
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(draft.text).toBe("Olá colega!");
  });

  it("dep ABSENT → REFUSE-empty-plan still calls the model (regression bar: byte-identical)", async () => {
    const { model, complete } = mockModel("Olá!");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const draft = await responder.respond(
      mkInput({ decision: emptyPlanRefuse, envelopeKinds: [] }),
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(draft.text).toBe("Olá!");
  });

  it("clampUngrounded demotes an ungrounded numeric draft on the conversational fallback", async () => {
    const { model } = mockModel("temos 7 reservas hoje");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      readAnswer: {
        render: () => undefined,
        clampUngrounded: (t) => (/\d/.test(t) ? "NUDGE HONESTO" : null),
      },
    });
    const draft = await responder.respond(
      mkInput({ decision: emptyPlanRefuse, envelopeKinds: [] }),
    );
    expect(draft.text).toBe("NUDGE HONESTO");
  });

  it("customer plane (dep absent) leaves the SAME numeric draft untouched", async () => {
    const { model } = mockModel("temos 7 reservas hoje");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const draft = await responder.respond(
      mkInput({ decision: emptyPlanRefuse, envelopeKinds: [] }),
    );
    expect(draft.text).toBe("temos 7 reservas hoje");
  });
});
