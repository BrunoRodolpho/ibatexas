// claims-labels.ts — PRESENTATION-ONLY pt-BR enum localization for the renderer
// (Plan 1 Track-A / F3; Hard Rule #4 "user-facing text: pt-BR only").
//
// THE PROBLEM this closes: a VALIDATED claim's value is the RAW LEDGER ENUM
// (`paid` / `closed` / `preparing` / `lunch` / `dinner` …). The kernel's C6
// value-binding proves that bound value equal to the licensing ledger entry, so
// the value MUST stay the raw enum — localizing the BOUND value would make C6's
// claimSide !== evidenceSide and demote the claim to UNKNOWN. The renderer,
// however, must speak pt-BR (Hard Rule #4). Before this map the renderer emitted
// the raw English enum straight to the customer ("…é: paid.", "…: closed.").
//
// THE FIX: localize ONLY the DISPLAYED string, at the render seam, AFTER C6 has
// already validated the claim. The claim's `value` is never touched — this is a
// pure display transform keyed by `(claimType, field)` so the same enum string
// can localize differently per slot. An UNMAPPED enum falls back SAFE to the raw
// value (never crash, never fabricate a fact, never block a valid render).
//
// PURE & self-contained: no clock / RNG / IO, no model import. This module is on
// the renderer's import path, which the §O#3 "no model prose" guard scans — it
// contains only static lookup tables + a pure function.

/**
 * Per-`(claimType, field)` enum → pt-BR DISPLAY map. The key is `${claimType}.${field}`
 * (the exact 1:1 proposition binding the slot grammar reads). Values are the
 * accented pt-BR display strings (Hard Rule #4). This is a DISPLAY map only — it
 * never participates in C6 value-binding (which compares the raw bound value).
 *
 * SCOPE (SDD §Q scope guard): the Trustworthiness-Triad slice (PAYMENT_STATUS,
 * STORE_OPEN_NOW, ORDER_FULFILLMENT_STAGE, RESERVATION_STATUS — FE-T17). The map is
 * EXHAUSTIVE over each read's REAL enum domain — the exact members the
 * INVESTIGATE-stage reads can emit:
 *   - PAYMENT_STATUS.status              → every `PaymentStatus` member
 *                                          (@ibatexas/types · packages/domain/prisma)
 *   - ORDER_FULFILLMENT_STAGE.fulfillmentStatus
 *                                        → every `OrderFulfillmentStatus` member
 *   - RESERVATION_STATUS.status          → every `ReservationStatus` member
 *                                          (@ibatexas/types · packages/domain/prisma)
 *   - STORE_OPEN_NOW.mealPeriod          → every `ScheduleSignal["mealPeriod"]`
 *                                          member ("lunch" | "dinner" | "closed")
 * so NO status the read can produce ever reaches the customer in raw English. The
 * exhaustiveness is pinned by the coverage test (claims-labels.test.ts), which
 * iterates the authoritative enum sources and FAILS on any unmapped member. The
 * safe fallback below still degrades a genuinely-unknown value to the raw string
 * (never crash, never block a render) — it is a backstop, not a substitute for the
 * map being complete.
 */
export const CLAIM_ENUM_DISPLAY_PT_BR: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  // PAYMENT_STATUS.status — the full Payment lifecycle enum (raw ledger values,
  // i.e. the Prisma `PaymentStatus` member name; `canceled`, not the @map column
  // value `pay_canceled`). EXHAUSTIVE over PaymentStatus (12 members).
  "PAYMENT_STATUS.status": {
    awaiting_payment: "aguardando pagamento",
    payment_pending: "pagamento pendente",
    payment_expired: "pagamento expirado",
    payment_failed: "pagamento falhou",
    cash_pending: "pagamento em dinheiro pendente",
    paid: "pago",
    switching_method: "trocando forma de pagamento",
    partially_refunded: "parcialmente reembolsado",
    refunded: "reembolsado",
    disputed: "em disputa",
    canceled: "cancelado",
    waived: "isento",
  },
  // STORE_OPEN_NOW.mealPeriod — the deterministic meal-period / open-state signal.
  // EXHAUSTIVE over ScheduleSignal["mealPeriod"] ("lunch" | "dinner" | "closed").
  "STORE_OPEN_NOW.mealPeriod": {
    lunch: "almoço",
    dinner: "jantar",
    closed: "fechado",
  },
  // ORDER_FULFILLMENT_STAGE.fulfillmentStatus — the order fulfillment-stage enum
  // (Prisma `OrderFulfillmentStatus` member name). EXHAUSTIVE over the 7 members.
  "ORDER_FULFILLMENT_STAGE.fulfillmentStatus": {
    pending: "pendente",
    confirmed: "confirmado",
    preparing: "em preparo",
    ready: "pronto",
    in_delivery: "saiu para entrega",
    delivered: "entregue",
    canceled: "cancelado",
  },
  // RESERVATION_STATUS.status — the reservation-status enum (Prisma
  // `ReservationStatus` member name, @ibatexas/types). EXHAUSTIVE over the 6
  // members (FE-T17).
  "RESERVATION_STATUS.status": {
    pending: "pendente",
    confirmed: "confirmada",
    seated: "sentados",
    completed: "concluída",
    cancelled: "cancelada",
    no_show: "não compareceu",
  },
};

/**
 * Localize ONE displayed enum value to pt-BR for a given `(claimType, field)`.
 * PRESENTATION-ONLY: the caller passes the raw bound value (already C6-validated);
 * this returns the pt-BR DISPLAY string. An unmapped `(claimType, field)` or an
 * unmapped enum member degrades SAFE to `raw` — never crashes, never fabricates,
 * never blocks a valid render. Pure: same inputs ⟹ same output.
 */
export function localizeClaimEnum(
  claimType: string,
  field: string,
  raw: string,
): string {
  const map = CLAIM_ENUM_DISPLAY_PT_BR[`${claimType}.${field}`];
  // SAFE fallback chain: unmapped slot → raw; unmapped member → raw.
  return map?.[raw] ?? raw;
}
