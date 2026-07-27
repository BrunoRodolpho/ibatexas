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

/**
 * LE2-021 — "repete meu último pedido" from a customer who has never ordered.
 *
 * Its own code and its own sentence rather than `refuseDefault()`, and the
 * difference is not cosmetic: the default deny says *"Operação não permitida"*,
 * which tells a first-time customer they lack PERMISSION to do something they
 * are in fact perfectly entitled to do. The true fact is that there is nothing
 * to repeat yet. Ticket 21's fourth acceptance criterion asks for an HONEST
 * render on the no-history path, and a permission frame over a state fact is
 * exactly the kind of plausible-but-wrong sentence the whole claims runtime
 * exists to prevent — so the honest sentence gets a code, and the code goes in
 * `ordersPack.basisCodes` where the AaC drift gate can see it.
 *
 * `order.not_found` above was the near-miss and is genuinely a different fact:
 * it means the customer HAS orders but none is in a mutable state. Reusing it
 * here would tell someone with an empty history that their nonexistent order is
 * merely closed.
 */
export function refuseNoPreviousOrder(): Refusal {
  return refuse(
    "STATE",
    "order.reorder.no_history",
    "Ainda não encontrei nenhum pedido anterior seu pra repetir. Quer montar um novo?",
  )
}

/**
 * LE2-024 — "cancela meu pedido" from a customer who has no order to cancel.
 *
 * Its OWN sentence rather than {@link refuseNoPreviousOrder}'s, under the same
 * warrant that gave that one its own code. Both are the no-history fact, but
 * they are read by customers who asked opposite questions, and the reorder
 * sentence ends *"pra repetir. Quer montar um novo?"* — an offer to BUILD
 * something, cheerfully proposed to somebody who just asked to DESTROY
 * something. A customer who believes they have an order they want gone, being
 * told about a new one, will read it as the system having misunderstood them at
 * best and as an upsell at worst.
 *
 * It reuses the `order.reorder.no_history` CODE deliberately: the underlying
 * state fact is identical (no owner-scoped previous order), and a second code
 * for one fact would split the basis-code surface — and every drift gate over
 * it — on a difference that is purely about which sentence a reader needs. The
 * code is what an operator groups by; the text is what a customer reads.
 */
export function refuseNoOrderToCancel(): Refusal {
  return refuse(
    "STATE",
    "order.reorder.no_history",
    "Ainda não encontrei nenhum pedido seu pra cancelar. Se você fez um pedido agora há pouco, me chama que eu procuro de novo.",
  )
}

/** Max candidate order numbers voiced inline before summarising the remainder. */
const MAX_AMBIGUOUS_ORDERS_SHOWN = 6

/**
 * BKL-216 — a specific "which order?" refusal for a message that named ≥2 of the
 * customer's OWN orders ("tira a coca do 933869 e do 933870"). The amend resolver
 * (`resolveAmendOrderReference`) declines to guess between them and stamps
 * `orderReferenceAmbiguousCount` + `orderReferenceAmbiguousDisplayIds`. This voices
 * the numbers INSTEAD of the bare `refuseNoOrderToMutate` (the orders WERE found;
 * the resolver just would not pick one). The display numbers are the customer's own
 * first-party order data — never model-authored — so the refusal asserts no
 * unbacked fact. Mirrors `refuseReservationAmbiguous` (pack-reservations).
 */
export function refuseAmbiguousOrderReference(
  displayIds: readonly number[],
): Refusal {
  const shown = displayIds
    .slice(0, MAX_AMBIGUOUS_ORDERS_SHOWN)
    .map((d) => `#${d}`)
    .join(", ")
  const more =
    displayIds.length > MAX_AMBIGUOUS_ORDERS_SHOWN ? ", entre outros" : ""
  const userFacing =
    shown === ""
      ? "Você citou mais de um pedido. Em qual deles?"
      : `Você citou mais de um pedido: ${shown}${more}. Em qual deles?`
  return refuse(
    "STATE",
    "order.ambiguous_reference",
    userFacing,
    `count=${displayIds.length}`,
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

export function refuseOrderPastPonr(): Refusal {
  return refuse(
    "STATE",
    "order.past_ponr",
    "Esse pedido já passou do ponto de cancelamento — entre em contato com o restaurante.",
  )
}

export function refuseOwnershipDenied(): Refusal {
  return refuse(
    "SECURITY",
    "order.ownership_denied",
    "Esse pedido não pertence à sua conta.",
  )
}

/**
 * LE2-023 — the swap-for-coupon ask for a coupon that is not usable, or that we
 * could not check at all.
 *
 * ── WHY ONE SENTENCE FOR TWO DIFFERENT FACTS ────────────────────────────────
 *
 * `couponIsValid: false` means the store told us this code is not usable;
 * ABSENT means the lookup never completed. Those are genuinely different facts
 * (Inv 7, and `coupon-price-projection.ts` keeps them apart precisely so this
 * Pack never claims the first when only the second is true) — but they are not
 * different SENTENCES, because the only honest thing this text may assert is
 * what we could establish about OURSELVES, not about the coupon. "Não consegui
 * confirmar esse cupom" is true in both worlds; "esse cupom é inválido" is a
 * claim about the store that is only true in one of them, and it is the one a
 * customer would act on by throwing away a coupon that works.
 *
 * So the distinction lives where it can be acted on — in the projection, in the
 * facts, and in the workflow's own pre-check templates, which speak before any
 * envelope exists — and this guard-level refusal, which is the FAIL-SAFE for a
 * coupon that went bad between the confirm and the customer's "sim", says only
 * what it can stand behind.
 */
export function refuseCouponNotUsable(): Refusal {
  return refuse(
    "STATE",
    "order.coupon.not_usable",
    "Não consegui confirmar esse cupom agora, então não cancelei nada. Quer tentar outro código?",
  )
}

/**
 * LE2-023 — the coupon is usable and this system still cannot say what the
 * rebuilt basket would cost.
 *
 * A REAL state, not a defensive stub: a `buyget` promotion, one carrying
 * targeting rules, and a fixed amount in a non-BRL currency are all perfectly
 * valid coupons whose whole-basket arithmetic "total − desconto" simply does not
 * compute (see `couponDiscountInCentavos`). Its own code and sentence because
 * the customer's next move differs from every other refusal here: nothing is
 * wrong with their coupon, and the thing that cannot be done is the SWAP, so
 * pointing them at checkout — where the store itself applies the promotion
 * correctly — is the useful answer rather than a dead end.
 *
 * Kept apart from `order.coupon.not_usable` above for exactly the reason that
 * one merges its two inputs: there the sentences would have been the same, here
 * they are not.
 */
export function refuseSwapTotalUnknown(): Refusal {
  return refuse(
    "STATE",
    "order.coupon.swap.total_unknown",
    "Esse cupom é válido, mas não consigo calcular o total do pedido novo com ele — então não cancelei nada. Dá pra aplicar ele na hora de finalizar um pedido novo.",
  )
}

export function refuseSlotsIncomplete(): Refusal {
  return refuse(
    "STATE",
    "order.checkout.slots_incomplete",
    "Falta escolher entrega ou pagamento antes de finalizar.",
  )
}

// ── Status-transition legality refusals (STATE) ─────────────────────────
//
// Emitted by `requireLegalStatusTransition` (policies.ts) — the kernel-level
// transition-legality guard (BKL-090) that gates `order.status.transition`
// BEFORE it can reach EXECUTE on the ops/staff plane. These are the KERNEL
// analogue of the imperative `InvalidTransitionError` the executor throws
// inside the DB transaction (the throw remains the last transactional line;
// see the kernel/executor division documented in policies.ts). The
// user-facing copy is operator-facing pt-BR (the ops persona surface).

/** Target status is not a legal next state from the current status. */
export function refuseTransitionIllegal(from: string, to: string): Refusal {
  return refuse(
    "STATE",
    "order.status.transition_illegal",
    "Esse pedido não pode avançar para esse status a partir do estado atual.",
    `from=${from} to=${to}`,
  )
}

/** Current status is terminal (delivered / canceled) — nothing to advance. */
export function refuseTransitionTerminal(from: string): Refusal {
  return refuse(
    "STATE",
    "order.status.terminal",
    "Esse pedido já está em um status final e não pode mais mudar.",
    `from=${from}`,
  )
}

/**
 * The current status is missing or unrecognized — the guard fails CLOSED on
 * the ops/staff (`admin:`) plane rather than trusting an unknown state. Also
 * covers a target `newStatus` that is not one of the seven known statuses.
 */
export function refuseTransitionStatusUnknown(detail?: string): Refusal {
  return refuse(
    "STATE",
    "order.status.unknown",
    // BKL-150(b): name the valid target tokens so a staff typo ("cancelled",
    // "pronto") gets an actionable correction instead of a dead end. The guard
    // stays strict — no normalization here.
    "Não consegui confirmar o status do pedido. Os status válidos são: confirmed, " +
      "preparing, ready, in_delivery, delivered ou canceled — verifique e tente de novo.",
    detail,
  )
}

export function refuseCheckoutMissingPaymentMethod(): Refusal {
  return refuse(
    "STATE",
    "order.checkout.payment_method_missing",
    "Escolhe primeiro como você quer pagar (PIX, cartão ou dinheiro).",
  )
}

// ── Fiscal refusals (NEW-014) ───────────────────────────────────────────

/** `order.fiscal.emit` on an order that has NOT reached a fiscal-eligible
 *  state (delivered) — a fiscal document must never be emitted for an
 *  incomplete sale. System-emitted; the userFacing is for audit/observability. */
export function refuseFiscalNotEligible(detail?: string): Refusal {
  return refuse(
    "STATE",
    "order.fiscal.not_eligible",
    "O pedido ainda não está em um estado fiscalmente elegível para emissão.",
    detail,
  )
}

/** `order.fiscal.emit` that exceeded the bounded retry cap — fail-closed
 *  rather than hammer SEFAZ / the provider. */
export function refuseFiscalRetryExceeded(detail?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "order.fiscal.retry_exceeded",
    "Número máximo de tentativas de emissão fiscal atingido para este pedido.",
    detail,
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
 * Review rating outside the 1–5 integer range. The wire schema also
 * validates this at the LLM tool boundary, but the kernel runs as a
 * second authority — an LLM that fabricates a rating value (e.g.
 * `rating: 10`) is refused here rather than reaching Prisma.
 */
export function refuseInvalidRating(rating: unknown): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "order.review.rating_invalid",
    "A nota da avaliação precisa ser um número inteiro de 1 a 5 estrelas.",
    `rating=${String(rating)}`,
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
