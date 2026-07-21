// Customer-plane responder guards added in fix/agent-prompt-injection-leaks:
//   ④ F1b false-FAILURE mirror — a COMMITTED action reported as "not done" is as
//     harmful as a false success, so it is clamped too (with a domain-noun guard so a
//     shared verb root does not cross-flag a different-noun honest failure).
//   ⑦ customer-plane ungrounded-MONEY clamp — an invented R$ amount must not ship on
//     the customer/WhatsApp plane (where the ops digit-run clamp is not wired).

import { describe, expect, it } from "vitest";
import {
  CUSTOMER_UNGROUNDED_MONEY_FALLBACK_PTBR,
  replyClaimsUnearnedSuccess,
  statesUngroundedMoney,
} from "../ibatexas-responder.js";

// An `acted` shape executedKinds() reads as a COMMITTED mutation of `kind`.
const committed = (kind: string) => ({ kind: "executed", envelope: { kind } });

describe("④ F1b false-FAILURE mirror", () => {
  it("flags a false 'não foi cancelado' after order.cancel COMMITTED", () => {
    const hit = replyClaimsUnearnedSuccess(
      "Infelizmente seu pedido não foi cancelado, tente novamente.",
      committed("order.cancel"),
    );
    expect(hit).toBe("false-failure:order-canceled");
  });

  it("does NOT flag an HONEST failure when the action did NOT commit", () => {
    expect(
      replyClaimsUnearnedSuccess(
        "Seu pedido não foi cancelado.",
        { kind: "refused" }, // nothing committed
      ),
    ).toBeNull();
  });

  it("noun guard: a different-noun negated statement is NOT cross-flagged by a shared verb root", () => {
    // order.checkout.create committed (justifies order-placed, whose verbs include
    // 'confirm'), but the reply negates a RESERVA — not a false pedido-failure.
    expect(
      replyClaimsUnearnedSuccess(
        "Sua reserva não foi confirmada.",
        committed("order.checkout.create"),
      ),
    ).toBeNull();
  });

  it("still flags a genuine unearned SUCCESS (the original F1b direction)", () => {
    const hit = replyClaimsUnearnedSuccess(
      "Pronto! Seu pedido foi cancelado com sucesso.",
      { kind: "refused" }, // cancel did NOT commit
    );
    expect(hit).toBe("order-canceled");
  });

  // Mood gate (review fix): a committed-but-still-settling checkout reported as "not
  // yet confirmed" is an HONEST pending report, not a false failure — do NOT clamp it.
  it("does NOT clamp an honest 'ainda não foi confirmado' pending PIX checkout", () => {
    expect(
      replyClaimsUnearnedSuccess(
        "Seu pedido ainda não foi confirmado, aguardando o pagamento via PIX.",
        committed("order.checkout.create"),
      ),
    ).toBeNull();
  });

  // …but the mood gate is CLAUSE-LOCAL: a pending word in an unrelated trailing clause
  // must not shield a flat false failure in a different clause.
  it("clause-local: a trailing 'ainda' courtesy clause does NOT shield a flat false failure", () => {
    expect(
      replyClaimsUnearnedSuccess(
        "Seu pedido não foi cancelado, mas ainda posso ajudar.",
        committed("order.cancel"),
      ),
    ).toBe("false-failure:order-canceled");
  });
});

describe("⑦ customer-plane ungrounded-money clamp", () => {
  it("flags an R$ amount not grounded in any allowed source", () => {
    expect(
      statesUngroundedMoney("A picanha custa R$ 120,00.", ["quero saber da picanha"]),
    ).toBe(true);
  });

  it("does NOT flag an R$ amount grounded in the context (centavos ⇄ reais canonicalize)", () => {
    expect(
      statesUngroundedMoney("O total ficou em R$ 89,00.", ['{"result":{"total":8900}}']),
    ).toBe(false);
  });

  // Review fix: a WHOLE-reais reply ("R$ 89", no cents) is the SAME value as a grounded
  // integer-centavos 8900 (Hard Rule #2) — it must NOT be false-clamped for dropping ",00".
  it("does NOT flag an abbreviated whole-reais amount grounded as centavos ('R$ 89' vs 8900)", () => {
    expect(
      statesUngroundedMoney("Seu pedido saiu por R$ 89.", ['{"result":{"total":8900}}']),
    ).toBe(false);
  });

  it("still flags an invented whole-reais amount with no grounding ('R$ 89' vs nothing)", () => {
    expect(statesUngroundedMoney("Custa R$ 89 no total.", [])).toBe(true);
  });

  it("does NOT flag a reply with no money figure", () => {
    expect(statesUngroundedMoney("Claro! Como posso ajudar?", [])).toBe(false);
  });

  it("echoing the customer's own amount is grounded (not clamped)", () => {
    expect(
      statesUngroundedMoney("São R$ 50 mesmo.", ["consigo pagar só R$ 50 hoje"]),
    ).toBe(false);
  });

  it("exposes a neutral, figure-free customer fallback line", () => {
    expect(CUSTOMER_UNGROUNDED_MONEY_FALLBACK_PTBR).not.toMatch(/\d/);
    expect(CUSTOMER_UNGROUNDED_MONEY_FALLBACK_PTBR).toMatch(/verificar|confirmar/i);
  });
});

// ── BKL-194 — the review false-success (live 9ff869ed) + the sweep additions ──
// The live confabulation: "Sua avaliação…foi recebida e registrada" delivered with
// ZERO order.review.submit rows. "recebida" sits in PENDING_STATUS, so a naive
// class would be mood-exempted — `receiptIsCompletion` disables that exemption for
// receipt-semantics classes. Each sweep class gets both arms (unearned → flagged;
// committed justifier → passes).
describe("BKL-194 — review-received + sweep classes", () => {
  const committed = (kind: string) => ({ kind: "executed", envelope: { kind } });
  const LIVE_REPRO =
    "Sua avaliação de 5 estrelas para o pedido 985669 foi recebida e registrada. Obrigado pelo seu feedback!";

  it("flags the LIVE repro verbatim when no review was executed (the 9ff869ed turn)", () => {
    expect(replyClaimsUnearnedSuccess(LIVE_REPRO, { kind: "refused" })).toBe("review-received");
  });

  it("passes the SAME prose when order.review.submit genuinely committed", () => {
    expect(replyClaimsUnearnedSuccess(LIVE_REPRO, committed("order.review.submit"))).toBeNull();
  });

  it("honest failure ('não foi registrada') is never substituted", () => {
    expect(
      replyClaimsUnearnedSuccess("Sua avaliação não foi registrada, tente novamente.", { kind: "refused" }),
    ).toBeNull();
  });

  it("future-mood review promise stays exempt (only PENDING is disabled for receipt classes)", () => {
    expect(
      replyClaimsUnearnedSuccess("Sua avaliação será registrada em instantes.", { kind: "refused" }),
    ).toBeNull();
  });

  it("the rating sense of 'nota' rides review-received; 'nota fiscal' does not", () => {
    expect(replyClaimsUnearnedSuccess("Sua nota foi registrada, obrigado!", { kind: "refused" })).toBe(
      "review-received",
    );
    expect(replyClaimsUnearnedSuccess("Sua nota fiscal foi emitida.", { kind: "refused" })).toBe(
      "fiscal-emitted",
    );
  });

  it.each([
    ["reservation-canceled", "Sua reserva foi cancelada.", "reservation.cancel"],
    ["coupon-applied", "Cupom aplicado ao seu pedido!", "order.coupon.apply"],
    ["address-updated", "Seu endereço foi atualizado.", "order.address.change"],
    ["preferences-saved", "Suas preferências foram salvas.", "customer.preferences.update"],
    ["payment-method-switched", "Sua forma de pagamento foi alterada para PIX.", "payment.method.switch"],
    ["fiscal-emitted", "Sua nota fiscal foi emitida.", "order.fiscal.emit"],
    ["data-anonymized", "Seus dados foram apagados do sistema.", "customer.anonymize"],
  ])("%s: unearned → flagged; committed justifier → passes", (id, prose, kind) => {
    expect(replyClaimsUnearnedSuccess(prose, { kind: "refused" })).toBe(id);
    expect(replyClaimsUnearnedSuccess(prose, committed(kind))).toBeNull();
  });

  it("widened justifiers: reorder earns order-placed; type-switch earns order-amended", () => {
    expect(replyClaimsUnearnedSuccess("Seu pedido foi registrado!", committed("order.reorder"))).toBeNull();
    expect(
      replyClaimsUnearnedSuccess("Seu pedido foi alterado para retirada.", committed("order.type.switch")),
    ).toBeNull();
  });

  it("desconto extra rides coupon-applied", () => {
    expect(replyClaimsUnearnedSuccess("Desconto aplicado!", { kind: "refused" })).toBe("coupon-applied");
  });
});
