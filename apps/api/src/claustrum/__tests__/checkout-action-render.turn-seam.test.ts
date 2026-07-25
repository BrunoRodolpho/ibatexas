// BKL-230 turn-seam acceptance — proves the deterministic checkout render is
// actually DELIVERED, not merely computable.
//
// WHY THIS FILE EXISTS SEPARATELY FROM customer-action-render.test.ts: this repo
// has a hard-won lesson (LE2-002) that a renderer-level suite can be fully green
// while the feature is DEAD through the real gate — the render was correct, the
// seam never called it. So this suite never calls `renderCustomerActionAnswer`
// directly. It drives the two REAL stages a customer turn passes through, in
// order, with the render reachable ONLY the way production reaches it:
//
//   stage 6  — `createIbatexasResponder(...).respond(...)`, the production
//              ResponderPort, wired with the EXACT `readAnswer` object
//              claustrum-bootstrap.ts composes for the customer plane
//              (`renderAction: (acted, _turnId) => renderCustomerActionAnswer(acted)`).
//              This is the seam that must call the render and return its text.
//              NOTE: `readAnswer.renderAction` had NO test coverage on EITHER plane
//              before this file (the BKL-100 tests at
//              __tests__/ibatexas-responder-personas.test.ts:190-206 cover the READ
//              sibling `readAnswer.render` only) — so the action short-circuit that
//              BKL-149 and BKL-215 both depend on was, until now, unpinned.
//   stage 6a — `decideRenderPrecedence`, the lattice that decides whether the
//              stage-6 draft SURVIVES. A committed checkout's claims degrade to
//              UNKNOWN (a mutation turn does no read), so rule 3b (BKL-225,
//              `committed_mutation_action`) is the ONLY thing standing between the
//              deterministic line and a degenerate render clobbering it. Before
//              BKL-230 the cash line survived here by LUCK (it was model prose
//              that happened to be kept) and PIX had no draft at all to keep.
//
// `deliveredText` composes the two exactly as handleTurn does, so every assertion
// below is about what the CUSTOMER receives.
//
// The truthfulness arm is the point of the ticket: `createCheckout` can return
// `success:false` WITHOUT throwing (payment-init failure; missing PIX name/email),
// and such a dispatch is still `executed` — so a success line must never be
// delivered for it. That arm asserts the delivered text at the seam, not the
// renderer's return value.

import { describe, expect, it, vi } from "vitest";
import type {
  ClaimsKernelResult,
  ConsistencyClaim,
  Decision,
  IntentEnvelope,
  SuppressionRecord,
  TurnTerminal,
} from "@adjudicate/core";
import type {
  CognitiveState,
  Completion,
  CompletionRequest,
  ExplainerPort,
  ModelProvider,
  Plan,
} from "@claustrum/core";
import { createIbatexasResponder } from "../ibatexas-responder.js";
import { renderCustomerActionAnswer } from "../customer-action-render.js";
import { decideRenderPrecedence } from "../claims-render-precedence.js";

// ── The exact pt-BR lines BKL-230 ships (asserted, never rebuilt from the source) ──

const PIX_LINE =
  "Seu código PIX foi gerado! O pedido será confirmado assim que o pagamento for aprovado.";
const CASH_LINE = "Pronto! Seu pedido IBX-0042 foi confirmado.";

/** What the model would have said. Any delivered text equal to this proves the
 *  turn fell through to the model path (the pre-BKL-230 behaviour). */
const MODEL_PROSE = "Pedido finalizado com sucesso! Obrigado pela preferência.";

// ── Stage 6: the REAL responder, wired the way the REAL bootstrap wires it ──────

function mockModel(text = MODEL_PROSE): {
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
  return {
    model: {
      complete,
      stream: () => {
        throw new Error("stream not used");
      },
      embed: async () => {
        throw new Error("embed not used");
      },
    },
    complete,
  };
}

const explainer: ExplainerPort = { render: (r) => `REFUSAL:${r.code}` };

/**
 * The customer-plane `readAnswer` port, byte-identical to the object
 * claustrum-bootstrap.ts hands `createIbatexasResponder` (BKL-215/BKL-230): no
 * deterministic customer READ render, and the action render delegating to
 * `renderCustomerActionAnswer(acted)`. Copied rather than imported because the
 * bootstrap composes it inline inside `bootstrapClaustrum` (whose import boots the
 * whole process); the boot-level guard that production really passes this shape is
 * claustrum-bootstrap-safe-unknown.test.ts's harness suite.
 */
const CUSTOMER_READ_ANSWER = {
  render: (_turnId: string) => undefined,
  renderAction: (acted: unknown, _turnId: string) => renderCustomerActionAnswer(acted),
};

const EXECUTE: Decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;

/** A committed customer dispatch carrying the checkout tool's OWN return value. */
function checkoutActed(result: unknown): unknown {
  return {
    kind: "executed",
    envelope: {
      kind: "order.checkout.create",
      payload: { cartId: "cart_1", paymentMethod: "pix" },
    },
    result,
  };
}

function checkoutPlan(): Plan {
  return {
    envelopes: [
      { kind: "order.checkout.create", payload: { cartId: "cart_1" } } as unknown as IntentEnvelope,
    ],
  } as Plan;
}

function cognition(text: string): CognitiveState {
  return {
    perception: { text, channel: "web", receivedAt: "2026-07-04T00:00:00.000Z" },
    memory: { recentActions: [], facts: [] },
    retrieval: { docs: [] },
    tenantId: "ibatexas",
    locale: "pt-BR",
    conversationId: "web:cust_1",
    turnId: "turn-checkout-1",
  } as unknown as CognitiveState;
}

/** Run stage 6 — the production responder on a committed checkout EXECUTE. */
async function respondToCheckout(
  result: unknown,
  requestText = "sim",
): Promise<{ text: string; modelCalls: number }> {
  const { model, complete } = mockModel();
  const responder = createIbatexasResponder({
    model,
    modelId: "m",
    explainer,
    readAnswer: CUSTOMER_READ_ANSWER,
  });
  const draft = await responder.respond({
    cognition: cognition(requestText),
    decision: EXECUTE,
    plan: checkoutPlan(),
    acted: checkoutActed(result),
  } as unknown as Parameters<ReturnType<typeof createIbatexasResponder>["respond"]>[0]);
  return { text: draft.text, modelCalls: complete.mock.calls.length };
}

// ── Stage 6a: the REAL precedence lattice ───────────────────────────────────────

function claimsResult(
  terminal: TurnTerminal,
  suppressions: readonly SuppressionRecord[] = [],
): ClaimsKernelResult {
  const renderable: readonly ConsistencyClaim[] = [];
  return {
    perClaim: [],
    renderable,
    terminal,
    consistency: { renderable, terminal, suppressions },
    renderableCanonical: [],
  };
}

/** The degenerate claims render a read-less mutation turn produces — what rule 3b
 *  must stop from clobbering the deterministic action reply. */
const DEGENERATE_RENDER = "Não localizei essa informação. Posso verificar para você?";

/**
 * The text the CUSTOMER receives: stage 6 drafts, stage 6a decides. `keep_draft`
 * delivers the responder draft; `render` delivers the claims render. This mirrors
 * handleTurn's 6/6a composition — the whole path BKL-230 has to survive.
 */
async function deliveredText(
  result: unknown,
  opts: { terminal?: TurnTerminal; requestText?: string } = {},
): Promise<{ text: string; mechanism: string; modelCalls: number }> {
  const requestText = opts.requestText ?? "sim";
  const draft = await respondToCheckout(result, requestText);
  const verdict = decideRenderPrecedence({
    decision: EXECUTE,
    plan: checkoutPlan(),
    claims: claimsResult(opts.terminal ?? "UNKNOWN"),
    requestText,
  });
  return {
    text: verdict.decision === "keep_draft" ? draft.text : DEGENERATE_RENDER,
    mechanism: verdict.mechanism,
    modelCalls: draft.modelCalls,
  };
}

// ── The readAnswer.renderAction short-circuit itself (first coverage, either plane) ──
//
// The property BKL-149/BKL-215/BKL-230 all rest on: when the action render returns a
// string, the responder returns it VERBATIM and never reaches the model. Pinned here
// in its own right, separately from the checkout copy, so a regression in the
// short-circuit is distinguishable from a regression in the rendered text.

describe("responder readAnswer.renderAction short-circuit (BKL-149/215/230 — previously unpinned)", () => {
  it("a rendered action IS the reply, verbatim, and the model is never called", async () => {
    const { model, complete } = mockModel();
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      readAnswer: CUSTOMER_READ_ANSWER,
    });
    const draft = await responder.respond({
      cognition: cognition("sim"),
      decision: EXECUTE,
      plan: checkoutPlan(),
      acted: checkoutActed({ success: true, paymentMethod: "pix", orderId: "pi_x" }),
    } as unknown as Parameters<ReturnType<typeof createIbatexasResponder>["respond"]>[0]);
    expect(draft.text).toBe(PIX_LINE);
    expect(complete).not.toHaveBeenCalled();
  });

  it("when the render abstains the model path runs (the dep does not swallow the turn)", async () => {
    const { model, complete } = mockModel();
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      readAnswer: CUSTOMER_READ_ANSWER,
    });
    const draft = await responder.respond({
      cognition: cognition("sim"),
      decision: EXECUTE,
      plan: checkoutPlan(),
      acted: checkoutActed({ success: false, paymentMethod: "pix" }),
    } as unknown as Parameters<ReturnType<typeof createIbatexasResponder>["respond"]>[0]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(draft.text).toBe(MODEL_PROSE);
  });
});

// ── The PIX turn — the one that degraded to UNKNOWN before BKL-230 ──────────────

describe("BKL-230 turn seam — a successful PIX checkout DELIVERS the deterministic line", () => {
  const PIX_SUCCESS = {
    success: true,
    paymentMethod: "pix",
    orderId: "pi_3QxyzABC123",
    pixCopyPaste: "00020126580014br.gov.bcb.pix",
    pixQrCode: "https://stripe.example/qr.svg",
  };

  it("the responder returns the PIX line and the MODEL IS NEVER CALLED (stage 6)", async () => {
    const { text, modelCalls } = await respondToCheckout(PIX_SUCCESS);
    expect(text).toBe(PIX_LINE);
    // No probabilistic model authored any part of the customer's reply.
    expect(modelCalls).toBe(0);
  });

  it("rule 3b KEEPS it against the degenerate UNKNOWN render, so the customer receives it", async () => {
    const { text, mechanism } = await deliveredText(PIX_SUCCESS);
    expect(mechanism).toBe("committed_mutation_action");
    expect(text).toBe(PIX_LINE);
    expect(text).not.toBe(DEGENERATE_RENDER);
  });

  it("the delivered PIX line never voices the Stripe pi_… PaymentIntent as an order number", async () => {
    const { text } = await deliveredText(PIX_SUCCESS);
    expect(text).not.toContain("pi_3QxyzABC123");
    expect(text).not.toContain("pi_");
    expect(text).not.toMatch(/IBX-\d/);
  });

  it("the delivered PIX line does NOT claim the order or the payment is already settled", async () => {
    const { text } = await deliveredText(PIX_SUCCESS);
    expect(text).toMatch(/será confirmado assim que o pagamento for aprovado/);
    expect(text).not.toMatch(/pagamento (?:foi )?(?:aprovado|confirmado|recebido)\b/i);
    expect(text).not.toMatch(/pedido (?:foi |está )?(?:confirmado|pago)\b/i);
  });

  it("a VALIDATED read on the same turn still wins (rule 3 unchanged — no BKL-225 regression)", async () => {
    const { mechanism } = await deliveredText(PIX_SUCCESS, { terminal: "RENDER" });
    expect(mechanism).toBe("validated_render");
  });

  it("a suppression/ESCALATE on the same turn still wins (rule 1 safety unchanged)", async () => {
    const { mechanism } = await deliveredText(PIX_SUCCESS, { terminal: "ESCALATE" });
    expect(mechanism).toBe("claims_escalate_or_suppression");
  });
});

// ── The cash turn — model prose that survived by luck is now deterministic ──────

describe("BKL-230 turn seam — a successful cash checkout DELIVERS the deterministic line", () => {
  const CASH_SUCCESS = { success: true, paymentMethod: "cash", orderId: "IBX-0042" };

  it("the responder returns the cash line from the tool's own display id, model never called", async () => {
    const { text, modelCalls } = await respondToCheckout(CASH_SUCCESS);
    expect(text).toBe(CASH_LINE);
    expect(modelCalls).toBe(0);
    // The pre-BKL-230 reply was this model prose, kept by luck.
    expect(text).not.toBe(MODEL_PROSE);
  });

  it("rule 3b keeps it, and the delivered text carries the real IBX display id", async () => {
    const { text, mechanism } = await deliveredText(CASH_SUCCESS);
    expect(mechanism).toBe("committed_mutation_action");
    expect(text).toBe(CASH_LINE);
    expect(text).toContain("IBX-0042");
  });
});

// ── THE TRUTHFULNESS ARM — a failed tool call must deliver NO success line ──────

describe("BKL-230 turn seam — a FAILED checkout tool result delivers NO success claim", () => {
  // Each of these is a real `createCheckout` early return: it does NOT throw, so
  // the dispatch is still `executed` and the kernel still decided EXECUTE.
  const FAILURES: ReadonlyArray<readonly [string, unknown]> = [
    [
      "payment-init failure",
      {
        success: false,
        paymentMethod: "pix",
        message:
          "Não foi possível inicializar o pagamento. Tente novamente ou escolha pagamento em dinheiro.",
      },
    ],
    [
      "missing PIX name/email",
      {
        success: false,
        paymentMethod: "pix",
        message: "Nome e email são obrigatórios para pagamento PIX.",
      },
    ],
    [
      "PIX QR generation error",
      { success: false, paymentMethod: "pix", orderId: "pi_3QxyzABC123" },
    ],
    ["cash completion failure", { success: false, paymentMethod: "cash", orderId: "IBX-0042" }],
  ];

  it.each(FAILURES)(
    "%s → the deterministic success lines are NEVER delivered",
    async (_label, result) => {
      const { text } = await deliveredText(result);
      expect(text).not.toBe(PIX_LINE);
      expect(text).not.toBe(CASH_LINE);
      expect(text).not.toMatch(/código PIX foi gerado/i);
      expect(text).not.toMatch(/pedido .{0,12}foi confirmado/i);
    },
  );

  it.each(FAILURES)(
    "%s → the responder falls through to the existing model path (behaviour preserved)",
    async (_label, result) => {
      const { text, modelCalls } = await respondToCheckout(result);
      // The render abstained, so the grounded model path ran — exactly as today.
      expect(modelCalls).toBe(1);
      expect(text).toBe(MODEL_PROSE);
    },
  );

  it("a card success also abstains (nothing is placed on a client-secret handoff)", async () => {
    const { text, modelCalls } = await respondToCheckout({
      success: true,
      paymentMethod: "card",
      stripeClientSecret: "pi_3Q_secret_abc",
      paymentIntentId: "pi_3QxyzABC123",
    });
    expect(modelCalls).toBe(1);
    expect(text).toBe(MODEL_PROSE);
  });

  it("a checkout result with NO success field abstains (absence is not proof)", async () => {
    const { text, modelCalls } = await respondToCheckout({ paymentMethod: "pix", orderId: "pi_x" });
    expect(modelCalls).toBe(1);
    expect(text).toBe(MODEL_PROSE);
  });
});

// ── Scope guard: the seam is unchanged for every other customer kind ────────────

describe("BKL-230 turn seam — no collateral change to other kinds", () => {
  it("a committed amend still delivers its BKL-215 line through the same seam", async () => {
    const { model, complete } = mockModel();
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      readAnswer: CUSTOMER_READ_ANSWER,
    });
    const draft = await responder.respond({
      cognition: cognition("sim"),
      decision: EXECUTE,
      plan: checkoutPlan(),
      acted: {
        kind: "executed",
        envelope: { kind: "order.amend.add_item", payload: { quantity: 2 } },
        result: { ok: true },
      },
    } as unknown as Parameters<ReturnType<typeof createIbatexasResponder>["respond"]>[0]);
    expect(draft.text).toBe("Pronto! Adicionei 2 unidades ao seu pedido.");
    expect(complete).not.toHaveBeenCalled();
  });

  it("a committed order.item.add still rides the model path (untouched by BKL-230)", async () => {
    const { model, complete } = mockModel("Adicionei ao carrinho!");
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      readAnswer: CUSTOMER_READ_ANSWER,
    });
    const draft = await responder.respond({
      cognition: cognition("quero uma picanha"),
      decision: EXECUTE,
      plan: checkoutPlan(),
      acted: {
        kind: "executed",
        envelope: { kind: "order.item.add", payload: { variantId: "v1", quantity: 1 } },
        result: { success: true },
      },
    } as unknown as Parameters<ReturnType<typeof createIbatexasResponder>["respond"]>[0]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(draft.text).toBe("Adicionei ao carrinho!");
  });
});
