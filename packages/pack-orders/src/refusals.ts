/**
 * @ibatexas/pack-orders — typed refusal helpers (pt-BR).
 *
 * Every refusal the Pack's policy emits flows through one of these
 * builders. The machine-readable `code` is stable — observability,
 * drift detection (M3 AaC review), and audit-record analytics key
 * off it. The user-facing text is pt-BR per CLAUDE.md rule #4 and is
 * the only place the strings live (no scattering).
 *
 * Codes follow the dotted convention prefixed by the Pack's domain
 * (`order.*`), mirroring the `pix.charge.*` convention in
 * `@adjudicate/pack-payments-pix`.
 *
 * The pt-BR locale dictionary (`@adjudicate/locales-pt-BR.
 * portugueseRefusalMessages`) covers kernel-emitted codes
 * (`taint_level_insufficient`, `default_deny`, etc.); Pack-specific
 * codes ship their pt-BR userFacing here so a downstream
 * `localizeDecision()` call falls through to the embedded text
 * rather than the kernel fallback.
 */

import { refuse, type Refusal } from "@adjudicate/core"
import { portugueseRefusalMessages } from "@adjudicate/locales-pt-br"

// ── Auth refusals (AUTH) ────────────────────────────────────────────────

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

// ── State refusals (STATE) ──────────────────────────────────────────────

export function refuseCartEmpty(): Refusal {
  return refuse(
    "STATE",
    "order.cart.empty",
    "Seu carrinho está vazio. Quer começar por algum item do cardápio?",
  )
}

export function refuseNoCartId(): Refusal {
  return refuse(
    "STATE",
    "order.cart.missing",
    "Não encontrei um carrinho aberto pra essa operação.",
  )
}

export function refuseNoOrderToMutate(): Refusal {
  return refuse(
    "STATE",
    "order.not_found",
    "Não encontrei um pedido em aberto pra você.",
  )
}

export function refuseOrderAlreadyCancelled(): Refusal {
  return refuse(
    "STATE",
    "order.already_cancelled",
    "Esse pedido já foi cancelado.",
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
    "order.checkout.slots_incomplete",
    "Falta escolher entrega ou pagamento antes de finalizar.",
  )
}

export function refuseCheckoutMissingPaymentMethod(): Refusal {
  return refuse(
    "STATE",
    "order.checkout.payment_method_missing",
    "Escolhe primeiro como você quer pagar (PIX, cartão ou dinheiro).",
  )
}

// ── Business refusals (BUSINESS_RULE) ───────────────────────────────────

/**
 * SAFETY-CRITICAL refusal per CLAUDE.md hard rule #1: allergens MUST
 * arrive as an explicit string array. The Pack refuses to process an
 * `order.item.add` whose `allergens` field is missing, non-array, or
 * carries a non-string element — covering the LLM-inferred-from-text
 * attack vector this rule exists to block.
 */
export function refuseAllergensNotExplicit(detail?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "order.item.allergens_not_explicit",
    "Por segurança, preciso de uma lista explícita dos alérgenos desse item.",
    detail,
  )
}

export function refuseInvalidQuantity(quantity: unknown): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "order.item.quantity_invalid",
    "A quantidade precisa ser um número inteiro positivo.",
    `quantity=${String(quantity)}`,
  )
}

export function refuseQuantityOverLimit(
  requested: number,
  max: number,
): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "order.item.quantity_over_limit",
    `Posso reservar até ${max} unidades desse item.`,
    `requested=${requested} max=${max}`,
  )
}

export function refuseInvalidPaymentMethod(method: unknown): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "order.checkout.payment_method_invalid",
    "Esse método de pagamento não está disponível.",
    `method=${String(method)}`,
  )
}

export function refuseAmountExceedsLimit(
  amountCentavos: number,
  cap: number,
): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "order.checkout.amount_exceeds_limit",
    `Esse pedido passa do nosso limite atual. Posso te conectar com um atendente?`,
    `amountCentavos=${amountCentavos} cap=${cap}`,
  )
}

/**
 * Pack-level default-deny. The kernel's own default-deny path emits
 * `default_deny` (see `@adjudicate/locales-pt-BR.portugueseRefusalMessages`);
 * Packs that want a richer user-facing message return this Refusal from
 * a final business-guard fall-through.
 */
export function refuseDefault(reason?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "order.default.deny",
    "Operação não permitida.",
    reason,
  )
}

// ── pt-BR locale dictionary (re-export for adopter convenience) ─────────

/**
 * Re-export the kernel locale so adopters who call
 * `localizeDecision(decision, locale)` at presentation can compose this
 * Pack's codes on top:
 *
 * ```ts
 * import { portugueseRefusalMessages } from "@ibatexas/pack-orders"
 * import { localizeDecision } from "@adjudicate/core"
 *
 * const userText = localizeDecision(decision, portugueseRefusalMessages)
 * ```
 *
 * The embedded `userFacing` on each Refusal already carries pt-BR text;
 * this re-export is for the kernel-emitted codes the Pack doesn't own.
 */
export { portugueseRefusalMessages }
