/**
 * Phase A — decision-aware responder (responder-trace-admin-plan.md).
 *
 * The contract under test (createIbatexasResponder):
 *   - REFUSE of a PROPOSED action  → ExplainerPort.render(refusal) VERBATIM,
 *     model-free (the bug fix: the chat must never contradict the audited
 *     refusal, and never claim "não tenho acesso" while the kernel REFUSEd).
 *   - REFUSE on an EMPTY plan       → conversational model reply (no action to
 *     contradict — small-talk).
 *   - REQUEST_CONFIRMATION          → decision.prompt, model-free.
 *   - ESCALATE                      → a fixed pt-BR handoff line, model-free.
 *   - EXECUTE / REWRITE / DEFER     → model reply GROUNDED in decision.kind +
 *     acted + capabilities (so it states what actually happened).
 */

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
  RESPONDER_PERSONA_PTBR,
} from "../claustrum/ibatexas-responder.js";

function mockModel(text = "RESPOSTA_DO_MODELO"): {
  model: ModelProvider;
  complete: ReturnType<typeof vi.fn>;
} {
  const complete = vi.fn(
    async (_req: CompletionRequest): Promise<Completion> => ({
      model: "mock",
      stopReason: "end_turn",
      text,
      toolCalls: [],
      inputTokens: 11,
      outputTokens: 7,
    }),
  );
  const model: ModelProvider = {
    complete,
    stream: () => {
      throw new Error("stream not used by responder");
    },
    embed: async () => {
      throw new Error("embed not used by responder");
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
  capabilities?: string[];
  acted?: unknown;
  text?: string;
}): Parameters<ReturnType<typeof createIbatexasResponder>["respond"]>[0] {
  const cognition = {
    perception: {
      text: args.text ?? "oi",
      channel: "web",
      receivedAt: "2026-06-14T00:00:00.000Z",
    },
    memory: { recentActions: [], facts: [] },
    retrieval: { docs: [] },
    tenantId: "ibatexas",
    locale: "pt-BR",
    conversationId: "conv-1",
    turnId: "turn-1",
  } as unknown as CognitiveState;
  const envelopes = (args.envelopeKinds ?? []).map(
    (kind) => ({ kind, payload: {} }) as unknown as IntentEnvelope,
  );
  const plan: Plan = {
    envelopes,
    ...(args.capabilities !== undefined
      ? { capabilities: args.capabilities }
      : {}),
  } as Plan;
  return {
    cognition,
    decision: args.decision,
    plan,
    ...(args.acted !== undefined ? { acted: args.acted } : {}),
  };
}

describe("createIbatexasResponder", () => {
  it("REFUSE of a proposed action renders the explainer VERBATIM, model-free", async () => {
    const { model, complete } = mockModel();
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
    });
    const decision = {
      kind: "REFUSE",
      refusal: {
        kind: "STATE",
        code: "order.cart.missing",
        userFacing: "x",
      },
      basis: [],
    } as unknown as Decision;
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["order.item.add"] }),
    );
    expect(draft.text).toBe("REFUSAL_RENDERED:order.cart.missing");
    expect(complete).not.toHaveBeenCalled();
  });

  it("REFUSE on an EMPTY plan answers conversationally via the model (persona prompt)", async () => {
    const { model, complete } = mockModel("Olá! Como posso ajudar?");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
    });
    const decision = {
      kind: "REFUSE",
      refusal: { kind: "BUSINESS_RULE", code: "empty_plan", userFacing: "x" },
      basis: [],
    } as unknown as Decision;
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: [], text: "Oi, tudo bem?" }),
    );
    expect(draft.text).toBe("Olá! Como posso ajudar?");
    expect(complete).toHaveBeenCalledTimes(1);
    const req = complete.mock.calls[0]![0] as CompletionRequest;
    expect(req.system).toBe(RESPONDER_PERSONA_PTBR);
    expect(req.messages).toEqual([{ role: "user", content: "Oi, tudo bem?" }]);
    expect(draft.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it("REQUEST_CONFIRMATION returns decision.prompt verbatim, model-free", async () => {
    const { model, complete } = mockModel();
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
    });
    const decision = {
      kind: "REQUEST_CONFIRMATION",
      prompt: "Confirma o cancelamento?",
      basis: [],
    } as unknown as Decision;
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["order.cancel"] }),
    );
    expect(draft.text).toBe("Confirma o cancelamento?");
    expect(complete).not.toHaveBeenCalled();
  });

  it("ESCALATE returns the fixed pt-BR handoff line, model-free", async () => {
    const { model, complete } = mockModel();
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
    });
    const decision = {
      kind: "ESCALATE",
      to: "human",
      reason: "over budget",
      basis: [],
    } as unknown as Decision;
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["order.cancel"] }),
    );
    expect(draft.text).toBe(RESPONDER_ESCALATE_PTBR);
    expect(complete).not.toHaveBeenCalled();
  });

  it("EXECUTE grounds the model reply in decision.kind + acted + capabilities", async () => {
    const { model, complete } = mockModel("Cancelei seu pedido com sucesso.");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
    });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = {
      kind: "executed",
      toolId: "orders.cancel.v1",
      envelope: { kind: "order.cancel" },
      result: { status: "cancelled" },
    };
    const draft = await responder.respond(
      mkInput({
        decision,
        envelopeKinds: ["order.cancel"],
        capabilities: ["order.cancel"],
        acted,
        text: "cancela meu pedido",
      }),
    );
    expect(draft.text).toBe("Cancelei seu pedido com sucesso.");
    expect(complete).toHaveBeenCalledTimes(1);
    const req = complete.mock.calls[0]![0] as CompletionRequest;
    expect(req.system).toContain("CONTEXTO DA DECISÃO");
    expect(req.system).toContain("EXECUTE");
    expect(req.system).toContain("order.cancel");
    expect(req.system).toContain("cancelled");
    expect(draft.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it("DEFER grounds the reply in the deferral signal", async () => {
    const { model, complete } = mockModel("Estou aguardando a confirmação do pagamento.");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
    });
    const decision = {
      kind: "DEFER",
      signal: "payment.confirmed",
      timeoutMs: 60000,
      basis: [],
    } as unknown as Decision;
    const acted = { kind: "deferred", signal: "payment.confirmed", timeoutMs: 60000 };
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["payment.pix.regenerate"], acted }),
    );
    expect(complete).toHaveBeenCalledTimes(1);
    const req = complete.mock.calls[0]![0] as CompletionRequest;
    expect(req.system).toContain("payment.confirmed");
    expect(draft.text).toBe("Estou aguardando a confirmação do pagamento.");
  });
});
