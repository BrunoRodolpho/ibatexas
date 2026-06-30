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
 * STORE_OPEN_NOW, ORDER_FULFILLMENT_STAGE). Extra ledger enum members are mapped
 * defensively so a status the ledger can emit never reaches the customer in raw
 * English; any still-unmapped member degrades SAFE to the raw value.
 */
export const CLAIM_ENUM_DISPLAY_PT_BR: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  // PAYMENT_STATUS.status — the PIX/payment lifecycle enum (raw ledger values).
  "PAYMENT_STATUS.status": {
    paid: "pago",
    pending: "pendente",
    failed: "falhou",
    refunded: "reembolsado",
    processing: "em processamento",
    canceled: "cancelado",
    cancelled: "cancelado",
    expired: "expirado",
    authorized: "autorizado",
    awaiting: "aguardando",
  },
  // STORE_OPEN_NOW.mealPeriod — the override-aware meal-period / open-state enum.
  "STORE_OPEN_NOW.mealPeriod": {
    lunch: "almoço",
    dinner: "jantar",
    breakfast: "café da manhã",
    closed: "fechado",
    open: "aberto",
  },
  // ORDER_FULFILLMENT_STAGE.fulfillmentStatus — the order fulfillment-stage enum.
  "ORDER_FULFILLMENT_STAGE.fulfillmentStatus": {
    preparing: "em preparo",
    ready: "pronto",
    delivered: "entregue",
    out_for_delivery: "saiu para entrega",
    pending: "pendente",
    fulfilled: "concluído",
    canceled: "cancelado",
    cancelled: "cancelado",
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
