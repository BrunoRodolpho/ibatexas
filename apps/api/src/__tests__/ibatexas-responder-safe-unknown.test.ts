// BKL-078 — the responder SAFE-UNKNOWN gate wiring (the seam, not the discriminator
// corpus — that lives in claustrum/__tests__/interrogative-discriminator.test.ts).
//
// Proves:
//   - dep present + gate fires (REFUSE empty-plan info-question) → returns the
//     deterministic render text, the model is NEVER called, and ONE PII-free
//     `claims.terminal` (posture safe_degraded, reason ungrounded_question) is
//     emitted (no request text / claim value in the payload).
//   - dep present + gate does NOT fire (smalltalk) → the model runs (the normal
//     conversational completion) — the gate cannot hijack a greeting.
//   - dep ABSENT → the model runs — byte-identical to today (customer / WhatsApp).
//   - a REAL action refusal (non-empty plan) never consults the gate.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Decision, IntentEnvelope } from "@adjudicate/core";
import type {
  CognitiveState,
  Completion,
  CompletionRequest,
  ExplainerPort,
  ModelProvider,
  Plan,
} from "@claustrum/core";
import { createIbatexasResponder } from "../claustrum/ibatexas-responder.js";
import {
  renderPropositionFreeText,
  SAFE_TEMPLATES,
} from "../claustrum/slot-grammar.js";
import { logger } from "../lib/logger.js";

function mockModel(text = "PROSE_DO_MODELO"): {
  model: ModelProvider;
  complete: ReturnType<typeof vi.fn>;
} {
  const complete = vi.fn(
    async (_req: CompletionRequest): Promise<Completion> => ({
      model: "mock",
      stopReason: "end_turn",
      text,
      toolCalls: [],
      inputTokens: 5,
      outputTokens: 3,
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
  render: (refusal) => `REFUSAL_RENDERED:${refusal.code}`,
};

function mkInput(args: {
  decision: Decision;
  envelopeKinds?: string[];
  text?: string;
}): Parameters<ReturnType<typeof createIbatexasResponder>["respond"]>[0] {
  const cognition = {
    perception: {
      text: args.text ?? "oi",
      channel: "web",
      receivedAt: "2026-07-10T00:00:00.000Z",
    },
    memory: { recentActions: [], facts: [] },
    retrieval: { docs: [] },
    tenantId: "ibatexas",
    locale: "pt-BR",
    conversationId: "conv-1",
    turnId: "turn-bkl078",
  } as unknown as CognitiveState;
  const envelopes = (args.envelopeKinds ?? []).map(
    (kind) => ({ kind, payload: {} }) as unknown as IntentEnvelope,
  );
  const plan: Plan = { envelopes } as Plan;
  return { cognition, decision: args.decision, plan };
}

const emptyPlanRefuse = {
  kind: "REFUSE",
  refusal: { kind: "BUSINESS_RULE", code: "empty_plan", userFacing: "x" },
  basis: [],
} as unknown as Decision;

const SAFE_TEXT = "Não localizei essa informação confirmada agora. Quer que eu verifique?";

describe("BKL-078 — the SAFE_UNKNOWN render source (slot-grammar)", () => {
  it("renderPropositionFreeText(SAFE_TEMPLATES.unknown) is the canonical safe text", () => {
    // Pins the hardcoded SAFE_TEXT constant to the template (guards drift) and
    // covers the new proposition-free renderer the bootstrap `render` reuses.
    expect(renderPropositionFreeText(SAFE_TEMPLATES.unknown)).toBe(SAFE_TEXT);
  });

  it("throws if handed a template carrying a PROPOSITION slot", () => {
    expect(() =>
      renderPropositionFreeText({
        claimType: "X",
        posture: "unknown",
        slots: [{ kind: "PROPOSITION", claimType: "X", field: "f" }],
      }),
    ).toThrow(/proposition-free/);
  });
});

describe("createIbatexasResponder — BKL-078 safeUnknown gate", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
  });
  afterEach(() => {
    infoSpy.mockRestore();
  });

  function terminalRows() {
    return infoSpy.mock.calls
      .map((c) => c[0])
      .filter(
        (o): o is Record<string, unknown> =>
          typeof o === "object" &&
          o !== null &&
          (o as { event?: unknown }).event === "claims.terminal",
      );
  }

  it("gate FIRES on a REFUSE empty-plan info-question → safe text, model NOT called", async () => {
    const { model, complete } = mockModel();
    const gate = vi.fn((t: string) => t === "vocês têm sushi?");
    const render = vi.fn(() => SAFE_TEXT);
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      safeUnknown: { gate, render },
    });

    const draft = await responder.respond(
      mkInput({ decision: emptyPlanRefuse, text: "vocês têm sushi?" }),
    );

    expect(draft.text).toBe(SAFE_TEXT);
    expect(gate).toHaveBeenCalledWith("vocês têm sushi?");
    expect(complete).not.toHaveBeenCalled();

    // Exactly one PII-free claims.terminal (safe_degraded / ungrounded_question).
    const rows = terminalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "claims.terminal",
      posture: "safe_degraded",
      reason: "ungrounded_question",
      turnId: "turn-bkl078",
    });
    // No request text / claim value leaked into the telemetry payload.
    expect(JSON.stringify(rows[0])).not.toContain("sushi");
  });

  it("render receives the resolved schedule signal", async () => {
    const { model } = mockModel();
    const render = vi.fn(() => SAFE_TEXT);
    const scheduleSignal = { isClosed: true, nextOpenDay: "amanhã" };
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      resolveScheduleSignal: () => scheduleSignal as never,
      safeUnknown: { gate: () => true, render },
    });

    await responder.respond(
      mkInput({ decision: emptyPlanRefuse, text: "vocês fazem entrega?" }),
    );
    // render now also receives the user text (⑥ — so it can gate the closed-hours
    // disclosure on ordering/hours relevance).
    expect(render).toHaveBeenCalledWith(scheduleSignal, "vocês fazem entrega?");
  });

  it("gate does NOT fire on smalltalk → the model runs (no hijack of a greeting)", async () => {
    const { model, complete } = mockModel("Olá! Como posso ajudar?");
    const gate = vi.fn((t: string) => t === "vocês têm sushi?"); // false for greeting
    const render = vi.fn(() => SAFE_TEXT);
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      safeUnknown: { gate, render },
    });

    const draft = await responder.respond(
      mkInput({ decision: emptyPlanRefuse, text: "oi, tudo bem?" }),
    );
    expect(gate).toHaveBeenCalledWith("oi, tudo bem?");
    expect(render).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(draft.text).toBe("Olá! Como posso ajudar?");
    expect(terminalRows()).toHaveLength(0);
  });

  it("dep ABSENT → the model runs (byte-identical to today)", async () => {
    const { model, complete } = mockModel("Olá! Como posso ajudar?");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });

    const draft = await responder.respond(
      mkInput({ decision: emptyPlanRefuse, text: "vocês têm sushi?" }),
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(draft.text).toBe("Olá! Como posso ajudar?");
    expect(terminalRows()).toHaveLength(0);
  });

  it("a REAL action refusal (non-empty plan) never consults the gate", async () => {
    const { model, complete } = mockModel();
    const gate = vi.fn(() => true);
    const render = vi.fn(() => SAFE_TEXT);
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      safeUnknown: { gate, render },
    });
    const actionRefuse = {
      kind: "REFUSE",
      refusal: { kind: "STATE", code: "order.cart.missing", userFacing: "x" },
      basis: [],
    } as unknown as Decision;

    const draft = await responder.respond(
      mkInput({ decision: actionRefuse, envelopeKinds: ["order.item.add"] }),
    );
    expect(draft.text).toBe("REFUSAL_RENDERED:order.cart.missing");
    expect(gate).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
