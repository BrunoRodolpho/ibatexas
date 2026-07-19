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
  detectMedicalEmergencyMarkers,
  isAllergenFamilyAsk,
  isMedicalEmergencyAsk,
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
// BKL-152-EDGE — EXACT weekday==today suppression (@claustrum/core 0.8.0
// `resolvedQueryDate` carrier / `DateAnchorSignal`). The pure #301 rule above
// suppresses STORE_OPEN_NOW for ANY date-anchored hours question — including a
// named weekday that resolves to TODAY, where the open-now companion IS relevant.
// When the carrier seam is ACTIVE the decomposer reads the clock-resolved date:
// SUPPRESS only for a CONFIRMED NON-TODAY day (resolvedQueryDate PRESENT); KEEP when
// the resolved day is TODAY (resolvedQueryDate ABSENT under an active seam). Seam
// INACTIVE (or no dateAnchor arg at all) → the pure #301 rule, byte-identical.
// ─────────────────────────────────────────────────────────────────────────────
describe("required-claim decomposer — BKL-152-edge exact date-anchor (0.8.0 carrier)", () => {
  const dateSpans = ["STORE_OPEN_NOW_Q", "STORE_HOURS_FOR_DATE_Q"] as const;

  it("seam ACTIVE + resolvedQueryDate PRESENT (confirmed non-today) → SUPPRESS STORE_OPEN_NOW", () => {
    const required = decomposeRequiredClaims([...dateSpans], undefined, {
      seamActive: true,
      resolvedQueryDate: "2026-07-25",
    });
    expect([...required]).toEqual(["STORE_HOURS_FOR_DATE"]);
    expect(required.has("STORE_OPEN_NOW")).toBe(false);
  });

  it("seam ACTIVE + resolvedQueryDate ABSENT (weekday==today) → KEEP STORE_OPEN_NOW", () => {
    const required = decomposeRequiredClaims([...dateSpans], undefined, {
      seamActive: true,
    });
    expect(required.has("STORE_OPEN_NOW")).toBe(true);
    expect(required.has("STORE_HOURS_FOR_DATE")).toBe(true);
  });

  it("seam INACTIVE ({seamActive:false}) → pure #301 SUPPRESS (byte-identical fallback)", () => {
    expect([
      ...decomposeRequiredClaims([...dateSpans], undefined, { seamActive: false }),
    ]).toEqual(["STORE_HOURS_FOR_DATE"]);
  });

  it("no dateAnchor arg (1-arg call) → pure #301 SUPPRESS (existing callers unchanged)", () => {
    expect([...decomposeRequiredClaims([...dateSpans])]).toEqual([
      "STORE_HOURS_FOR_DATE",
    ]);
  });

  it("PICKUP wins over the date suppression regardless of the seam (today OR non-today)", () => {
    const today = decomposeRequiredClaims(["PICKUP_Q", ...dateSpans], undefined, {
      seamActive: true,
    });
    const nonToday = decomposeRequiredClaims(["PICKUP_Q", ...dateSpans], undefined, {
      seamActive: true,
      resolvedQueryDate: "2026-07-25",
    });
    expect(today.has("STORE_OPEN_NOW")).toBe(true);
    expect(nonToday.has("STORE_OPEN_NOW")).toBe(true);
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

  it("'o que tem no meu carrinho?' → CART_CONTENTS_Q → requires the complementary pair (BKL-163)", () => {
    const spans = classifyRequestSpans("o que tem no meu carrinho?");
    expect(spans).toContain("CART_CONTENTS_Q");
    const required = decomposeRequiredClaims(spans);
    // BKL-163 — the row requires BOTH complements: exactly one can validate per
    // turn (their evidence keys are presence-complementary), so requiring both is
    // what lets an empty cart render the friendly VALIDATED "vazio" instead of the
    // honest-UNKNOWN degrade — never a contradiction.
    expect([...required].sort()).toEqual(["CART_CONTENTS", "CART_EMPTY"]);
  });

  it("BKL-136 — store-location/parking questions → STORE_INFO_Q → requires STORE_INFO", () => {
    for (const text of [
      "onde fica o restaurante?",
      "qual o endereço de vocês?",
      "tem estacionamento?",
      "posso estacionar aí?",
      "como chego até vocês?",
      "qual a localização?",
    ]) {
      const spans = classifyRequestSpans(text);
      expect(spans, text).toContain("STORE_INFO_Q");
      expect([...decomposeRequiredClaims(spans)], text).toContain("STORE_INFO");
    }
  });

  it("BKL-136 — MUST-NOT-FIRE when the location word targets a RESOURCE, not the store", () => {
    // "onde fica meu PEDIDO" is an order-status ask — a VALIDATED store address
    // there would be a confident non-answer to a different question.
    for (const text of [
      "onde fica meu pedido?",
      "qual o endereço de entrega do meu pedido?",
      "onde está minha reserva?",
      "endereço de cobrança do pagamento",
    ]) {
      expect(classifyRequestSpans(text), text).not.toContain("STORE_INFO_Q");
    }
  });

  it("MUST-NOT-FIRE on cart MUTATIONS (the read-vs-write split — BKL-153 + BKL-201)", () => {
    for (const text of [
      "adicione uma coca ao carrinho",
      "acrescenta um refri no carrinho",
      "remova a farofa do carrinho",
      "coloca mais uma costela no carrinho",
      "limpa o carrinho",
      "esvazia minha sacola",
      "troca o item do carrinho",
      // BKL-201 — live-caught (SCN-046): "tira"/"muda" leaked through the old net
      // (which lacked tir/mud), so the removal/change rendered the cart list and the
      // mutation was silently dropped.
      "tira o refrigerante do carrinho",
      "tira a coca da minha sacola",
      "muda pra 2 refrigerantes no carrinho",
      "diminui a quantidade no carrinho",
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

// BKL-201 — imperative MUTATION verbs must not let a write turn ride a classify-only
// READ span. #348 made the MENU family + STORE_INFO classify-only-eligible, so the same
// read-vs-mutation split the cart span enforces now guards the menu/store spans: a write
// ("muda o preço", "tira do cardápio") must reach the model/mutation path, never render
// the read and silently drop the mutation.
describe("classifyRequestSpans — BKL-201 imperative mutations suppress classify-only READ spans", () => {
  it("MUST-NOT-FIRE the menu/store read spans on an imperative mutation", () => {
    const cases: Array<[string, string]> = [
      ["muda o preço do brisket", "MENU_ITEM_PRICE_Q"],
      ["aumenta o preço do combo", "MENU_ITEM_PRICE_Q"],
      ["diminui o valor da costela", "MENU_ITEM_PRICE_Q"],
      ["tira o brisket do cardápio", "MENU_OVERVIEW_Q"],
      ["remove a costela do menu", "MENU_OVERVIEW_Q"],
      ["muda o endereço do restaurante", "STORE_INFO_Q"],
    ];
    for (const [text, span] of cases) {
      expect(classifyRequestSpans(text), text).not.toContain(span);
    }
  });

  it("STILL-FIRES the menu/store read spans on READ imperatives (mostra/ver) and interrogatives", () => {
    // A READ imperative ("me mostra", "quero ver") is NOT a mutation — the split must
    // key off mutation verbs only, never suppress a legitimate read.
    expect(classifyRequestSpans("me mostra o cardápio"), "mostra").toContain(
      "MENU_OVERVIEW_Q",
    );
    expect(classifyRequestSpans("quanto custa o brisket"), "price read").toContain(
      "MENU_ITEM_PRICE_Q",
    );
    expect(classifyRequestSpans("onde fica o restaurante?"), "store read").toContain(
      "STORE_INFO_Q",
    );
  });

  it("word-boundary anchored — 'tir'/'mud' never false-match inside innocent words", () => {
    // "retirar" (pickup), "partir", "sentir" contain 'tir' mid-word; none is a cart
    // mutation, so a cart READ that co-occurs with them must still fire.
    expect(
      classifyRequestSpans("quero ver o carrinho antes de partir"),
      "partir",
    ).toContain("CART_CONTENTS_Q");
  });
});

// FE-D03 slice C — ORDER_HISTORY_Q / PAYMENT_HISTORY_Q: history/list phrasing fires the
// list span and SUPPRESSES the co-fired singular status span (a history ask is not a
// single-subject status ask — the list type replaces the ≥2-owned CLARIFY). The singular
// family stays untouched on singular phrasing (both directions pinned).
describe("classifyRequestSpans — FE-D03 history spans (suppress the singular)", () => {
  it("MUST-FIRE ORDER_HISTORY_Q on history/plural order phrasing", () => {
    for (const text of [
      "meu histórico de pedidos",
      "quero ver o histórico dos meus pedidos",
      "meus últimos pedidos",
      "me mostra todos os meus pedidos",
    ]) {
      expect(classifyRequestSpans(text), text).toContain("ORDER_HISTORY_Q");
    }
  });

  it("MUST-FIRE PAYMENT_HISTORY_Q on history/plural payment phrasing", () => {
    for (const text of [
      "meu histórico de pagamentos",
      "meus últimos pagamentos",
      "histórico de pagamentos por favor",
    ]) {
      expect(classifyRequestSpans(text), text).toContain("PAYMENT_HISTORY_Q");
    }
  });

  it("SUPPRESSES the singular: 'meus pedidos' → ORDER_HISTORY_Q, NOT ORDER_STATUS_Q", () => {
    const spans = classifyRequestSpans("meus pedidos");
    expect(spans).toContain("ORDER_HISTORY_Q");
    expect(spans).not.toContain("ORDER_STATUS_Q");
    expect([...decomposeRequiredClaims(spans)]).toEqual(["ORDER_HISTORY"]);
  });

  it("SUPPRESSES the singular: 'meus pagamentos' → PAYMENT_HISTORY_Q, NOT PAYMENT_STATUS_Q", () => {
    const spans = classifyRequestSpans("meus pagamentos");
    expect(spans).toContain("PAYMENT_HISTORY_Q");
    expect(spans).not.toContain("PAYMENT_STATUS_Q");
    expect([...decomposeRequiredClaims(spans)]).toEqual(["PAYMENT_HISTORY"]);
  });

  it("MUST-NOT-FIRE on singular status asks (the singular family stays)", () => {
    const order = classifyRequestSpans("cadê meu pedido?");
    expect(order).toContain("ORDER_STATUS_Q");
    expect(order).not.toContain("ORDER_HISTORY_Q");
    const payment = classifyRequestSpans("meu pagamento foi aprovado?");
    expect(payment).toContain("PAYMENT_STATUS_Q");
    expect(payment).not.toContain("PAYMENT_HISTORY_Q");
  });
});

describe("classifyRequestSpans — BKL-204 capability questions don't force the owner read", () => {
  it("delivery COVERAGE questions do NOT fire ORDER_STATUS_Q (capability, not the customer's order)", () => {
    for (const text of [
      "vocês entregam no CEP 13560-000?",
      "fazem entrega no centro?",
      "entregam na minha região?",
      "vocês entregam pra Ibaté?",
    ]) {
      expect(classifyRequestSpans(text), text).not.toContain("ORDER_STATUS_Q");
    }
  });

  it("delivery FEE questions do NOT fire ORDER_STATUS_Q", () => {
    for (const text of [
      "quanto custa a entrega?",
      "quanto fica a entrega pro centro?",
      "qual o valor da entrega?",
      "qual a taxa de entrega?",
    ]) {
      expect(classifyRequestSpans(text), text).not.toContain("ORDER_STATUS_Q");
    }
  });

  it("payment-method ACCEPTANCE questions do NOT fire PAYMENT_STATUS_Q", () => {
    for (const text of [
      "aceitam vale-refeição? e PIX parcelado?",
      "aceitam pix?",
      "quais as formas de pagamento?",
      "vocês aceitam cartão de crédito?",
    ]) {
      expect(classifyRequestSpans(text), text).not.toContain("PAYMENT_STATUS_Q");
    }
  });

  it("GENUINE self-status asks STILL fire (the possessive / order-number self-reference)", () => {
    // A possessive keeps the DUAL tokens firing…
    expect(classifyRequestSpans("cadê minha entrega?")).toContain("ORDER_STATUS_Q");
    expect(classifyRequestSpans("a entrega do meu pedido saiu?")).toContain(
      "ORDER_STATUS_Q",
    );
    expect(classifyRequestSpans("paguei no pix, meu pagamento caiu?")).toContain(
      "PAYMENT_STATUS_Q",
    );
    // …and an explicit order number is a self-reference (BKL-203's own case).
    expect(classifyRequestSpans("status do pedido 933869?")).toContain(
      "ORDER_STATUS_Q",
    );
  });

  it("STRONG tokens fire regardless of a capability-shaped tail (a named order wins)", () => {
    // "meu pedido" (possessive) never reads as a capability question.
    expect(classifyRequestSpans("cadê meu pedido, vocês entregam rápido?")).toContain(
      "ORDER_STATUS_Q",
    );
  });
});

describe("classifyRequestSpans — BKL-206 order/payment MUTATION imperatives don't ride the status reads", () => {
  it("'cancela meu pedido' (imperative) does NOT fire ORDER_STATUS_Q → routes to the mutation path", () => {
    const spans = classifyRequestSpans("cancela meu pedido");
    expect(spans).not.toContain("ORDER_STATUS_Q");
    expect(spans).not.toContain("PAYMENT_STATUS_Q");
  });

  it("'cancela o pedido 933869' (imperative + named order) still routes to mutation, not status", () => {
    expect(classifyRequestSpans("cancela o pedido 933869")).not.toContain(
      "ORDER_STATUS_Q",
    );
  });

  it("an amend imperative on a placed order does NOT read status ('muda meu pedido pra entrega')", () => {
    expect(classifyRequestSpans("muda meu pedido pra entrega")).not.toContain(
      "ORDER_STATUS_Q",
    );
  });

  it("'como cancelo meu pedido?' (interrogative how-to) routes to the model path (gets help), not a status read", () => {
    // The how-to question is not a status ask; suppressing the read routes it to
    // the model, which answers "how do I cancel" — it is not dead-ended.
    const spans = classifyRequestSpans("como cancelo meu pedido?");
    expect(spans).not.toContain("ORDER_STATUS_Q");
  });

  it("a GENUINE status ask still fires (no mutation verb) — the fix is surgical", () => {
    expect(classifyRequestSpans("cadê meu pedido?")).toContain("ORDER_STATUS_Q");
    expect(classifyRequestSpans("status do pedido 933869?")).toContain(
      "ORDER_STATUS_Q",
    );
    expect(classifyRequestSpans("meu pagamento foi aprovado?")).toContain(
      "PAYMENT_STATUS_Q",
    );
  });

  it("a bare 'status' with a cancel imperative does NOT fire the status fallback", () => {
    // "cancela o status atual" — a mutation must not ride the bare-"status" over-include.
    expect(classifyRequestSpans("cancela o status atual do pedido")).not.toContain(
      "ORDER_STATUS_Q",
    );
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
// BKL-163 (reopened) — the CART presence-complement pair. The CART_CONTENTS_Q
// closure row requires BOTH members, but by construction exactly ONE can ever
// VALIDATE (complementary `cart_contents:`/`cart_empty:` evidence off the SAME
// read). The strict every-type rule made cart completeness structurally
// unsatisfiable — every cart turn (empty OR full) degraded RENDER→UNKNOWN (the
// live SCN-030 non-render). A pair member's requirement is satisfied by its
// PARTNER validating; non-pair types keep the strict rule (last test pins it).
// ─────────────────────────────────────────────────────────────────────────────
describe("required-claim completeness — presence-complement pair (BKL-163)", () => {
  const cartRequired = decomposeRequiredClaims(["CART_CONTENTS_Q"]); // {CART_CONTENTS, CART_EMPTY}
  const resolved = (
    entries: ReadonlyArray<[RegistryClaimType, ClaimVerdict]>,
  ): ReadonlyMap<string, ClaimVerdict> => new Map(entries);

  it("the closure row really does require the whole pair (the precondition)", () => {
    expect(cartRequired.has("CART_CONTENTS")).toBe(true);
    expect(cartRequired.has("CART_EMPTY")).toBe(true);
  });

  it("EMPTY cart: CART_EMPTY VALIDATED alone satisfies the pair (the SCN-030 turn renders)", () => {
    // The partner resolved UNKNOWN (its cart_contents evidence is ABSENT on an
    // empty cart) — the exact live trace that degraded before this fix.
    const r = checkRequiredClaimCompleteness(
      cartRequired,
      resolved([
        ["CART_EMPTY", "VALIDATED"],
        ["CART_CONTENTS", "UNKNOWN"],
      ]),
    );
    expect(r.complete).toBe(true);
    expect(r.unsatisfied).toEqual([]);
  });

  it("FULL cart: CART_CONTENTS VALIDATED alone satisfies the pair (the with-items regression)", () => {
    const r = checkRequiredClaimCompleteness(
      cartRequired,
      resolved([["CART_CONTENTS", "VALIDATED"]]),
    );
    expect(r.complete).toBe(true);
    expect(r.unsatisfied).toEqual([]);
  });

  it("NEITHER member VALIDATED still DEGRADES (an unavailable/failed cart read stays honest)", () => {
    const r = checkRequiredClaimCompleteness(
      cartRequired,
      resolved([["CART_CONTENTS", "UNKNOWN"]]),
    );
    expect(r.complete).toBe(false);
    expect(r.unsatisfied).toEqual(["CART_CONTENTS", "CART_EMPTY"]);
  });

  it("NON-pair companions keep the strict rule (no accidental widening of §O#15)", () => {
    // The PICKUP_Q pair {STORE_OPEN_NOW, ORDER_FULFILLMENT_STAGE} is NOT a
    // presence-complement pair: one validating must NOT satisfy the other.
    const r = checkRequiredClaimCompleteness(
      decomposeRequiredClaims(["PICKUP_Q"]),
      resolved([["STORE_OPEN_NOW", "VALIDATED"]]),
    );
    expect(r.complete).toBe(false);
    expect(r.unsatisfied).toEqual(["ORDER_FULFILLMENT_STAGE"]);
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


describe("BKL-209 — deterministic medical-EMERGENCY net (§O#9 safety)", () => {
  const EMERGENCIES = [
    "estou tendo uma reação alérgica",
    "acho que é uma reação alérgica ao amendoim, minha garganta está fechando",
    "não consigo respirar",
    "to passando mal depois de comer aqui",
    "minha língua está inchando",
    "socorro, acho que é anafilaxia",
    "preciso de uma ambulância",
    "estou com falta de ar e o rosto inchou",
    "engasguei e não consigo respirar direito",
  ];
  for (const text of EMERGENCIES) {
    it(`fires on distress phrasing: "${text}"`, () => {
      expect(isMedicalEmergencyAsk(text)).toBe(true);
      expect(detectMedicalEmergencyMarkers(text)).toEqual(["medical-emergency"]);
    });
  }

  // The BOUNDARY: allergen-INFO questions must NOT fire the emergency net — they
  // keep the BKL-184 conservative abstain+offer path. A missed emergency is the
  // only unsafe direction, but over-firing on plain info questions would degrade
  // every allergen question to an emergency escalate.
  const INFO_NOT_EMERGENCY = [
    "tem amendoim?",
    "o brownie tem leite?",
    "sou alérgico a lactose, tem no cardápio algo sem?",
    "quais pratos são sem glúten?",
    "tem nozes nesse doce?",
  ];
  for (const text of INFO_NOT_EMERGENCY) {
    it(`does NOT fire on allergen-INFO: "${text}"`, () => {
      expect(isMedicalEmergencyAsk(text)).toBe(false);
      expect(detectMedicalEmergencyMarkers(text)).toEqual([]);
      // …and the allergen-info net still routes it to the BKL-184 path.
      expect(isAllergenFamilyAsk(text)).toBe(true);
    });
  }

  it("an ordinary non-safety request fires neither net", () => {
    expect(isMedicalEmergencyAsk("qual o horário de domingo?")).toBe(false);
    expect(detectMedicalEmergencyMarkers("qual o horário de domingo?")).toEqual([]);
  });
});
