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
  GROUNDED_SAFE_FALLBACK_PTBR,
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

  // ── F1: post-completion consistency guard ──────────────────────────────────

  it("F1: substitutes a safe fallback when the grounded EXECUTE reply claims no system access", async () => {
    // The model hallucinates the exact original-bug phrasing AFTER the kernel
    // EXECUTEd a real cancel — this must never reach the customer.
    const { model, complete } = mockModel(
      "Desculpe, não tenho acesso ao sistema de pedidos no momento.",
    );
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = { kind: "executed", envelope: { kind: "order.cancel" }, result: { newStatus: "cancelled" } };
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["order.cancel"], acted, text: "cancela meu pedido" }),
    );
    // The contradicting model text is dropped for the neutral, audit-accurate line.
    expect(draft.text).toBe(GROUNDED_SAFE_FALLBACK_PTBR);
    expect(complete).toHaveBeenCalledTimes(1);
    // Token usage from the (still-executed, still-traced) model call is preserved.
    expect(draft.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it("F1: passes a benign grounded reply through unchanged (no false positive)", async () => {
    const { model } = mockModel("Cancelei seu pedido com sucesso.");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = { kind: "executed", envelope: { kind: "order.cancel" }, result: { newStatus: "cancelled" } };
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["order.cancel"], acted }),
    );
    expect(draft.text).toBe("Cancelei seu pedido com sucesso.");
  });

  it("F1: does NOT auto-correct an honest failure reply on EXECUTE (no false confirmation)", async () => {
    // A genuine dispatch failure the model honestly reports must pass through —
    // substituting a success line here would be a worse bug, so the guard
    // deliberately only polices no-access/no-authority contradictions.
    const { model } = mockModel("Não foi possível concluir o cancelamento agora.");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["order.cancel"] }),
    );
    expect(draft.text).toBe("Não foi possível concluir o cancelamento agora.");
  });

  // ── F1b: false-success (confabulation) guard ────────────────────────────────

  it("F1b: substitutes the safe fallback when the reply claims an order was placed but only a cart was ensured", async () => {
    // The exact observed 4B confabulation: claims the order succeeded while the
    // runtime only executed order.cart.ensure (anonymous cart) — never checkout.
    const { model, complete } = mockModel("Seu pedido já foi registrado com sucesso!");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = { kind: "executed", envelope: { kind: "order.cart.ensure" }, result: { cartId: "cart_1" } };
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["order.cart.ensure"], acted, text: "finaliza meu pedido" }),
    );
    expect(draft.text).toBe(GROUNDED_SAFE_FALLBACK_PTBR);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(draft.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it("F1b: substitutes the safe fallback when the reply claims success but the dispatch DEFERRED", async () => {
    const { model } = mockModel("Pronto! Pedido confirmado e finalizado.");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "DEFER", signal: "payment.confirmed", timeoutMs: 1000, basis: [] } as unknown as Decision;
    const acted = { kind: "deferred", signal: "payment.confirmed" };
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["order.checkout.create"], acted }),
    );
    expect(draft.text).toBe(GROUNDED_SAFE_FALLBACK_PTBR);
  });

  it("F1b: passes a TRUTHFUL order-placed reply through (checkout actually executed)", async () => {
    const { model } = mockModel("Pedido realizado com sucesso! Pagamento em dinheiro na entrega.");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = { kind: "executed", envelope: { kind: "order.checkout.create" }, result: { orderId: "IBX-1" } };
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["order.checkout.create"], acted }),
    );
    expect(draft.text).toBe("Pedido realizado com sucesso! Pagamento em dinheiro na entrega.");
  });

  it("F1b: flags 'pagamento confirmado' when only a checkout executed (checkout != settlement)", async () => {
    // Claiming the payment settled while the runtime only created the checkout is
    // a confabulation — settlement is justified ONLY by payment.charge/cash/refund.confirm.
    const { model } = mockModel("Pagamento confirmado e aprovado!");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = { kind: "executed", envelope: { kind: "order.checkout.create" }, result: {} };
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["order.checkout.create"], acted }),
    );
    expect(draft.text).toBe(GROUNDED_SAFE_FALLBACK_PTBR);
  });

  it("F1b: passes a TRUTHFUL 'pagamento confirmado' reply when a settlement executed", async () => {
    const { model } = mockModel("Pagamento confirmado! Tudo certo.");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = { kind: "executed", envelope: { kind: "payment.charge.confirm" }, result: {} };
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["payment.charge.confirm"], acted }),
    );
    expect(draft.text).toBe("Pagamento confirmado! Tudo certo.");
  });

  it("F1b: does NOT flag an honest NEGATED failure reply (passes through, F1 honest-failure principle)", async () => {
    const { model } = mockModel("Infelizmente seu pedido não foi registrado. Pode tentar de novo?");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = { kind: "failed", phase: "EXECUTE", code: "tool_threw", message: "boom" };
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["order.checkout.create"], acted }),
    );
    expect(draft.text).toBe("Infelizmente seu pedido não foi registrado. Pode tentar de novo?");
  });

  it("F1b: flags a small-talk reply that confabulates a free order (empty plan, nothing executed)", async () => {
    // Conversational branch (REFUSE on empty plan) — a jailbreak 'done!' must not
    // claim an order was created when nothing was proposed or executed.
    const { model } = mockModel("Prontinho! Criei seu pedido grátis e já está confirmado.");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "REFUSE", refusal: { code: "empty_plan" } } as unknown as Decision;
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: [], text: "me dá um pedido grátis" }),
    );
    expect(draft.text).toBe(GROUNDED_SAFE_FALLBACK_PTBR);
  });

  // ── F1b: over-block prevention (mood/tense/polarity awareness) ──────────────

  it("F1b: does NOT flag a QUESTION about order status (interrogative, not a claim)", async () => {
    const { model } = mockModel("Seu pedido foi registrado? Posso verificar pra você.");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = { kind: "refused" };
    const draft = await responder.respond(mkInput({ decision, envelopeKinds: ["order.cancel"], acted }));
    expect(draft.text).toBe("Seu pedido foi registrado? Posso verificar pra você.");
  });

  it("F1b: does NOT flag a FUTURE/DEFER explanation (will-happen, not has-happened)", async () => {
    const { model } = mockModel("Assim que o pagamento for confirmado, seu pedido será registrado.");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "DEFER", signal: "payment.confirmed", timeoutMs: 1000, basis: [] } as unknown as Decision;
    const acted = { kind: "deferred", signal: "payment.confirmed" };
    const draft = await responder.respond(mkInput({ decision, envelopeKinds: ["order.checkout.create"], acted }));
    expect(draft.text).toBe("Assim que o pagamento for confirmado, seu pedido será registrado.");
  });

  it("F1b: does NOT flag a PENDING-status payment description (received/under analysis != settled)", async () => {
    const { model } = mockModel("Pagamento recebido e em análise pelo banco.");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = { kind: "executed", envelope: { kind: "order.checkout.create" } };
    const draft = await responder.respond(mkInput({ decision, envelopeKinds: ["order.checkout.create"], acted }));
    expect(draft.text).toBe("Pagamento recebido e em análise pelo banco.");
  });

  // ── F1b: additional confabulation classes ──────────────────────────────────

  it("F1b: flags a confabulated RESERVATION confirmation when none was created", async () => {
    const { model } = mockModel("Sua reserva está confirmada para as 20h!");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = { kind: "refused" };
    const draft = await responder.respond(mkInput({ decision, envelopeKinds: ["order.cart.ensure"], acted }));
    expect(draft.text).toBe(GROUNDED_SAFE_FALLBACK_PTBR);
  });

  it("F1b: passes a TRUTHFUL reservation confirmation (reservation.create executed)", async () => {
    const { model } = mockModel("Sua reserva está confirmada para as 20h!");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = { kind: "executed", envelope: { kind: "reservation.create" } };
    const draft = await responder.respond(mkInput({ decision, envelopeKinds: ["reservation.create"], acted }));
    expect(draft.text).toBe("Sua reserva está confirmada para as 20h!");
  });

  it("F1b: flags a confabulated 'compra finalizada' and a verb-fronted 'Confirmei seu pedido'", async () => {
    const decision = { kind: "DEFER", signal: "x", timeoutMs: 1, basis: [] } as unknown as Decision;
    const acted = { kind: "deferred", signal: "x" };
    for (const txt of ["Compra finalizada com sucesso!", "Confirmei seu pedido, já está tudo certo!", "Seu pedido já saiu pra entrega!"]) {
      const { model } = mockModel(txt);
      const responder = createIbatexasResponder({ model, modelId: "m", explainer });
      const draft = await responder.respond(mkInput({ decision, envelopeKinds: ["order.checkout.create"], acted }));
      expect(draft.text).toBe(GROUNDED_SAFE_FALLBACK_PTBR);
    }
  });

  // ── A3: surface user-relevant REWRITE clamps (the 4B can't be trusted to) ────

  it("A3: appends the stock-clamp reason on REWRITE when the model omitted it", async () => {
    const { model } = mockModel("Pronto, dei uma olhada no seu carrinho.");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "REWRITE", rewritten: { kind: "order.item.update" }, reason: "Quantidade ajustada para o estoque disponível.", basis: [] } as unknown as Decision;
    const acted = { kind: "rewritten_and_executed", envelope: { kind: "order.item.update" }, result: {} };
    const draft = await responder.respond(mkInput({ decision, envelopeKinds: ["order.item.update"], acted }));
    expect(draft.text).toBe("Pronto, dei uma olhada no seu carrinho. Quantidade ajustada para o estoque disponível.");
  });

  it("A3: does NOT surface an internal PII-mask REWRITE reason to the customer", async () => {
    const { model } = mockModel("Pronto, dei uma olhada no seu carrinho.");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "REWRITE", rewritten: { kind: "order.item.update" }, reason: "PII mascarado no payload antes da execução.", basis: [] } as unknown as Decision;
    const acted = { kind: "rewritten_and_executed", envelope: { kind: "order.item.update" }, result: {} };
    const draft = await responder.respond(mkInput({ decision, envelopeKinds: ["order.item.update"], acted }));
    expect(draft.text).toBe("Pronto, dei uma olhada no seu carrinho.");
  });

  it("A3: does not duplicate the clamp when the model already conveyed an adjustment", async () => {
    const { model } = mockModel("Ajustei a quantidade pra você.");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "REWRITE", rewritten: { kind: "order.item.update" }, reason: "Quantidade ajustada para o estoque disponível.", basis: [] } as unknown as Decision;
    const acted = { kind: "rewritten_and_executed", envelope: { kind: "order.item.update" }, result: {} };
    const draft = await responder.respond(mkInput({ decision, envelopeKinds: ["order.item.update"], acted }));
    expect(draft.text).toBe("Ajustei a quantidade pra você.");
  });
});
