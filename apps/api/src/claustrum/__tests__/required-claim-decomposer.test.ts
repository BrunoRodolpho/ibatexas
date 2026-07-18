/**
 * required-claim-decomposer.test.ts — SDD §O#15 (Plan 1 Phase 3). Pins:
 *   (1) the closure table maps each span-class to its mandatory required set;
 *   (2) decomposition is CONSERVATIVE-OVER-DECOMPOSING (union; over-include);
 *   (3) an unrecognized span-class forces NO companion (no over-suppression);
 *   (4) completeness quantifies over the REQUIRED set, not the candidates —
 *       an ABSENT / UNKNOWN / REFUSED required companion DEGRADES the turn;
 *   (5) the closure table references only in-registry claim types.
 */
import type { ClaimVerdict } from "@adjudicate/core";
import { describe, expect, it } from "vitest";
import { isRegistryClaimType, type RegistryClaimType } from "../claim-registry.js";
import {
  type ActiveResourceOwnership,
  checkRequiredClaimCompleteness,
  classifyRequestSpans,
  decomposeRequiredClaims,
  isSpanClass,
  REQUIRED_CLAIM_CLOSURE,
} from "../required-claim-decomposer.js";

describe("required-claim decomposer — closure table (SDD §O#15)", () => {
  it("every closure value is an in-registry claim type", () => {
    for (const types of Object.values(REQUIRED_CLAIM_CLOSURE)) {
      for (const t of types) expect(isRegistryClaimType(t)).toBe(true);
    }
  });

  it("a pickup/hours question requires MORE than one type (the §O#15 worked example)", () => {
    const required = decomposeRequiredClaims(["PICKUP_Q"]);
    expect(required.has("STORE_OPEN_NOW")).toBe(true);
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
    expect(required.size).toBe(2);
  });

  it("each single span-class maps to its declared required set", () => {
    expect([...decomposeRequiredClaims(["STORE_OPEN_NOW_Q"])]).toEqual([
      "STORE_OPEN_NOW",
    ]);
    expect([...decomposeRequiredClaims(["STORE_HOURS_FOR_DATE_Q"])]).toEqual([
      "STORE_HOURS_FOR_DATE",
    ]);
    expect([...decomposeRequiredClaims(["ORDER_STATUS_Q"])]).toEqual([
      "ORDER_FULFILLMENT_STAGE",
    ]);
    expect([...decomposeRequiredClaims(["PAYMENT_STATUS_Q"])]).toEqual([
      "PAYMENT_STATUS",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BKL-138 — the DAY-SPECIFIC hours span class (SCN-002/003). Fires ONLY on the
// CONJUNCTION of a date anchor (named weekday / "amanhã" / "feriado") AND schedule
// phrasing; demote-only safe (over-inclusion only forces the date-hours companion).
// ─────────────────────────────────────────────────────────────────────────────
describe("classifyRequestSpans — BKL-138 STORE_HOURS_FOR_DATE_Q", () => {
  it("'qual o horário de domingo?' → STORE_HOURS_FOR_DATE_Q → requires STORE_HOURS_FOR_DATE", () => {
    const spans = classifyRequestSpans("qual o horário de domingo?");
    expect(spans).toContain("STORE_HOURS_FOR_DATE_Q");
    const required = decomposeRequiredClaims(spans);
    expect(required.has("STORE_HOURS_FOR_DATE")).toBe(true);
  });

  it("'vocês abrem amanhã no feriado?' → STORE_HOURS_FOR_DATE_Q (SCN-003)", () => {
    const spans = classifyRequestSpans("vocês abrem amanhã no feriado?");
    expect(spans).toContain("STORE_HOURS_FOR_DATE_Q");
    // …and this phrasing does NOT trip STORE_OPEN_NOW_Q (no abert/que horas/funciona/horário).
    expect(spans).not.toContain("STORE_OPEN_NOW_Q");
  });

  it("named-weekday variants with schedule context all fire", () => {
    for (const text of [
      "que horas abre segunda?",
      "funcionam no sábado?",
      "tem expediente na terça?",
      "vocês atendem quarta-feira?",
    ]) {
      expect(classifyRequestSpans(text)).toContain("STORE_HOURS_FOR_DATE_Q");
    }
  });

  it("a bare schedule question with NO date anchor does NOT fire (stays STORE_OPEN_NOW_Q)", () => {
    const spans = classifyRequestSpans("que horas vocês funcionam?");
    expect(spans).not.toContain("STORE_HOURS_FOR_DATE_Q");
    expect(spans).toContain("STORE_OPEN_NOW_Q");
  });

  it("DEMOTE-ONLY safety: a greeting that merely names a day is NOT swept in", () => {
    // No schedule phrasing → the date anchor alone must not force the companion.
    for (const text of ["bom domingo pra você!", "até sábado, obrigado!", "feliz feriado!"]) {
      expect(classifyRequestSpans(text)).not.toContain("STORE_HOURS_FOR_DATE_Q");
    }
  });

  it("the BKL-005 statement corpus is not over-promoted by the date markers", () => {
    for (const text of [
      "meu pedido chegou, obrigado!",
      "vou pagar com pix",
      "adorei o pagode de sábado", // a weekday word but no schedule context
    ]) {
      expect(classifyRequestSpans(text)).not.toContain("STORE_HOURS_FOR_DATE_Q");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BKL-152 — DATE-ANCHOR companion suppression (SCN-002 blocker). A date-anchored
// hours question trips STORE_HOURS_FOR_DATE_Q AND (via "horário"/"que horas")
// STORE_OPEN_NOW_Q; the TODAY open-now companion is irrelevant to a FUTURE-date
// question and the planner never resolves it → the §O#15 completeness gate
// demote-degraded an otherwise-VALIDATED date-hours render to UNKNOWN. The decomposer
// SUPPRESSES STORE_OPEN_NOW iff STORE_HOURS_FOR_DATE_Q ∈ spans AND PICKUP_Q ∉ spans.
// Demote-only: the date-specific hours still render. All four directions pinned.
// ─────────────────────────────────────────────────────────────────────────────
describe("required-claim decomposer — BKL-152 date-anchor STORE_OPEN_NOW suppression", () => {
  it("SUPPRESS (end-to-end): 'que horas vocês abrem amanhã?' drops STORE_OPEN_NOW, keeps STORE_HOURS_FOR_DATE", () => {
    const spans = classifyRequestSpans("que horas vocês abrem amanhã?");
    // Premise — BOTH spans fire: "que horas" trips STORE_OPEN_NOW_Q; amanhã+schedule
    // trips the date-for span. Pre-fix this forced the STORE_OPEN_NOW companion.
    expect(spans).toContain("STORE_HOURS_FOR_DATE_Q");
    expect(spans).toContain("STORE_OPEN_NOW_Q");
    const required = decomposeRequiredClaims(spans);
    expect(required.has("STORE_HOURS_FOR_DATE")).toBe(true);
    expect(required.has("STORE_OPEN_NOW")).toBe(false);
  });

  it("SUPPRESS (end-to-end): 'qual o horário de domingo?' → only STORE_HOURS_FOR_DATE (the exact SCN-002 phrasing)", () => {
    const spans = classifyRequestSpans("qual o horário de domingo?");
    expect(spans).toContain("STORE_HOURS_FOR_DATE_Q");
    // "horário" trips STORE_OPEN_NOW_Q (store-open-now.generated markers /hor[áa]rio/).
    expect(spans).toContain("STORE_OPEN_NOW_Q");
    expect([...decomposeRequiredClaims(spans)]).toEqual(["STORE_HOURS_FOR_DATE"]);
  });

  it("SUPPRESS (unit): STORE_HOURS_FOR_DATE_Q + STORE_OPEN_NOW_Q → only STORE_HOURS_FOR_DATE", () => {
    expect(
      [...decomposeRequiredClaims(["STORE_OPEN_NOW_Q", "STORE_HOURS_FOR_DATE_Q"])],
    ).toEqual(["STORE_HOURS_FOR_DATE"]);
  });

  it("KEEP (today): 'que horas vocês abrem hoje?' keeps STORE_OPEN_NOW ('hoje' never fires the date-for span)", () => {
    const spans = classifyRequestSpans("que horas vocês abrem hoje?");
    expect(spans).not.toContain("STORE_HOURS_FOR_DATE_Q");
    expect(spans).toContain("STORE_OPEN_NOW_Q");
    expect(decomposeRequiredClaims(spans).has("STORE_OPEN_NOW")).toBe(true);
  });

  it("KEEP (undated): 'vocês estão abertos agora?' keeps STORE_OPEN_NOW", () => {
    const spans = classifyRequestSpans("vocês estão abertos agora?");
    expect(spans).not.toContain("STORE_HOURS_FOR_DATE_Q");
    expect(decomposeRequiredClaims(spans).has("STORE_OPEN_NOW")).toBe(true);
  });

  it("KEEP (pickup, unit): a date-for span alongside PICKUP_Q keeps STORE_OPEN_NOW (pickup needs open-now)", () => {
    const required = decomposeRequiredClaims([
      "PICKUP_Q",
      "STORE_OPEN_NOW_Q",
      "STORE_HOURS_FOR_DATE_Q",
    ]);
    expect(required.has("STORE_OPEN_NOW")).toBe(true);
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
    expect(required.has("STORE_HOURS_FOR_DATE")).toBe(true);
  });

  it("KEEP (pickup, end-to-end): 'que horas posso retirar amanhã?' keeps STORE_OPEN_NOW", () => {
    const spans = classifyRequestSpans("que horas posso retirar amanhã?");
    expect(spans).toContain("PICKUP_Q");
    expect(spans).toContain("STORE_HOURS_FOR_DATE_Q");
    expect(decomposeRequiredClaims(spans).has("STORE_OPEN_NOW")).toBe(true);
  });

  it("NO-OP: a lone STORE_HOURS_FOR_DATE_Q (no open-now span) is unchanged (delete is a no-op)", () => {
    expect([...decomposeRequiredClaims(["STORE_HOURS_FOR_DATE_Q"])]).toEqual([
      "STORE_HOURS_FOR_DATE",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FE-T17 — RESERVATION_STATUS_Q (review fix, PR #249). The marker is ANCHORED
// (`(?<![a-z])reserv(?!at)(a|ar|ad|am|as|ando|ei|ou)`), not a bare substring test:
// the original unanchored `/reserva/` false-fired on the unrelated preserv* family
// (both share the substring "reserva") and — via the completeness gate
// (claims-renderer-adapter.ts) — a false span match can degrade an otherwise-valid
// answer to a DIFFERENT question to UNKNOWN. It also did NOT actually match
// "reservei" / "reservou" despite its old comment claiming coverage. These tests
// pin BOTH directions: every verb form the domain sees fires, and the false-positive
// family (plus "reservatório", a real word sharing the "reserva-" prefix but outside
// this domain) does not.
// ─────────────────────────────────────────────────────────────────────────────
describe("classifyRequestSpans — FE-T17 RESERVATION_STATUS_Q (anchored marker)", () => {
  it("fires on every reservation verb form this domain sees", () => {
    for (const text of [
      "reserva",
      "reservas",
      "reservar",
      "reservado",
      "reservada",
      "reservei",
      "reservou",
      "minha reserva",
      "qual minha reserva?",
      "como está minha reserva de amanhã?",
      "quero reservar uma mesa",
      "vocês reservam mesa para hoje?",
    ]) {
      expect(classifyRequestSpans(text), text).toContain("RESERVATION_STATUS_Q");
    }
  });

  it("'qual minha reserva?' → RESERVATION_STATUS_Q → requires RESERVATION_STATUS", () => {
    const spans = classifyRequestSpans("qual minha reserva?");
    expect(spans).toContain("RESERVATION_STATUS_Q");
    const required = decomposeRequiredClaims(spans);
    expect(required.has("RESERVATION_STATUS")).toBe(true);
  });

  it("does NOT false-fire on the unrelated preserv* family (the anchoring fix)", () => {
    for (const text of [
      "preservar",
      "preservam",
      "preservação",
      "preservativo",
      "vamos preservar o meio ambiente",
    ]) {
      expect(classifyRequestSpans(text), text).not.toContain("RESERVATION_STATUS_Q");
    }
  });

  it("does NOT fire on 'reservatório' (shares the reserva- prefix, outside this domain)", () => {
    expect(classifyRequestSpans("o reservatório está vazando")).not.toContain(
      "RESERVATION_STATUS_Q",
    );
  });
});

// BKL-139 — CART_CONTENTS_Q (anchored marker; read-vs-mutation split). The marker
// fires on a cart-READ question and is SUPPRESSED by a cart-mutation verb, so
// classify-only never mis-frames a cart write ("adicione ao carrinho") as a read.
describe("classifyRequestSpans — BKL-139 CART_CONTENTS_Q (read-only, anchored)", () => {
  it("MUST-FIRE on cart-contents READ questions", () => {
    for (const text of [
      "o que tem no meu carrinho?",
      "quanto está meu carrinho?",
      "ver meu carrinho",
      "minha sacola",
      "o que tem na cesta?",
      "quais itens tem no carrinho",
    ]) {
      expect(classifyRequestSpans(text), text).toContain("CART_CONTENTS_Q");
    }
  });

  it("'o que tem no meu carrinho?' → CART_CONTENTS_Q → requires CART_CONTENTS", () => {
    const spans = classifyRequestSpans("o que tem no meu carrinho?");
    expect(spans).toContain("CART_CONTENTS_Q");
    const required = decomposeRequiredClaims(spans);
    expect([...required]).toEqual(["CART_CONTENTS"]);
  });

  it("MUST-NOT-FIRE on cart MUTATIONS (the read-vs-write split — BKL-153)", () => {
    for (const text of [
      "adicione uma coca ao carrinho",
      "acrescenta um refri no carrinho",
      "remova a farofa do carrinho",
      "coloca mais uma costela no carrinho",
      "limpa o carrinho",
      "esvazia minha sacola",
      "troca o item do carrinho",
    ]) {
      expect(classifyRequestSpans(text), text).not.toContain("CART_CONTENTS_Q");
    }
  });

  it("MUST-NOT-FIRE on gratitude / order-status / payment turns (no cart word)", () => {
    for (const text of [
      "obrigado pelo atendimento",
      "muito obrigada!",
      "cadê meu pedido?",
      "qual o status do meu pagamento?",
    ]) {
      expect(classifyRequestSpans(text), text).not.toContain("CART_CONTENTS_Q");
    }
  });
});

describe("required-claim decomposer — conservative-over-decomposing", () => {
  it("UNIONs across multiple span-classes (over-include, never under-include)", () => {
    const required = decomposeRequiredClaims(["PAYMENT_STATUS_Q", "PICKUP_Q"]);
    expect(required.has("PAYMENT_STATUS")).toBe(true);
    expect(required.has("STORE_OPEN_NOW")).toBe(true);
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
  });

  it("an UNRECOGNIZED span-class forces NO companion (no over-suppression)", () => {
    expect(isSpanClass("NOT_A_CLASS")).toBe(false);
    expect(decomposeRequiredClaims(["NOT_A_CLASS"]).size).toBe(0);
    // A recognized class alongside an unrecognized one still contributes its set.
    expect([...decomposeRequiredClaims(["NOT_A_CLASS", "ORDER_STATUS_Q"])]).toEqual([
      "ORDER_FULFILLMENT_STAGE",
    ]);
  });

  it("an empty span-class list requires nothing (a greeting/smalltalk turn)", () => {
    expect(decomposeRequiredClaims([]).size).toBe(0);
  });
});

describe("required-claim completeness — quantifies over the REQUIRED set (SDD §O#15)", () => {
  const required = decomposeRequiredClaims(["PICKUP_Q"]); // {STORE_OPEN_NOW, ORDER_FULFILLMENT_STAGE}
  const resolved = (
    entries: ReadonlyArray<[RegistryClaimType, ClaimVerdict]>,
  ): ReadonlyMap<string, ClaimVerdict> => new Map(entries);

  it("COMPLETE only when EVERY required type is VALIDATED", () => {
    const r = checkRequiredClaimCompleteness(
      required,
      resolved([
        ["STORE_OPEN_NOW", "VALIDATED"],
        ["ORDER_FULFILLMENT_STAGE", "VALIDATED"],
      ]),
    );
    expect(r.complete).toBe(true);
    expect(r.unsatisfied).toEqual([]);
  });

  it("an ABSENT required companion DEGRADES (the 'render the easy half' hole)", () => {
    // The planner validated only STORE_OPEN_NOW and never produced the order stage.
    const r = checkRequiredClaimCompleteness(
      required,
      resolved([["STORE_OPEN_NOW", "VALIDATED"]]),
    );
    expect(r.complete).toBe(false);
    expect(r.unsatisfied).toEqual(["ORDER_FULFILLMENT_STAGE"]);
  });

  it("a required companion resolving UNKNOWN or REFUSED DEGRADES", () => {
    const unknownCase = checkRequiredClaimCompleteness(
      required,
      resolved([
        ["STORE_OPEN_NOW", "VALIDATED"],
        ["ORDER_FULFILLMENT_STAGE", "UNKNOWN"],
      ]),
    );
    expect(unknownCase.complete).toBe(false);
    const refusedCase = checkRequiredClaimCompleteness(
      required,
      resolved([
        ["STORE_OPEN_NOW", "REFUSED"],
        ["ORDER_FULFILLMENT_STAGE", "VALIDATED"],
      ]),
    );
    expect(refusedCase.complete).toBe(false);
    expect(refusedCase.unsatisfied).toEqual(["STORE_OPEN_NOW"]);
  });

  it("an EMPTY required set is trivially complete (nothing to render incompletely)", () => {
    const r = checkRequiredClaimCompleteness(new Set(), new Map());
    expect(r.complete).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F2 — the polysemous "status" must route by its DISCRIMINATOR (payment vs order),
// not unconditionally to ORDER. NON-VACUOUS: with the old `/pedido|cad[êe]|status/`
// → ORDER_STATUS_Q rule, "status do meu pagamento" wrongly carried ORDER_STATUS_Q.
// ─────────────────────────────────────────────────────────────────────────────
describe("classifyRequestSpans — F2 'status' polysemy disambiguation (§O#8/§O#15)", () => {
  it("'qual o status do meu pagamento?' → PAYMENT_STATUS_Q (NOT misrouted to ORDER)", () => {
    const spans = classifyRequestSpans("qual o status do meu pagamento?");
    expect(spans).toContain("PAYMENT_STATUS_Q");
    expect(spans).not.toContain("ORDER_STATUS_Q");
    // …and it decomposes to PAYMENT_STATUS, never ORDER_FULFILLMENT_STAGE.
    const required = decomposeRequiredClaims(spans);
    expect(required.has("PAYMENT_STATUS")).toBe(true);
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(false);
  });

  it("'qual o status do meu pedido?' → ORDER_STATUS_Q (NOT payment)", () => {
    const spans = classifyRequestSpans("qual o status do meu pedido?");
    expect(spans).toContain("ORDER_STATUS_Q");
    expect(spans).not.toContain("PAYMENT_STATUS_Q");
    const required = decomposeRequiredClaims(spans);
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
    expect(required.has("PAYMENT_STATUS")).toBe(false);
  });

  it("a BARE 'status' with no discriminator → BOTH companions (conservative over-decompose)", () => {
    const spans = classifyRequestSpans("qual o status?");
    expect(spans).toContain("ORDER_STATUS_Q");
    expect(spans).toContain("PAYMENT_STATUS_Q");
    const required = decomposeRequiredClaims(spans);
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
    expect(required.has("PAYMENT_STATUS")).toBe(true);
  });

  it("payment phrasing variants (pix / cobrança / pagar) route to PAYMENT_STATUS_Q", () => {
    for (const text of [
      "já caiu meu pix?",
      "qual o valor da cobrança?",
      "como faço para pagar?",
    ]) {
      expect(classifyRequestSpans(text)).toContain("PAYMENT_STATUS_Q");
    }
  });

  it("order/delivery phrasing (entrega / chegou / preparo) routes to ORDER_STATUS_Q", () => {
    for (const text of [
      "cadê minha entrega?",
      "meu pedido já chegou?",
      "ainda está em preparo?",
    ]) {
      expect(classifyRequestSpans(text)).toContain("ORDER_STATUS_Q");
    }
  });

  it("a payment+order compound 'status do pedido e do pagamento' keeps BOTH (over-include)", () => {
    const spans = classifyRequestSpans("qual o status do pedido e do pagamento?");
    expect(spans).toContain("ORDER_STATUS_Q");
    expect(spans).toContain("PAYMENT_STATUS_Q");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #8 — OWNERSHIP-AWARE required companions. A companion about a resource the
// customer PROVABLY does not own (an active order / active payment) is DROPPED, so
// it can no longer degrade a legitimately-VALIDATED answer. Gate fires ONLY on a
// positive first-party `false`; undefined ownership / a `true` flag preserves the
// pre-#8 over-including behavior byte-for-byte (demote-only under doubt).
// ─────────────────────────────────────────────────────────────────────────────
describe("required-claim decomposer — #8 ownership-aware companions", () => {
  const GUEST_OWNS_NOTHING: ActiveResourceOwnership = {
    hasActiveOrder: false,
    hasActivePayment: false,
  };

  it("#8a a GUEST's pickup-phrased hours question requires STORE_OPEN_NOW ONLY (no forced ORDER companion → not degraded)", () => {
    // "posso pegar uma marmita aí agora?" — a guest with no order. The pickup
    // marker classifies PICKUP_Q, whose closure forces {STORE_OPEN_NOW,
    // ORDER_FULFILLMENT_STAGE}. Before #8 the forced ORDER companion resolved
    // ABSENT and degraded the VALIDATED store-hours answer to UNKNOWN.
    const spans = classifyRequestSpans("posso pegar uma marmita aí agora?");
    expect(spans).toContain("PICKUP_Q");

    const required = decomposeRequiredClaims(spans, GUEST_OWNS_NOTHING);
    expect(required.has("STORE_OPEN_NOW")).toBe(true); // public config — never gated.
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(false); // guest owns no order.
    expect([...required]).toEqual(["STORE_OPEN_NOW"]);

    // …and with the store-hours claim VALIDATED the turn is NOT degraded.
    const completeness = checkRequiredClaimCompleteness(
      required,
      new Map([["STORE_OPEN_NOW", "VALIDATED"]]),
    );
    expect(completeness.complete).toBe(true);
  });

  it("#8b a bare 'status' from a customer with NO active payment requires ORDER only (no forced PAYMENT companion → not degraded)", () => {
    // Customer HAS an active order but NO active payment row. Bare "status"
    // over-includes both ORDER_STATUS_Q + PAYMENT_STATUS_Q; before #8 the forced
    // PAYMENT companion resolved ABSENT and degraded the order-status answer.
    const spans = classifyRequestSpans("qual o status?");
    const ownership: ActiveResourceOwnership = {
      hasActiveOrder: true,
      hasActivePayment: false,
    };

    const required = decomposeRequiredClaims(spans, ownership);
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
    expect(required.has("PAYMENT_STATUS")).toBe(false); // no active payment → not forced.

    const completeness = checkRequiredClaimCompleteness(
      required,
      new Map([["ORDER_FULFILLMENT_STAGE", "VALIDATED"]]),
    );
    expect(completeness.complete).toBe(true);
  });

  it("keeps a gated companion when the customer DOES own the resource (over-include preserved)", () => {
    // An authenticated customer WITH an active order asking a pickup question
    // legitimately needs BOTH the store-open and the order-stage companion.
    const spans = classifyRequestSpans("posso pegar meu pedido agora?");
    const required = decomposeRequiredClaims(spans, {
      hasActiveOrder: true,
      hasActivePayment: false,
    });
    expect(required.has("STORE_OPEN_NOW")).toBe(true);
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
  });

  it("STORE_OPEN_NOW is NEVER ownership-gated (public config, owned by nobody)", () => {
    const required = decomposeRequiredClaims(
      ["STORE_OPEN_NOW_Q"],
      GUEST_OWNS_NOTHING,
    );
    expect([...required]).toEqual(["STORE_OPEN_NOW"]);
  });

  it("OMITTED ownership is byte-identical to the pre-#8 over-including decomposer", () => {
    // No signal threaded → nothing dropped → the full conservative union stands.
    expect([...decomposeRequiredClaims(["PICKUP_Q"])]).toEqual([
      "STORE_OPEN_NOW",
      "ORDER_FULFILLMENT_STAGE",
    ]);
    const bare = decomposeRequiredClaims(classifyRequestSpans("qual o status?"));
    expect(bare.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
    expect(bare.has("PAYMENT_STATUS")).toBe(true);
  });

  it("drops ONLY the companion whose flag is a positive false (independent gating)", () => {
    // hasActiveOrder true, hasActivePayment false → ORDER kept, PAYMENT dropped.
    const spans = classifyRequestSpans("qual o status?");
    const onlyOrder = decomposeRequiredClaims(spans, {
      hasActiveOrder: true,
      hasActivePayment: false,
    });
    expect(onlyOrder.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
    expect(onlyOrder.has("PAYMENT_STATUS")).toBe(false);
    // …and the mirror case.
    const onlyPayment = decomposeRequiredClaims(spans, {
      hasActiveOrder: false,
      hasActivePayment: true,
    });
    expect(onlyPayment.has("ORDER_FULFILLMENT_STAGE")).toBe(false);
    expect(onlyPayment.has("PAYMENT_STATUS")).toBe(true);
  });
});
