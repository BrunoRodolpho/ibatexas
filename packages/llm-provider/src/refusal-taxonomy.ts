/**
 * Refusal taxonomy — Phase D of IBX-IGE.
 *
 * Maps every refusal source in IbateXas to a typed `Refusal` per the stratified
 * categories (SECURITY / BUSINESS_RULE / AUTH / STATE). This module is the
 * single source of truth for refusal codes + user-facing messages (pt-BR) so
 * that Phase E can wire them into the kernel Decision without scattering
 * strings through the codebase.
 *
 * - Forbidden-phrase hits from validation-layer.ts → SECURITY
 * - Guard falses (machine/guards.ts)               → STATE / AUTH / BUSINESS_RULE
 *
 * Codes are stable — audit replays depend on them. User-facing text is pt-BR
 * per CLAUDE.md rule #4.
 */

import { refuse, type Refusal } from "@adjudicate/intent-core"

// ── Forbidden-phrase refusals (SECURITY) ──────────────────────────────────────

/**
 * Emitted when the two-phase commit in validation-layer.ts catches the LLM
 * pre-confirming an action. The rewrite happens in the validator; this refusal
 * is for the case where a caller cannot safely rewrite (Phase E REWRITE is the
 * preferred path for sanitization).
 */
export function refuseForbiddenPhrase(
  stateValue: string,
  match: string,
): Refusal {
  const code = stateValue.startsWith("post_order")
    ? "post_order.forbidden_phrase"
    : stateValue.startsWith("checkout")
      ? "checkout.forbidden_phrase"
      : "ordering.forbidden_phrase"
  return refuse(
    "SECURITY",
    code,
    "Vou checar antes de confirmar.",
    `Forbidden phrase detected in ${stateValue}: "${match}"`,
  )
}

// ── Authentication refusals (AUTH) ────────────────────────────────────────────

export function refuseNotAuthenticated(): Refusal {
  return refuse(
    "AUTH",
    "auth.required",
    "Preciso confirmar seu cadastro antes de continuar — me diz seu número de WhatsApp.",
  )
}

export function refuseGuestCheckoutBlocked(): Refusal {
  return refuse(
    "AUTH",
    "auth.guest_checkout_blocked",
    "Pra finalizar, preciso do seu WhatsApp cadastrado.",
  )
}

// ── State refusals (STATE) ────────────────────────────────────────────────────

export function refuseCartEmpty(): Refusal {
  return refuse(
    "STATE",
    "cart.empty",
    "Seu carrinho está vazio. Quer começar por algum item do cardápio?",
  )
}

export function refuseOrderAlreadyCancelled(): Refusal {
  return refuse(
    "STATE",
    "order.already_cancelled",
    "Esse pedido já foi cancelado.",
  )
}

export function refuseNoOrderToMutate(): Refusal {
  return refuse(
    "STATE",
    "order.not_found",
    "Não encontrei um pedido em aberto pra você.",
  )
}

export function refuseOrderAlreadyShipped(): Refusal {
  return refuse(
    "STATE",
    "order.already_shipped",
    "Seu pedido já saiu pra entrega — não dá mais pra alterar.",
  )
}

export function refuseSlotsIncomplete(): Refusal {
  return refuse(
    "STATE",
    "checkout.slots_incomplete",
    "Falta escolher entrega ou pagamento antes de finalizar.",
  )
}

// ── Business-rule refusals (BUSINESS_RULE) ────────────────────────────────────

export function refuseInvalidPaymentMethod(method: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "payment.invalid_method",
    "Esse método de pagamento não está disponível.",
    `method=${method}`,
  )
}

export function refuseQuantityOverLimit(requested: number, max: number): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "quantity.over_limit",
    `Posso reservar até ${max} unidades desse item.`,
    `requested=${requested} max=${max}`,
  )
}

export function refuseUpsellExhausted(): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "upsell.exhausted",
    "Vamos seguir pra finalização do pedido.",
  )
}

export function refuseDefaultDeny(reason?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "default.deny",
    "Essa ação não é permitida neste momento.",
    reason,
  )
}

// ── Mapping helpers — keep the guard → refusal map discoverable ───────────────

/**
 * Guard name → refusal factory. Consumers that want to emit a typed refusal
 * when a specific guard returns false look up the factory here.
 *
 * Keep in sync with `packages/llm-provider/src/machine/guards.ts`.
 */
export const GUARD_REFUSAL_MAP: Readonly<Record<string, () => Refusal>> = {
  isAuthenticated: refuseNotAuthenticated,
  canCheckout: refuseGuestCheckoutBlocked,
  hasCartItems: refuseCartEmpty,
  canCancelOrder: refuseOrderAlreadyCancelled,
  canAmendOrder: refuseOrderAlreadyShipped,
  hasOrderId: refuseNoOrderToMutate,
  allSlotsFilled: refuseSlotsIncomplete,
  hasFulfillment: refuseSlotsIncomplete,
  hasPaymentMethod: refuseSlotsIncomplete,
}
