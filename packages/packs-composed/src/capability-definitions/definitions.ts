/**
 * Authored `CapabilityDefinition` instances — FE-4.1 EXPAND (FE-T19).
 *
 * Covers the 18 chat-drivable, LLM-callable MUTATING capabilities —
 * `CHAT_DRIVABLE_TOOL_KINDS` (`../index.ts`) — the minimum the ticket
 * requires and the same roster `generate-chat-drivable-tool-kinds.ts`
 * projects back out byte-for-byte. Extending to the full 70-kind
 * `KNOWN_INTENT_KINDS` set is NOT done here — the spec's FE-4 section does
 * not ask for it in this step, and every field below (auth level, pt-BR
 * description, legacy tool name, claim link) is grounded in a REAL,
 * cross-checked source for these 18; guessing the same fields for the ~52
 * remaining kinds (many staff/system/webhook-only, with no chat tool, no
 * docs entry, and no claim-class link to check against) would be
 * fabrication, not authoring.
 *
 * Every field is either DATA or a reference to hand-authored code (P5) —
 * see `types.ts` for the per-field contract. Grounding for each field:
 *
 *   - `kind` / `pack` / `mutating` / `legacyNames` / `description` — cross-
 *     checked against `apps/api/src/tools/register-ibatexas-tool-packs.ts`
 *     (`IBATEXAS_TOOLS`, `IBATEXAS_CAPABILITY_DESCRIPTIONS`) and each
 *     pack's `*_TOOL_TO_INTENT` map in `capabilities.ts`.
 *   - `surfaces` — `["chat"]` for all 18, by construction: this list IS
 *     the chat-drivable roster.
 *   - `auth` — cross-checked against `docs/architecture/design/
 *     agent-tools.md` §"Auth levels" and, where the doc is silent or
 *     stale, each pack's `CapabilityPlanner.plan()` authentication gate
 *     (see per-instance comments below for the non-obvious cases).
 *   - `successClaimLink` — inverted from `SUCCESS_CLAIM_CLASSES.justifiedBy`
 *     (`apps/api/src/claustrum/ibatexas-responder.ts`) — `undefined` where
 *     no class lists this kind (a real, common, and correct state; see
 *     `types.ts`).
 *   - `guardRefs` — each owning pack's full `stateGuards`/`authGuards`/
 *     `business` guard-name list (see `types.ts` for why this is the
 *     kernel-faithful granularity), EXCLUDING `requireTenantBindingGuard`
 *     (unresolvable today — see `guard-resolution.ts`'s "Known gap").
 *   - `refusalCode` — each pack's `<domain>.default.deny` `basisCodes`
 *     entry.
 */

import type { CapabilityDefinition, CapabilityGuardRef } from "./types.js"

// ── Per-pack guard-ref lists ─────────────────────────────────────────────
//
// Hand-typed from each pack's `src/policies.ts` `PolicyBundle` literal
// (`ordersPolicyBundle`, `paymentsPolicyBundle`, …) — NOT computed from the
// live bundle. Computing them would make `assertGuardRefsResolve` check a
// source against itself (FE-4.3's explicit "tautological gate" trap); these
// are the authored side, independently verified against the live
// `IBATEXAS_COMPOSED_PACKS` bundles by `guard-resolution.ts`.
//
// One list per pack, reused across every capability instance that pack
// owns (see `types.ts` `guardRefs` doc for why pack-wide is the correct
// granularity, not a DRY shortcut of convenience).

const ORDERS_GUARD_REFS: readonly CapabilityGuardRef[] = [
  { phase: "state", name: "requireCartIdForCartOps" },
  { phase: "state", name: "requireOrderIdForMutation" },
  { phase: "state", name: "requireLegalStatusTransition" },
  { phase: "state", name: "requireCancellable" },
  { phase: "state", name: "requireAmendable" },
  { phase: "state", name: "requireCartItemsForCheckout" },
  { phase: "state", name: "requireSlotsFilledForCheckout" },
  { phase: "state", name: "deferOnPendingPix" },
  // authGuards[0] `requireTenantBindingGuard` omitted — see guard-resolution.ts.
  { phase: "auth", name: "requireAuthenticated" },
  { phase: "auth", name: "enforceOrderOwnership" },
  { phase: "auth", name: "requireCheckoutEligibility" },
  { phase: "business", name: "requireExplicitAllergens" },
  { phase: "business", name: "validateQuantity" },
  { phase: "business", name: "clampUpdateToStockCap" },
  { phase: "business", name: "validatePaymentMethod" },
  { phase: "business", name: "refuseAmountAboveCap" },
  { phase: "business", name: "gatePaidCancel" },
  { phase: "business", name: "escalateLargeCancel" },
  { phase: "business", name: "confirmLargeTicket" },
  { phase: "business", name: "validateReviewRating" },
  { phase: "business", name: "refuseCardPanInPix" },
  { phase: "business", name: "redactPiiInPix" },
  { phase: "business", name: "requireAmendItemDisambiguation" },
  { phase: "business", name: "executeCartOps" },
  { phase: "business", name: "executeCheckout" },
  { phase: "business", name: "executeCancel" },
  { phase: "business", name: "executeAmend" },
  { phase: "business", name: "executeNoteAdd" },
  { phase: "business", name: "executeW5Kinds" },
] as const

const PAYMENTS_GUARD_REFS: readonly CapabilityGuardRef[] = [
  { phase: "state", name: "requirePaymentExists" },
  { phase: "state", name: "refuseTerminalTransition" },
  // authGuards[0] `requireTenantBindingGuard` omitted — see guard-resolution.ts.
  { phase: "auth", name: "enforcePaymentOwnership" },
  { phase: "business", name: "validateCreateMethod" },
  { phase: "business", name: "validateMethodSwitch" },
  { phase: "business", name: "refundPaymentStateRefundableGuard" },
  { phase: "business", name: "refundEligibilityGuard" },
  { phase: "business", name: "refundFreshnessGuard" },
  { phase: "business", name: "refundMagnitudeGuard" },
  { phase: "business", name: "regenerationCountCapGuard" },
  { phase: "business", name: "retryDailyCapGuard" },
  { phase: "business", name: "escalateAlwaysOnDispute" },
  { phase: "business", name: "confirmAlwaysOnWaive" },
  { phase: "business", name: "confirmAlwaysOnStatusForce" },
  { phase: "business", name: "executeAll" },
] as const

const RESERVATIONS_GUARD_REFS: readonly CapabilityGuardRef[] = [
  { phase: "state", name: "requireReservationPresent" },
  { phase: "state", name: "requireReservationModifiable" },
  { phase: "state", name: "requireReservationCancellable" },
  { phase: "state", name: "requireSlotInFuture" },
  { phase: "state", name: "requireSlotWithCapacity" },
  { phase: "state", name: "refuseModifyOnFullNewSlot" },
  // authGuards[0] `requireTenantBindingGuard` omitted — see guard-resolution.ts.
  { phase: "auth", name: "requireAuthenticated" },
  { phase: "auth", name: "requireStaff" },
  { phase: "business", name: "validatePartySize" },
  { phase: "business", name: "refuseBlockedCustomer" },
  { phase: "business", name: "escalateHighNoShowRate" },
  { phase: "business", name: "confirmLastMinuteCancel" },
  { phase: "business", name: "executeCreate" },
  { phase: "business", name: "executeModify" },
  { phase: "business", name: "executeCancel" },
  { phase: "business", name: "executeStaffTransitions" },
  { phase: "business", name: "executeNoShow" },
  { phase: "business", name: "executeWaitlist" },
] as const

const CUSTOMER_ONBOARDING_GUARD_REFS: readonly CapabilityGuardRef[] = [
  { phase: "state", name: "requireCustomerExists" },
  { phase: "state", name: "requireFreshOtp" },
  { phase: "state", name: "refuseAnonymizeIfAlreadyPending" },
  // authGuards[0] `requireTenantBindingGuard` omitted — see guard-resolution.ts.
  { phase: "auth", name: "requireAuthenticated" },
  { phase: "business", name: "validateAllergenExplicitArray" },
  { phase: "business", name: "enforceProfileRateLimit" },
  { phase: "business", name: "validateCpfShape" },
  { phase: "business", name: "refuseCardPanInPix" },
  { phase: "business", name: "redactPiiInPix" },
  { phase: "business", name: "handleAnonymizeCancelSupersedesParked" },
  { phase: "business", name: "handleAnonymizeCancelNoParked" },
  { phase: "business", name: "deferAnonymizeForGrace" },
  { phase: "business", name: "executeAnonymize" },
  { phase: "business", name: "executeCreate" },
  { phase: "business", name: "executeProfileUpdate" },
  { phase: "business", name: "executePreferencesUpdate" },
  { phase: "business", name: "executePixDetailsSave" },
  { phase: "business", name: "executeAddressAdd" },
  { phase: "business", name: "executeAddressRemove" },
] as const

const WHATSAPP_GUARD_REFS: readonly CapabilityGuardRef[] = [
  { phase: "state", name: "requireWindowOpen" },
  // authGuards[0] `requireTenantBindingGuard` omitted — see guard-resolution.ts.
  { phase: "auth", name: "refuseUnprojectedStaffRouting" },
  { phase: "business", name: "validateTemplate" },
  { phase: "business", name: "refuseExcessiveHandoff" },
  { phase: "business", name: "confirmRepeatedHandoff" },
  { phase: "business", name: "sanitizeCustomerToStaff" },
  { phase: "business", name: "executeMessageSend" },
  { phase: "business", name: "executeTemplateSend" },
  { phase: "business", name: "executeSessionHandover" },
  { phase: "business", name: "executeConversationAppend" },
  { phase: "business", name: "executeHandoffRequest" },
] as const

// ── Capability instances ─────────────────────────────────────────────────

export const CAPABILITY_DEFINITIONS: readonly CapabilityDefinition[] = [
  // ── pack-orders (10) ─────────────────────────────────────────────────
  {
    kind: "order.cart.ensure",
    pack: "ibatexas/pack-orders",
    mutating: true,
    surfaces: ["chat"],
    // Always-proposable in `ordersCapabilityPlanner` regardless of
    // `isAuthenticated` — guest cart operations are supported.
    auth: "guest",
    legacyNames: ["get_or_create_cart"],
    description: "Garantir um carrinho ativo para a sessão do cliente.",
    successClaimLink: undefined,
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  {
    kind: "order.item.add",
    pack: "ibatexas/pack-orders",
    mutating: true,
    surfaces: ["chat"],
    auth: "guest",
    legacyNames: ["add_to_cart"],
    description: "Adicionar um item ao carrinho do cliente.",
    successClaimLink: "cart-item-added",
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  {
    kind: "order.item.update",
    pack: "ibatexas/pack-orders",
    mutating: true,
    surfaces: ["chat"],
    auth: "guest",
    legacyNames: ["update_cart"],
    description: "Atualizar a quantidade de um item no carrinho.",
    successClaimLink: "cart-item-added",
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  {
    kind: "order.item.remove",
    pack: "ibatexas/pack-orders",
    mutating: true,
    surfaces: ["chat"],
    auth: "guest",
    legacyNames: ["remove_from_cart"],
    description: "Remover um item do carrinho do cliente.",
    successClaimLink: "cart-item-added",
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  {
    kind: "order.coupon.apply",
    pack: "ibatexas/pack-orders",
    mutating: true,
    surfaces: ["chat"],
    auth: "guest",
    legacyNames: ["apply_coupon"],
    description: "Aplicar um cupom de desconto ao carrinho.",
    successClaimLink: undefined,
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  {
    kind: "order.checkout.create",
    pack: "ibatexas/pack-orders",
    mutating: true,
    surfaces: ["chat"],
    // Requires `isAuthenticated` OR guest CARD checkout (RC-A1 D-24 Ruling
    // 2, `isCardCheckout` in policies.ts) — modeled as "customer" (the
    // general case); the guest-card exemption is a guard-level nuance, not
    // a planner-level relaxation (the planner still gates on
    // `canCheckout`, which allows the WhatsApp channel or an authenticated
    // customerId).
    auth: "customer",
    legacyNames: ["create_checkout"],
    description: "Criar checkout (sessão de pagamento) a partir do carrinho.",
    // Also co-justifies "purchase-completed" and "pix-generated" in
    // SUCCESS_CLAIM_CLASSES; "order-placed" is the primary/most specific
    // class (listed first, and the one the module's own regex comments
    // treat as canonical for this kind).
    successClaimLink: "order-placed",
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  {
    kind: "order.cancel",
    pack: "ibatexas/pack-orders",
    mutating: true,
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["cancel_order"],
    description: "Cancelar um pedido do cliente (irreversível).",
    successClaimLink: "order-canceled",
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  {
    kind: "order.amend.request",
    pack: "ibatexas/pack-orders",
    mutating: true,
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["amend_order"],
    description: "Solicitar alteração em um pedido já realizado.",
    successClaimLink: "order-amended",
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  {
    kind: "order.note.add",
    pack: "ibatexas/pack-orders",
    mutating: true,
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["add_order_note"],
    description: "Adicionar uma observação a um pedido.",
    successClaimLink: "note-added",
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  {
    kind: "order.review.submit",
    pack: "ibatexas/pack-orders",
    mutating: true,
    // Registered as a chat tool (in CHAT_DRIVABLE_TOOL_KINDS) but the live
    // `ordersCapabilityPlanner.allowedIntents` never advertises it — see
    // `register-ibatexas-tool-packs.ts`'s roster-drift doc: "the orders
    // planner never advertises it; reviews arrive via the web flow". `auth`
    // reflects `docs/architecture/design/agent-tools.md` (`submit_review` →
    // customer), which is the capability's DECLARED auth requirement
    // independent of whether the chat planner currently offers it.
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["submit_review"],
    description: "Enviar uma avaliação de um pedido concluído.",
    successClaimLink: undefined,
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },

  // ── pack-reservations (4) ────────────────────────────────────────────
  {
    kind: "reservation.create",
    pack: "ibatexas/pack-reservations",
    mutating: true,
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["create_reservation"],
    description: "Criar uma reserva de mesa.",
    successClaimLink: "reservation-confirmed",
    guardRefs: RESERVATIONS_GUARD_REFS,
    refusalCode: "reservation.default.deny",
  },
  {
    kind: "reservation.modify",
    pack: "ibatexas/pack-reservations",
    mutating: true,
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["modify_reservation"],
    description: "Modificar uma reserva existente.",
    successClaimLink: "reservation-confirmed",
    guardRefs: RESERVATIONS_GUARD_REFS,
    refusalCode: "reservation.default.deny",
  },
  {
    kind: "reservation.cancel",
    pack: "ibatexas/pack-reservations",
    mutating: true,
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["cancel_reservation"],
    description: "Cancelar uma reserva existente.",
    // No "reservation-canceled" class exists in SUCCESS_CLAIM_CLASSES today
    // (only "order-canceled" does) — genuinely undefined, not an omission.
    successClaimLink: undefined,
    guardRefs: RESERVATIONS_GUARD_REFS,
    refusalCode: "reservation.default.deny",
  },
  {
    kind: "reservation.waitlist.join",
    pack: "ibatexas/pack-reservations",
    mutating: true,
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["join_waitlist"],
    description: "Entrar na lista de espera de um horário lotado.",
    successClaimLink: undefined,
    guardRefs: RESERVATIONS_GUARD_REFS,
    refusalCode: "reservation.default.deny",
  },

  // ── pack-customer-onboarding (2) ─────────────────────────────────────
  {
    kind: "customer.preferences.update",
    pack: "ibatexas/pack-customer-onboarding",
    mutating: true,
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["update_preferences"],
    description: "Atualizar as preferências do cliente.",
    successClaimLink: undefined,
    guardRefs: CUSTOMER_ONBOARDING_GUARD_REFS,
    refusalCode: "customer.default.deny",
  },
  {
    kind: "customer.pix.details.save",
    pack: "ibatexas/pack-customer-onboarding",
    mutating: true,
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["save_pix_details"],
    description: "Salvar os dados PIX do cliente para reembolsos.",
    successClaimLink: undefined,
    guardRefs: CUSTOMER_ONBOARDING_GUARD_REFS,
    refusalCode: "customer.default.deny",
  },

  // ── pack-payments (1) ────────────────────────────────────────────────
  {
    kind: "payment.pix.regenerate",
    pack: "ibatexas/pack-payments",
    mutating: true,
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["regenerate_pix"],
    description: "Gerar um novo código PIX para um pagamento pendente.",
    successClaimLink: "pix-generated",
    guardRefs: PAYMENTS_GUARD_REFS,
    refusalCode: "payment.default.deny",
  },

  // ── pack-whatsapp (1) ────────────────────────────────────────────────
  {
    kind: "whatsapp.handoff.request",
    pack: "ibatexas/pack-whatsapp",
    mutating: true,
    surfaces: ["chat"],
    // The one guest-accessible tool in the roster —
    // `docs/architecture/design/agent-tools.md`'s `handoff_to_human` entry:
    // "Auth: guest".
    auth: "guest",
    legacyNames: ["request_human_handoff"],
    description:
      "Transferir o atendimento para um atendente humano quando o cliente pedir para falar com uma pessoa.",
    successClaimLink: undefined,
    guardRefs: WHATSAPP_GUARD_REFS,
    refusalCode: "whatsapp.default.deny",
  },
] as const
