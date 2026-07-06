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
  PT_BR_LANGUAGE_FALLBACK_PTBR,
  RESPONDER_ESCALATE_PTBR,
  RESPONDER_PERSONA_PTBR,
  replyLeaksSpanish,
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

  // ── F1b: clause-local mood gating (review findings 5, 8, 10, 12) ─────────────

  it("F1b finding 5: flags a completed claim followed by a CONDITIONAL courtesy tail (clause-local)", async () => {
    // The conditional ("se precisar…") sits in a DIFFERENT comma-clause than the
    // claim, so it must NOT suppress the unearned "pedido finalizado".
    const { model } = mockModel("Seu pedido foi finalizado, se precisar de algo me avise.");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = { kind: "executed", envelope: { kind: "order.cancel" } }; // no checkout
    const draft = await responder.respond(mkInput({ decision, envelopeKinds: ["order.cancel"], acted }));
    expect(draft.text).toBe(GROUNDED_SAFE_FALLBACK_PTBR);
  });

  it("F1b finding 5: PASSES a JUSTIFIED claim with a conditional courtesy tail (positive control)", async () => {
    const { model } = mockModel("Seu pedido foi cancelado, se precisar de algo estou à disposição.");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = { kind: "executed", envelope: { kind: "order.cancel" } };
    const draft = await responder.respond(mkInput({ decision, envelopeKinds: ["order.cancel"], acted }));
    expect(draft.text).toBe("Seu pedido foi cancelado, se precisar de algo estou à disposição.");
  });

  it("F1b finding 8: flags 'recebido E registrado com sucesso' (pending word does not exempt a definite success)", async () => {
    const { model } = mockModel("Pedido recebido e registrado com sucesso.");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = { kind: "executed", envelope: { kind: "order.cancel" } }; // no checkout
    const draft = await responder.respond(mkInput({ decision, envelopeKinds: ["order.cancel"], acted }));
    expect(draft.text).toBe(GROUNDED_SAFE_FALLBACK_PTBR);
  });

  it("F1b finding 12: a REFUND confirmation does NOT justify a 'pagamento aprovado' settlement claim", async () => {
    const { model } = mockModel("Pagamento aprovado!");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = { kind: "executed", envelope: { kind: "payment.refund.confirm" } }; // refund != inbound settlement
    const draft = await responder.respond(mkInput({ decision, envelopeKinds: ["payment.refund.confirm"], acted }));
    expect(draft.text).toBe(GROUNDED_SAFE_FALLBACK_PTBR);
  });

  it("F1b finding 10: does NOT mis-substitute an honest failure with words between 'não' and the verb (wide negation window)", async () => {
    const { model } = mockModel("O pagamento ainda não foi devidamente aprovado.");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = { kind: "failed", phase: "EXECUTE", code: "tool_threw", message: "boom" };
    const draft = await responder.respond(mkInput({ decision, envelopeKinds: ["payment.charge.confirm"], acted }));
    expect(draft.text).toBe("O pagamento ainda não foi devidamente aprovado.");
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

  // ── fix B (Stage 1): deterministic closed-hours backstop ────────────────────

  const closedSignal = { isClosed: true as const, mealPeriod: "closed" as const, nextOpenDay: "amanhã" };
  const openSignal = { isClosed: false as const, mealPeriod: "lunch" as const };
  const CLOSED_DISCLOSURE =
    "No momento estamos fechados (reabrimos amanhã). Posso registrar seu pedido para retirada agendada.";
  // F6: the confirmation for an ACCEPTED scheduled-pickup order (not the generic offer).
  const SCHEDULED_CONFIRMATION =
    "Seu pedido foi registrado para retirada agendada (retirada a partir de amanhã).";
  const SCHEDULED_CONFIRMATION_PIX =
    "Seu pedido foi registrado para retirada agendada (retirada a partir de amanhã). Falta só concluir o pagamento via PIX para confirmar.";

  it("F6(a): an ACCEPTED scheduled-pickup order + a false-immediate draft → CONFIRMATION, not the offer", async () => {
    // Store closed; the 4B falsely says the accepted scheduled order is "em preparo".
    // guardDraft (fulfillment-claimed) neutralizes that to the fallback, and the
    // closed-hours guard would normally upgrade the fallback to the generic OFFER —
    // but because a scheduled PICKUP was genuinely accepted this turn, it must instead
    // acknowledge the order (F6). Was previously CODIFIED as the buggy OFFER output.
    const { model } = mockModel("Seu pedido já está em preparo e sai em 20 minutos!");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      resolveScheduleSignal: () => closedSignal,
    });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = {
      kind: "executed",
      envelope: { kind: "order.checkout.create" },
      result: { orderId: "IBX-1", scheduledPickup: true, paymentMethod: "cash" },
    };
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["order.checkout.create"], acted, text: "quero retirar amanhã" }),
    );
    expect(draft.text).toBe(SCHEDULED_CONFIRMATION);
  });

  it("F6(b): a DELIVERY order accepted while closed → SAFE degrade (never a false pickup confirmation)", async () => {
    // CRITICAL correctness trap: the kernel does NOT gate closed-hours, so a delivery/
    // immediate order can also EXECUTE while closed. `scheduledPickup` is absent here →
    // the closed-hours guard must keep the SAFE degrade (offer/disclosure) and MUST NOT
    // convert it into a pickup confirmation. (This is the delivery variant that the old
    // :518 test asserted — preserved verbatim as the safe-degrade proof.)
    const { model } = mockModel("Estamos abertos! Seu pedido sairá para entrega agora.");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      resolveScheduleSignal: () => closedSignal,
    });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    // Delivery order → NO scheduledPickup marker on the result.
    const acted = {
      kind: "executed",
      envelope: { kind: "order.checkout.create" },
      result: { orderId: "IBX-1", paymentMethod: "pix" },
    };
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["order.checkout.create"], acted, text: "quero pedido pra entrega agora" }),
    );
    expect(draft.text).toBe(CLOSED_DISCLOSURE);
  });

  it("F6(c): an accepted scheduled PIX pickup → CONFIRMATION reflecting awaiting-payment", async () => {
    // A scheduled PIX pickup EXECUTEs + generates the QR (QR-first-then-confirm), so the
    // order IS registered but payment is still pending. The confirmation says so.
    const { model } = mockModel("Seu pedido está a caminho!");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      resolveScheduleSignal: () => closedSignal,
    });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = {
      kind: "executed",
      envelope: { kind: "order.checkout.create" },
      result: {
        orderId: "IBX-2",
        scheduledPickup: true,
        paymentMethod: "pix",
        pixCopyPaste: "00020126PIX",
      },
    };
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["order.checkout.create"], acted, text: "quero retirar amanhã, pago no pix" }),
    );
    expect(draft.text).toBe(SCHEDULED_CONFIRMATION_PIX);
  });

  it("F6(d): a CLEAN scheduled-pickup confirmation draft is left untouched", async () => {
    // The model already produced an accurate confirmation (no false-immediate claim):
    // nothing was clobbered, so the guard must NOT substitute its own string.
    const clean = "Perfeito! Seu pedido para retirada agendada está registrado.";
    const { model } = mockModel(clean);
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      resolveScheduleSignal: () => closedSignal,
    });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = {
      kind: "executed",
      envelope: { kind: "order.checkout.create" },
      result: { orderId: "IBX-3", scheduledPickup: true, paymentMethod: "cash" },
    };
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["order.checkout.create"], acted, text: "quero retirar amanhã" }),
    );
    expect(draft.text).toBe(clean);
  });

  it("closed: repairs a conversational reply that falsely says 'estamos abertos'", async () => {
    const { model } = mockModel("Sim, estamos abertos! Pode fazer seu pedido.");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      resolveScheduleSignal: async () => closedSignal,
    });
    const decision = { kind: "REFUSE", refusal: { code: "empty_plan" } } as unknown as Decision;
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: [], text: "vocês estão abertos?" }),
    );
    expect(draft.text).toBe(CLOSED_DISCLOSURE);
  });

  it("closed: injects the closed-hours note into the model system prompt", async () => {
    const { model, complete } = mockModel("Posso agendar sua retirada.");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      resolveScheduleSignal: () => closedSignal,
    });
    const decision = { kind: "REFUSE", refusal: { code: "empty_plan" } } as unknown as Decision;
    await responder.respond(mkInput({ decision, envelopeKinds: [], text: "oi" }));
    const req = complete.mock.calls[0]![0] as CompletionRequest;
    expect(req.system).toContain("FECHADA");
    expect(req.system).toContain("retirada agendada");
  });

  it("closed: passes a correct closed-disclosure reply through unchanged", async () => {
    const { model } = mockModel("No momento estamos fechados, posso agendar sua retirada.");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      resolveScheduleSignal: () => closedSignal,
    });
    const decision = { kind: "REFUSE", refusal: { code: "empty_plan" } } as unknown as Decision;
    const draft = await responder.respond(mkInput({ decision, envelopeKinds: [], text: "tão abertos?" }));
    expect(draft.text).toBe("No momento estamos fechados, posso agendar sua retirada.");
  });

  it("open: a reply that says 'estamos abertos' is NOT repaired", async () => {
    const { model, complete } = mockModel("Sim, estamos abertos! Pode fazer seu pedido.");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      resolveScheduleSignal: () => openSignal,
    });
    const decision = { kind: "REFUSE", refusal: { code: "empty_plan" } } as unknown as Decision;
    const draft = await responder.respond(mkInput({ decision, envelopeKinds: [], text: "abertos?" }));
    expect(draft.text).toBe("Sim, estamos abertos! Pode fazer seu pedido.");
    // No closed note injected on the open path.
    const req = complete.mock.calls[0]![0] as CompletionRequest;
    expect(req.system).not.toContain("FECHADA");
  });

  // ── closed + F1/F1b neutral fallback → restore closed-disclosure ────────────
  // guardDraft (F1/F1b) full-replaces a draft that bundled an UNEARNED success
  // claim WITH the closed-disclosure → the neutral GROUNDED_SAFE_FALLBACK, which is
  // SILENT on closure. While closed, that drops a correct closed-disclosure, so the
  // delivery guard substitutes closedHoursDisclosure() (asserts nothing open).

  it("closed: a draft stripped to the neutral fallback (false success) discloses closed instead", async () => {
    const { model } = mockModel("Seu pedido já foi registrado com sucesso!");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      resolveScheduleSignal: () => closedSignal,
    });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = { kind: "executed", envelope: { kind: "order.cart.ensure" }, result: { cartId: "cart_1" } };
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["order.cart.ensure"], acted, text: "finaliza meu pedido" }),
    );
    expect(draft.text).toBe(CLOSED_DISCLOSURE);
    // Token usage from the (still-traced) model call survives the substitution.
    expect(draft.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it("open: the same false-success draft stays the neutral fallback (no disclosure)", async () => {
    const { model } = mockModel("Seu pedido já foi registrado com sucesso!");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      resolveScheduleSignal: () => openSignal,
    });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const acted = { kind: "executed", envelope: { kind: "order.cart.ensure" }, result: { cartId: "cart_1" } };
    const draft = await responder.respond(
      mkInput({ decision, envelopeKinds: ["order.cart.ensure"], acted, text: "finaliza meu pedido" }),
    );
    expect(draft.text).toBe(GROUNDED_SAFE_FALLBACK_PTBR);
  });

  it("closed: an already-correct closed-disclosure reply (no fallback) is untouched", async () => {
    // The model already discloses closed + offers scheduling and makes NO false
    // success claim, so neither guardDraft nor the closed-hours delivery guard
    // should touch it — the substitution fires ONLY for the neutral fallback.
    const { model } = mockModel("No momento estamos fechados, posso agendar sua retirada amanhã.");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      resolveScheduleSignal: () => closedSignal,
    });
    const decision = { kind: "REFUSE", refusal: { code: "empty_plan" } } as unknown as Decision;
    const draft = await responder.respond(mkInput({ decision, envelopeKinds: [], text: "tão abertos?" }));
    expect(draft.text).toBe("No momento estamos fechados, posso agendar sua retirada amanhã.");
  });
});

// ── F6 (BKL-064): pt-BR-only output guard (Spanish leak) ──────────────────────
describe("replyLeaksSpanish — conservative Spanish detector (BKL-064)", () => {
  it("does NOT flag valid pt-BR (no false positives)", () => {
    for (const ptbr of [
      "Recebi sua solicitação e ela foi registrada.",
      "Olá! Seu pedido foi confirmado com sucesso, muito obrigado!",
      "No momento estamos fechados, posso agendar sua retirada amanhã.",
      "Também temos opções sem glúten aqui. Como posso ajudar?",
      "O pagamento via PIX está pendente; assim que cair, avisamos.",
    ]) {
      expect(replyLeaksSpanish(ptbr)).toBeNull();
    }
  });

  it("flags Spanish inverted punctuation (zero-FP trigger)", () => {
    expect(replyLeaksSpanish("¡Hola! ¿En qué puedo ayudarte?")).not.toBeNull();
    expect(replyLeaksSpanish("Su pedido está listo ¿algo más?")).not.toBeNull();
  });

  it("flags ≥2 distinct Spanish-exclusive tokens", () => {
    expect(replyLeaksSpanish("Gracias, su pedido estará listo ahora.")).not.toBeNull();
    expect(replyLeaksSpanish("Hola, muy bien, nosotros entregamos rápido.")).not.toBeNull();
    expect(replyLeaksSpanish("El niño de la mañana llegó.")).not.toBeNull(); // ñ + manana
  });

  it("does NOT flag a single lone token (below the confidence bar)", () => {
    // A lone 'pero'/'bien' could be a fluke/brand — 2 signals required.
    expect(replyLeaksSpanish("Tudo pero certo com seu pedido.")).toBeNull();
  });
});

describe("guardDraft — Spanish leak clamps to the pt-BR language fallback (BKL-064)", () => {
  it("clamps a Spanish EXECUTE draft the pt-BR guards would miss", async () => {
    // Spanish, ≥2 exclusive tokens (hola/muy/gracias), NO success-claim words —
    // so it slips past the pt-BR F1/F1b lexicons and must hit the language guard.
    const { model } = mockModel("Hola, su pedido llegará muy pronto. Gracias.");
    const responder = createIbatexasResponder({ model, modelId: "m", explainer });
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
    expect(draft.text).toBe(PT_BR_LANGUAGE_FALLBACK_PTBR);
  });
});
