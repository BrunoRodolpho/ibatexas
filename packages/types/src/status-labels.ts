// status-labels.ts — the SINGLE SOURCE for every pt-BR status label (BKL-016).
//
// THE DEFECT this closes: the same status enum was localized to pt-BR in THREE
// places (this package's Title-Case maps consumed by the staff/admin surfaces,
// `apps/api/.../claims-labels.ts`'s sentence-voice maps consumed by the customer
// claims renderer, and `packages/ui/.../admin-labels.ts`'s own copy) that drifted
// out of sync — uncontrolled divergence, not the existence of two voices.
//
// THE FIX: two named REGISTERS per enum family, colocated here, both owned by this
// module. Staff Title-Case badges ("Preparando") and customer sentence-voice
// ("em preparo") are BOTH correct for their audiences — so we keep both, but as a
// single deliberate, colocated fact:
//
//   - STAFF register    — Title Case, the badge/label voice. Exported under the
//                         EXISTING names (ORDER_STATUS_LABELS_PT / …) so every live
//                         consumer sees byte-identical strings.
//   - CUSTOMER register — sentence-voice, the claims renderer's voice. The
//                         customer copy is live-calibrated against the model; it is
//                         NEVER churned here (claims-labels.ts re-derives from it).
//   - ADMIN extension   — the non-core keys the admin UI additionally needs
//                         (legacy Medusa statuses, order aggregate states). Keyed by
//                         values DISJOINT from the core enums.
//
// THE TEETH: `__tests__/status-labels.test.ts` pins that BOTH registers cover the
// IDENTICAL, COMPLETE enum key-set per family, and that the admin extension keys are
// disjoint from the core enum values — so a future edit that adds a status to one
// voice but not the other, or that lets an extension key shadow a core key, fails at
// CI. Divergence-by-drift becomes structurally impossible; a cross-register wording
// difference becomes a deliberate, reviewed fact.

import { FiscalStatus } from "./fiscal-status.js"
import { OrderFulfillmentStatus } from "./order-status.js"
import { PaymentStatus } from "./payment-status.js"
import { ReservationStatus } from "./reservation.types.js"

// ── STAFF register (Title Case — the badge/label voice) ─────────────────────────

/** pt-BR STAFF (Title Case) display labels for each order fulfillment status. */
export const ORDER_STATUS_LABELS_PT: Record<OrderFulfillmentStatus, string> = {
  [OrderFulfillmentStatus.PENDING]: "Pendente",
  [OrderFulfillmentStatus.CONFIRMED]: "Confirmado",
  [OrderFulfillmentStatus.PREPARING]: "Preparando",
  [OrderFulfillmentStatus.READY]: "Pronto",
  [OrderFulfillmentStatus.IN_DELIVERY]: "Em entrega",
  [OrderFulfillmentStatus.DELIVERED]: "Entregue",
  [OrderFulfillmentStatus.CANCELED]: "Cancelado",
}

/** pt-BR STAFF (Title Case) display labels for each payment status. */
export const PAYMENT_STATUS_LABELS_PT: Record<PaymentStatus, string> = {
  [PaymentStatus.AWAITING_PAYMENT]: "Aguardando pagamento",
  [PaymentStatus.PAYMENT_PENDING]: "Pagamento pendente",
  [PaymentStatus.PAYMENT_EXPIRED]: "Pagamento expirado",
  [PaymentStatus.PAYMENT_FAILED]: "Pagamento falhou",
  [PaymentStatus.CASH_PENDING]: "Dinheiro (pendente)",
  [PaymentStatus.PAID]: "Pago",
  [PaymentStatus.SWITCHING_METHOD]: "Trocando forma de pagamento",
  [PaymentStatus.PARTIALLY_REFUNDED]: "Reembolso parcial",
  [PaymentStatus.REFUNDED]: "Reembolsado",
  [PaymentStatus.DISPUTED]: "Em disputa",
  [PaymentStatus.CANCELED]: "Cancelado",
  [PaymentStatus.WAIVED]: "Isento",
}

/** pt-BR STAFF (Title Case) display labels for each reservation status. Was the
 *  admin-labels.ts copy; the ops/admin badge voice for a reservation. */
export const RESERVATION_STATUS_LABELS_PT: Record<ReservationStatus, string> = {
  [ReservationStatus.PENDING]: "Pendente",
  [ReservationStatus.CONFIRMED]: "Confirmada",
  [ReservationStatus.SEATED]: "Sentada",
  [ReservationStatus.COMPLETED]: "Completa",
  [ReservationStatus.CANCELLED]: "Cancelada",
  [ReservationStatus.NO_SHOW]: "No Show",
}

/** pt-BR STAFF (Title Case) display labels for each fiscal (NFC-e) status —
 *  NEW-014; admin-only surface today (no customer register yet). */
export const FISCAL_STATUS_LABELS_PT: Record<FiscalStatus, string> = {
  [FiscalStatus.PENDING]: "Pendente",
  [FiscalStatus.APPROVED]: "Autorizada",
  [FiscalStatus.REJECTED]: "Rejeitada",
  [FiscalStatus.TIMEOUT]: "Processando",
  [FiscalStatus.ERROR]: "Erro",
}

// ── CUSTOMER register (sentence-voice — the claims renderer's voice) ─────────────
// Live-calibrated against the model — NEVER churn these strings. `claims-labels.ts`
// re-derives its per-(claimType, field) display map from these maps.

/** pt-BR CUSTOMER (sentence-voice) display labels for each order fulfillment status. */
export const ORDER_STATUS_LABELS_PT_CUSTOMER: Record<OrderFulfillmentStatus, string> = {
  [OrderFulfillmentStatus.PENDING]: "pendente",
  [OrderFulfillmentStatus.CONFIRMED]: "confirmado",
  [OrderFulfillmentStatus.PREPARING]: "em preparo",
  [OrderFulfillmentStatus.READY]: "pronto",
  [OrderFulfillmentStatus.IN_DELIVERY]: "saiu para entrega",
  [OrderFulfillmentStatus.DELIVERED]: "entregue",
  [OrderFulfillmentStatus.CANCELED]: "cancelado",
}

/** pt-BR CUSTOMER (sentence-voice) display labels for each payment status. */
export const PAYMENT_STATUS_LABELS_PT_CUSTOMER: Record<PaymentStatus, string> = {
  [PaymentStatus.AWAITING_PAYMENT]: "aguardando pagamento",
  [PaymentStatus.PAYMENT_PENDING]: "pagamento pendente",
  [PaymentStatus.PAYMENT_EXPIRED]: "pagamento expirado",
  [PaymentStatus.PAYMENT_FAILED]: "pagamento falhou",
  [PaymentStatus.CASH_PENDING]: "pagamento em dinheiro pendente",
  [PaymentStatus.PAID]: "pago",
  [PaymentStatus.SWITCHING_METHOD]: "trocando forma de pagamento",
  [PaymentStatus.PARTIALLY_REFUNDED]: "parcialmente reembolsado",
  [PaymentStatus.REFUNDED]: "reembolsado",
  [PaymentStatus.DISPUTED]: "em disputa",
  [PaymentStatus.CANCELED]: "cancelado",
  [PaymentStatus.WAIVED]: "isento",
}

/** pt-BR CUSTOMER (sentence-voice) display labels for each reservation status. */
export const RESERVATION_STATUS_LABELS_PT_CUSTOMER: Record<ReservationStatus, string> = {
  [ReservationStatus.PENDING]: "pendente",
  [ReservationStatus.CONFIRMED]: "confirmada",
  [ReservationStatus.SEATED]: "sentados",
  [ReservationStatus.COMPLETED]: "concluída",
  [ReservationStatus.CANCELLED]: "cancelada",
  [ReservationStatus.NO_SHOW]: "não compareceu",
}

// ── ADMIN extension (non-core keys the admin UI additionally renders) ───────────
// Legacy Medusa statuses + order aggregate states that are NOT members of the core
// enums. Keyed by values DISJOINT from the core enums (the exhaustiveness test pins
// the disjointness, so an extension key can never silently shadow a core status).

/** Non-core order-status keys the admin UI renders (aggregate/legacy states).
 *  Title Case like the staff register — the extension must never reintroduce the
 *  intra-admin case inconsistency BKL-016 removed. */
export const ADMIN_ORDER_STATUS_EXTRA: Record<string, string> = {
  completed: "Concluído",
  requires_action: "Ação necessária",
}

/** Non-core payment-status keys the admin UI renders (legacy Medusa states).
 *  Title Case like the staff register (see ADMIN_ORDER_STATUS_EXTRA note). */
export const ADMIN_PAYMENT_STATUS_EXTRA: Record<string, string> = {
  captured: "Pago",
  pending: "Pendente",
  cash_on_delivery: "Dinheiro",
  cancelado: "Cancelado",
  requires_action: "Ação necessária",
  not_paid: "Não pago",
}
