/**
 * Authored `CapabilityDefinition` instances — FE-4 EXPAND (FE-T19) +
 * MIGRATE 1 (FE-T20).
 *
 * Covers all 61 first-party-Pack-owned intent kinds (66 before BKL-176
 * retired the 5 dead `payment.charge.*` kinds — see the pack-payments group
 * below) (the 6 packs'
 * `*_INTENT_KINDS` groupings in `@ibatexas/intent-kinds` — i.e.
 * `KNOWN_INTENT_KINDS` minus the 3 `pix.*` kinds, which mirror the FROZEN
 * external `@adjudicate/pack-payments-pix`, and `loyalty.stamp.add`, which
 * is not Pack-owned at all — see `generate-known-intent-kinds.ts` for how
 * those two stay explicit, non-fabricated inputs rather than being folded
 * silently into this registry).
 *
 * Two tiers (`CapabilityTier`, `types.ts`):
 *
 *   - **`"chat"` (18 as FE-T19/T20 left it; 20 today — see the FE-T09
 *     addendum below)** — the chat-drivable roster (`CHAT_DRIVABLE_TOOL_
 *     KINDS`). Every chat-facing field is populated and cross-checked
 *     against a real source (docs, registries, planner code).
 *   - **`"identity"` (48 as FE-T19/T20 left it; 46 post-FE-T09; 41 today —
 *     BKL-176 retired the 5 `payment.charge.*` identity kinds)** — the remaining
 *     kinds. ONLY `kind` / `pack` / `mutating` / `tier` (+
 *     `plannerAdvertisedBy` / `legacyNames` where grounded) are populated —
 *     every other chat-facing field is OMITTED (not merely `undefined`;
 *     the shorter object is the tier's own visual signal). Grounded
 *     STRICTLY in each pack's `*_INTENT_KINDS` groupings (also each pack's
 *     own `intents[]` — byte-identical to the `*_INTENT_KINDS` mirror,
 *     verified) and, for `plannerAdvertisedBy`, each pack's
 *     `capabilities.ts` `CapabilityPlanner.plan()` body (all 6 read in
 *     full for FE-T20) — no fabrication, per the FE-T19 precedent this
 *     ticket extends ("guessing… would be fabrication, not authoring").
 *
 * **FE-T09 (D-a, the amend inversion, post-FE-T20) moved 4 entries between
 * tiers**, the first tier reassignment since FE-T19/T20: `order.amend.
 * request` chat→identity (the model no longer targets it — capabilities.ts
 * routes authenticated amend traffic to the three granular kinds below
 * instead; it keeps `legacyNames: ["amend_order"]`, mirroring the
 * `payment.method.switch`/`payment.retry` precedent, since `ORDER_TOOL_TO_
 * INTENT`/`ORDER_TOOLS.MUTATING` still carry that real entry unchanged) and
 * `order.amend.add_item`/`update_qty`/`remove_item` identity→chat (newly
 * model-proposable, newly registered tools with NO legacy name —
 * `legacyNames: []`, not fabricated). Net: chat 18→20, identity 48→46,
 * total 66. BKL-176 then RETIRED the 5 dead `payment.charge.*` identity kinds
 * → identity 41, total 61.
 *
 * **Declaration order is load-bearing.** Within each pack group the 66
 * entries are declared in EXACTLY that pack's `*_INTENT_KINDS` order (not
 * "chat entries first, identity entries appended") —
 * `generate-pack-intent-kinds.ts` (exports both `generatePackIntents` and
 * `generateIntentKindsMirror`) projects this order byte-for-byte against
 * the committed hand lists. The 18 chat-tier entries
 * keep the exact relative order FE-T19 declared them in (never reordered by
 * this ticket) — every one of them is independently verified to already be
 * a valid subsequence of its pack's canonical order, so the 48 new entries
 * slot in around them without moving anything `generate-chat-drivable-tool-
 * kinds.ts` (FE-T19, untouched by this ticket) already depends on. Pack
 * GROUP order across the whole array mirrors `generate-chat-drivable-tool-
 * kinds.ts`'s own `PACK_GROUP_ORDER` (orders → reservations →
 * customer-onboarding → payments → whatsapp), with `ops` appended last
 * (zero chat-tier entries, so it cannot perturb that generator's output).
 *
 * Grounding for the chat-tier fields (unchanged from FE-T19):
 *
 *   - `kind` / `pack` / `mutating` / `legacyNames` / `description` — cross-
 *     checked against `apps/api/src/tools/register-ibatexas-tool-packs.ts`
 *     (`IBATEXAS_TOOLS`, `IBATEXAS_CAPABILITY_DESCRIPTIONS`) and each
 *     pack's `*_TOOL_TO_INTENT` map in `capabilities.ts`.
 *   - `surfaces` — `["chat"]` for all 20 (18 pre-FE-T09), by construction:
 *     this list IS the chat-drivable roster.
 *   - `auth` — cross-checked against `docs/architecture/design/
 *     agent-tools.md` §"Auth levels" and, where the doc is silent or
 *     stale, each pack's `CapabilityPlanner.plan()` authentication gate
 *     (see per-instance comments below for the non-obvious cases).
 *   - `successClaimLinks` — the FULL inversion of `SUCCESS_CLAIM_CLASSES.
 *     justifiedBy` (`apps/api/src/claustrum/ibatexas-responder.ts`) — every
 *     class that lists this kind, not just one; `undefined` where no class
 *     lists it (a real, common, and correct state; see `types.ts`).
 *   - `guardRefs` — each owning pack's full `stateGuards`/`authGuards`/
 *     `business` guard-name list (see `types.ts` for why this is the
 *     kernel-faithful granularity), EXCLUDING `requireTenantBindingGuard`
 *     (unresolvable today — see `guard-resolution.ts`'s "Known gap").
 *   - `refusalCode` — each pack's `<domain>.default.deny` `basisCodes`
 *     entry.
 *
 * `plannerAdvertisedBy` (FE-T20, both tiers) — see its own doc in
 * `types.ts` for the full contract. As of FE-D28 there is no remaining
 * "registered-but-unadvertised" chat-tier exception: `order.review.submit`
 * was activated by FE-D28 and `whatsapp.handoff.request` by
 * FE-T14/BKL-030-activation. The three ops-foreign-advertised kinds remain.
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
// granularity, not a DRY shortcut of convenience). Only the 18 chat-tier
// instances reference these — `pack-ops` has no chat-tier capability, so
// there is no `OPS_GUARD_REFS` constant.

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
  // BKL-177: the state-phase `requireWindowOpen`, auth-phase
  // `refuseUnprojectedStaffRouting`, and business-phase `validateTemplate` /
  // `sanitizeCustomerToStaff` / `executeMessageSend` / `executeTemplateSend`
  // guards were retired alongside whatsapp.message.send + whatsapp.template.send
  // (the pack's stateGuards phase is now empty; live egress runs through
  // twilio.message.send). The surviving guards below serve the handover /
  // append / handoff-request kinds.
  // authGuards[0] `requireTenantBindingGuard` omitted — see guard-resolution.ts.
  { phase: "business", name: "refuseExcessiveHandoff" },
  { phase: "business", name: "confirmRepeatedHandoff" },
  { phase: "business", name: "executeSessionHandover" },
  { phase: "business", name: "executeConversationAppend" },
  { phase: "business", name: "executeHandoffRequest" },
] as const

// ── The conversation projection's provenance legend (LE2-033) ────────────
//
// Every `conversationTriggers` entry below carries a one-letter tag naming
// where the phrasing CAME FROM. The tag is the review surface: an owner
// reading this file can tell mirrored fact from authored guess at a glance,
// which matters because the third class is the largest and the only one
// nobody has validated against real traffic yet.
//
//   [S] MIRRORED from the capability's authored extraction-schema
//       `example.utterance` (apps/api/src/claustrum/language-engine/
//       *.schema.ts). Verbatim, including case and punctuation — these are
//       already-reviewed production prompt data, and re-typing them would
//       silently fork two copies of the same sentence. Exactly one per
//       capability (each schema authors exactly one example).
//
//   [P] A REAL production utterance, read from the `intent_audit` store.
//       NOT copied mechanically from that store's kind column: the sidecar
//       utterance is stamped per TURN, so it lands on every envelope the
//       turn produced and on the bare "sim" that confirmed it. Each row was
//       re-read and assigned to the capability the SENTENCE expresses,
//       discarding confirmations, farewells, and turn-level co-stamps.
//       (Worked example: 6 of the 7 utterances the store files under
//       `payment.pix.regenerate` are checkout sentences — a checkout
//       EXECUTE also stands up the PIX QR, so the pairing is real but is
//       not evidence about how customers ask to REGENERATE a code.)
//
//       PII-SCRUBBED, and therefore NOT byte-verbatim (unlike [S]): real
//       order ids became `12345` and a real customer's given name became
//       `Fulano`. Production utterances are customer data and a catalog is a
//       committed, widely-read artifact; the retrieval value is in the SHAPE
//       of the request, never in the specific digits. Product names
//       (`Farofa de Bacon Defumado`) and promo codes (`BEMVINDO10`) are the
//       business's own catalog, not personal data, and are kept — they are
//       real customer vocabulary and carry genuine retrieval signal.
//
//   [A] FREELY AUTHORED colloquial paraphrase. This is the register-gap
//       fill LE2-008 measured the need for, and it is the class with no
//       external grounding — authored from the pt-BR a customer plausibly
//       speaks, not observed. Flagged for owner review as a body.
//
// SOURCING BOUNDARY (binding): no phrasing here is drawn from
// `packages/journeys/extraction-corpus` or the extraction-eval fixtures.
// That corpus is LE2-008's hard gate; authoring against it would test-fit
// the gate and destroy the measurement's independence. It was used only as
// a set of QUERIES to score the finished projection. Convergence between an
// authored phrasing and a corpus case is possible — "cancela meu pedido" has
// few natural spellings — but is arrived-at, not copied.
//
// SAFETY BOUNDARY: no phrasing is an allergen or dietary-restriction
// disclosure. See `types.ts`'s `conversationTriggers` doc for why
// (BKL-143 / BKL-123 / BKL-171).

// ── Capability instances ─────────────────────────────────────────────────

export const CAPABILITY_DEFINITIONS: readonly CapabilityDefinition[] = [
  // ── pack-orders (22 — matches ORDER_INTENT_KINDS / ordersPack.intents order) ──
  {
    kind: "order.cart.ensure",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "chat",
    plannerAdvertisedBy: ["ibatexas/pack-orders"],
    surfaces: ["chat"],
    // Always-proposable in `ordersCapabilityPlanner` regardless of
    // `isAuthenticated` — guest cart operations are supported.
    auth: "guest",
    legacyNames: ["get_or_create_cart"],
    description: "Garantir um carrinho ativo para a sessão do cliente.",
    successClaimLinks: undefined,
    conversationTriggers: [
      /* S */ "quero fazer um pedido",
      /* P */ "oi, quero fazer um pedido",
      /* P */ "boa tarde, quero fazer um pedido",
      /* P */ "quero fazer um pedido pra retirada",
      /* P */ "cria um carrinho",
      /* A */ "quero pedir",
      /* A */ "vou querer fazer um pedido",
      /* A */ "quero começar um pedido",
      /* A */ "bora fazer um pedido",
      /* A */ "quero montar meu pedido",
      /* A */ "abre um carrinho pra mim",
      /* A */ "quero comprar alguma coisa",
    ],
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  {
    kind: "order.item.add",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "chat",
    plannerAdvertisedBy: ["ibatexas/pack-orders"],
    surfaces: ["chat"],
    auth: "guest",
    legacyNames: ["add_to_cart"],
    description: "Adicionar um item ao carrinho do cliente.",
    successClaimLinks: ["cart-item-added"],
    conversationTriggers: [
      /* S */ "quero uma coca",
      /* P */ "me ve uma costela bovina defumada",
      /* P */ "adiciona uma farofa ao carrinho",
      /* P */ "adiciona uma linguiça no meu carrinho",
      /* P */ "adiciona uma picanha ao carrinho por favor",
      /* P */ "adiciona 2 costelas no carrinho tambem",
      /* P */ "me vê também uma Farofa de Bacon Defumado e dois Refrigerantes",
      /* A */ "põe uma coca no carrinho",
      /* A */ "me vê um combo",
      /* A */ "quero um refrigerante",
      /* A */ "coloca duas linguiças no carrinho",
      /* A */ "bota mais uma porção de farofa no carrinho",
      /* A */ "adiciona mais uma coquinha",
    ],
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  {
    kind: "order.item.update",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "chat",
    plannerAdvertisedBy: ["ibatexas/pack-orders"],
    surfaces: ["chat"],
    auth: "guest",
    legacyNames: ["update_cart"],
    description: "Atualizar a quantidade de um item no carrinho.",
    successClaimLinks: ["cart-item-added"],
    conversationTriggers: [
      /* S */ "muda a quantidade da coca pra 2",
      /* P */ "muda a costela para 3 unidades",
      /* A */ "deixa 2 unidades da linguiça no carrinho",
      /* A */ "aumenta a quantidade da farofa no carrinho",
      /* A */ "diminui pra uma coca só",
      /* A */ "quero 3 em vez de 2 no carrinho",
      /* A */ "troca a quantidade desse item do carrinho",
      /* A */ "coloca 5 unidades disso no carrinho",
    ],
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  {
    kind: "order.item.remove",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "chat",
    plannerAdvertisedBy: ["ibatexas/pack-orders"],
    surfaces: ["chat"],
    auth: "guest",
    legacyNames: ["remove_from_cart"],
    description: "Remover um item do carrinho do cliente.",
    successClaimLinks: ["cart-item-added"],
    conversationTriggers: [
      /* S */ "tira a coca do carrinho",
      /* P */ "tira a costela do meu carrinho, por favor",
      /* P */ "tira a linguiça do meu carrinho",
      /* P */ "tira o Refrigerante do carrinho",
      /* A */ "tira isso do carrinho",
      /* A */ "remove a farofa do carrinho",
      /* A */ "não quero mais a coca no carrinho",
      /* A */ "apaga esse item do carrinho",
      /* A */ "desisti da picanha, tira do carrinho",
      /* A */ "tira do carrinho por favor",
    ],
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  // FE-T20 identity-tier — never in ORDER_TOOLS/ORDER_TOOL_TO_INTENT, no
  // chat tool, absent from the planner's allowedIntents literal.
  { kind: "order.cart.sync", pack: "ibatexas/pack-orders", mutating: true, tier: "identity" },
  {
    kind: "order.coupon.apply",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "chat",
    plannerAdvertisedBy: ["ibatexas/pack-orders"],
    surfaces: ["chat"],
    auth: "guest",
    legacyNames: ["apply_coupon"],
    description: "Aplicar um cupom de desconto ao carrinho.",
    successClaimLinks: ["coupon-applied"],
    conversationTriggers: [
      /* S */ "aplica o cupom PROMO10",
      /* P */ "tenho um cupom BEMVINDO10, aplica no meu pedido",
      /* A */ "quero usar meu cupom de desconto",
      /* A */ "tenho um cupom de desconto",
      /* A */ "aplica o desconto no carrinho",
      /* A */ "dá pra usar um cupom?",
      /* A */ "coloca o código de desconto",
      /* A */ "tem cupom promocional?",
    ],
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  {
    kind: "order.checkout.create",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "chat",
    plannerAdvertisedBy: ["ibatexas/pack-orders"],
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
    // All three SUCCESS_CLAIM_CLASSES entries that list this kind in
    // justifiedBy: "order-placed" and "purchase-completed" (both a bare
    // checkout completion) plus "pix-generated" (a PIX checkout also
    // stands up the QR code in the same EXECUTE).
    successClaimLinks: ["order-placed", "purchase-completed", "pix-generated"],
    conversationTriggers: [
      /* S */ "quero fechar o pedido, vou pagar no pix, vou retirar no balcão",
      /* P */ "fecha o pedido pra retirada, pago no pix",
      /* P */ "pode fechar o pedido, retiro no local e pago em dinheiro",
      /* P */ "quero finalizar o pedido para retirada, vou pagar com pix",
      /* P */ "vou retirar aí mesmo, pode fechar, pago em dinheiro",
      /* P */ "quero fechar a compra agora e pagar com pix",
      /* P */ "pode finalizar minha compra",
      /* P */ "quero finalizar o pedido",
      /* A */ "pode fechar",
      /* A */ "quero pagar agora",
      /* A */ "finaliza o pedido",
      /* A */ "vamos fechar a conta",
    ],
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  { kind: "order.pix.details.set", pack: "ibatexas/pack-orders", mutating: true, tier: "identity" },
  {
    kind: "order.cancel",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "chat",
    plannerAdvertisedBy: ["ibatexas/pack-orders"],
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["cancel_order"],
    description: "Cancelar um pedido do cliente (irreversível).",
    successClaimLinks: ["order-canceled"],
    conversationTriggers: [
      /* S */ "cancela meu pedido, por favor, mudei de ideia",
      /* P */ "cancela meu pedido",
      /* P */ "quero cancelar meu pedido",
      /* P */ "cancela o pedido 4 aí que mudei de ideia",
      /* P */ "quero cancelar o pedido 12345 e receber meu dinheiro de volta",
      /* A */ "desisti do pedido",
      /* A */ "não quero mais o pedido",
      /* A */ "anula meu pedido",
      /* A */ "quero desfazer a compra",
      /* A */ "cancela tudo, mudei de ideia",
    ],
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
    // FE-T23: verbatim from apps/admin's committed INTENT_KIND_LABELS —
    // deliberately different text from `description` above (separate
    // audience: admin-inbox operator vs. chat prompt hint).
    adminLabel: "Cancelar pedido",
    // FE-T24: a member of BKL-096's FORBIDDEN_OPS_DESTRUCTIVE_KINDS — this
    // customer/LLM-chat-drivable kind must ALSO never be ops-plane
    // advertised (the ops persona's own kitchen-advance projection,
    // order.status.transition, is BKL-090-legality-gated to non-terminal
    // transitions specifically so it can never reach a force-cancel).
    opsForbiddenDestructive: true,
  },
  // SYSTEM-only compensation cancel (payment-expiry / stale-order) — the
  // orders planner comment is explicit: "NEVER LLM-proposable". No
  // plannerAdvertisedBy by construction, not by omission.
  // FE-T09 (D-a, the amend inversion) — `order.amend.request` moved OUT of
  // the chat tier: the model no longer targets it (capabilities.ts's
  // authenticated `allowedIntents` now lists the three granular kinds
  // below instead), so it loses `plannerAdvertisedBy` along with every
  // other chat-facing field. It stays a real, adjudicable pack intent (the
  // deterministic legacy HTTP amend route still builds it directly) and
  // KEEPS `legacyNames: ["amend_order"]` — the same narrow, structurally-
  // grounded exception `types.ts` documents for `payment.method.switch` /
  // `payment.retry`: `ORDER_TOOL_TO_INTENT` and `ORDER_TOOLS.MUTATING`
  // (packages/pack-orders/src/capabilities.ts) still carry a real
  // `amend_order` entry unchanged, so dropping it here would make the
  // freshness-gate projections silently diverge from those hand-authored
  // maps rather than reflect reality. Also KEEPS `successClaimLinks:
  // ["order-amended"]` (FE-T22's own grounding, ibatexas-responder.ts's
  // real justifiedBy array lists all 4 order.amend.* kinds, not just the
  // 3 granular ones) — `successClaimLinks` is optional on BOTH tiers
  // (types.ts), so demoting the chat-facing fields does not require
  // dropping this one; capability-definitions.success-claim-round-trip.
  // test.ts's round-trip fidelity check would otherwise under-count
  // "order-amended"'s real justifiedBy set by one member.
  {
    kind: "order.amend.request",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "identity",
    legacyNames: ["amend_order"],
    successClaimLinks: ["order-amended"],
  },
  // FE-T09 (D-a) — the three granular kinds became the model targets,
  // moving from identity→chat (net, with order.amend.request's move out,
  // CHAT_DRIVABLE goes 18→20). `legacyNames: []` (not `["amend_order"]`,
  // not fabricated): these are brand-new tools born under the
  // `capability === intentKind` convention — no pre-refactor snake_case
  // name exists to ground one, so `generateToolToIntentMap`/
  // `generateMutatingToolNames` correctly contribute nothing for them and
  // `ORDER_TOOL_TO_INTENT`/`ORDER_TOOLS.MUTATING` need no new entries.
  {
    kind: "order.amend.add_item",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "chat",
    plannerAdvertisedBy: ["ibatexas/pack-orders"],
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: [],
    description: "Adicionar um item a um pedido já feito (pós-checkout).",
    successClaimLinks: ["order-amended"],
    conversationTriggers: [
      /* S */ "adiciona uma coca no meu pedido",
      /* P */ "adiciona uma coca no pedido que já fiz",
      /* P */ "coloca mais uma farofa no pedido que já fiz",
      /* P */ "põe mais um refrigerante no meu pedido",
      /* P */ "quero adicionar um refrigerante no pedido que eu já fiz",
      /* P */ "adiciona uma Mandioca Frita no meu pedido",
      /* A */ "esqueci de pedir uma coca, adiciona no pedido",
      /* A */ "dá pra incluir mais um item no pedido que já fiz?",
      /* A */ "acrescenta no pedido já feito",
      /* A */ "quero adicionar algo ao pedido que já paguei",
      /* A */ "dá pra acrescentar mais uma coisa no pedido 12345?",
      /* A */ "por favor, inclua mais um item no pedido 12345",
    ],
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  {
    kind: "order.amend.update_qty",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "chat",
    plannerAdvertisedBy: ["ibatexas/pack-orders"],
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: [],
    description: "Alterar a quantidade de um item em um pedido já feito (pós-checkout).",
    successClaimLinks: ["order-amended"],
    conversationTriggers: [
      /* S */ "muda a quantidade do hambúrguer pra 2",
      /* A */ "muda a quantidade no pedido que já fiz",
      /* A */ "aumenta pra 3 no pedido já feito",
      /* A */ "no pedido que já fiz, deixa 2 unidades",
      /* A */ "quero mudar a quantidade do pedido já pago",
      /* A */ "altera a quantidade no pedido que fechei",
      /* A */ "diminui a quantidade no pedido já realizado",
      /* A */ "dá pra mudar a quantidade do meu pedido?",
      /* A */ "por gentileza, altere a quantidade do pedido 12345",
      /* A */ "sobre o pedido 12345, quero corrigir a quantidade",
      /* A */ "quero corrigir a quantidade, por favor",
    ],
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  {
    kind: "order.amend.remove_item",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "chat",
    plannerAdvertisedBy: ["ibatexas/pack-orders"],
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: [],
    description: "Remover um item de um pedido já feito (pós-checkout).",
    successClaimLinks: ["order-amended"],
    conversationTriggers: [
      /* S */ "tira a coca do meu pedido",
      /* P */ "tira a Farofa de Bacon Defumado do meu pedido",
      /* P */ "tira a sobremesa do pedido 12345 que eu acabei de pagar",
      /* P */ "tira o Refrigerante do pedido",
      /* P */ "tira a Mandioca Frita do meu pedido",
      /* A */ "remove um item do pedido que já fiz",
      /* A */ "tira isso do pedido já feito",
      /* A */ "não quero mais esse item no pedido que fiz",
      /* A */ "quero tirar um item do pedido já pago",
      /* A */ "dá pra tirar um item do meu pedido?",
      /* A */ "por favor, remova um item do pedido 12345",
    ],
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  // Rebase note (FE-T09 onto dev post-FE-T22): FE-T22 (merged to dev while
  // #264 was in review) independently enriched the THEN-identity-tier bare
  // entries for these same three kinds with `successClaimLinks:
  // ["order-amended"]` — the same grounding fact this PR's chat-tier
  // entries above already carry. No duplicate identity-tier entries were
  // reintroduced here; a duplicate `kind` would double-count these three in
  // the 66-total and desync `generatePackIntents`'s declaration-order mirror
  // of `ordersPack.intents[]`.
  { kind: "order.address.change", pack: "ibatexas/pack-orders", mutating: true, tier: "identity", successClaimLinks: ["address-updated"] },
  { kind: "order.type.switch", pack: "ibatexas/pack-orders", mutating: true, tier: "identity", successClaimLinks: ["order-amended"] },
  {
    kind: "order.note.add",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "chat",
    // BOTH: pack-orders' own planner advertises it to authenticated
    // customers AND pack-ops' planner advertises it (foreign-owned, widens
    // the staff/ops allowlist) — see types.ts `plannerAdvertisedBy` doc.
    plannerAdvertisedBy: ["ibatexas/pack-orders", "ibatexas/pack-ops"],
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["add_order_note"],
    description: "Adicionar uma observação a um pedido.",
    successClaimLinks: ["note-added"],
    conversationTriggers: [
      /* S */ "adiciona uma observação no meu pedido: sem cebola, por favor",
      /* P */ "adiciona uma observação no pedido 12345: cliente chega às 20h",
      /* P */ "anota no meu pedido que o cliente vai atrasar",
      /* P */ "adiciona outra observação: cliente prefere pagar em dinheiro",
      /* A */ "anota que é sem cebola",
      /* A */ "põe uma observação no pedido",
      /* A */ "avisa a cozinha que é sem pimenta",
      /* A */ "deixa um recado no pedido",
      /* A */ "quero deixar uma observação",
    ],
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
    // FE-T23: verbatim from apps/admin's committed INTENT_KIND_LABELS.
    adminLabel: "Adicionar observação ao pedido",
  },
  {
    kind: "order.review.submit",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "chat",
    // FE-D28 — review-by-chat activated. `ordersCapabilityPlanner.allowedIntents`
    // now advertises it to authenticated customers (capabilities.ts): the
    // resolver stamps the Identity-class orderId (resolveCustomerOrderReference)
    // + productId (from the reviewed order's line items), so the model only ever
    // emits rating/comment + the NL item/orderReference references
    // (order-note-review.schema.ts). Reviews still ALSO arrive via the web flow
    // (me.ts POST /api/me/reviews).
    plannerAdvertisedBy: ["ibatexas/pack-orders"],
    // `auth` reflects `docs/architecture/design/agent-tools.md`
    // (`submit_review` → customer), the capability's DECLARED auth requirement.
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["submit_review"],
    description: "Enviar uma avaliação de um pedido concluído.",
    successClaimLinks: ["review-received"],
    conversationTriggers: [
      /* S */ "dou 5 estrelas pro pedido, chegou rapidinho e quentinho",
      /* P */ "quero avaliar meu pedido: 5 estrelas, comida excelente",
      /* P */ "quero avaliar o pedido 12345: 5 estrelas",
      /* A */ "quero deixar uma avaliação",
      /* A */ "nota 5 pro pedido",
      /* A */ "adorei a comida, quero avaliar",
      /* A */ "quero dar minha opinião sobre o pedido",
      /* A */ "vou avaliar o atendimento do pedido",
    ],
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  // LE2-020 — the first member of the WORKFLOW-SCOPED ACCESS CLASS (LE2
  // Implementation Decision 15: "the reorder orchestration becomes
  // journey-invocable … standalone reordering rides the reorder-last journey").
  // Reordering is orchestration-shaped: as a free verb it silently replaces a
  // customer's cart with a copy of an old order, which is why no planner has
  // ever advertised it and its real handler (`reorder` in `@ibatexas/tools`) has
  // never been registered. `workflowScoped: true` turns that de-facto state into
  // a DECLARED, enforced one — the planner now subtracts it structurally rather
  // than it merely happening to be absent from every planner's roster.
  //
  // Zero behaviour change today: the kind was already unadvertised and had no
  // registered tool, and v0 ships no workflow that invokes it (see
  // `../workflows/definitions.ts`).
  { kind: "order.reorder", pack: "ibatexas/pack-orders", mutating: true, tier: "identity", successClaimLinks: ["order-placed"], workflowScoped: true },
  { kind: "order.projection.create", pack: "ibatexas/pack-orders", mutating: true, tier: "identity" },
  // Ops-foreign-advertised ONLY (BKL-090): absent from orders' OWN planner
  // literal — verified — advertised solely via pack-ops' staff allowlist.
  {
    kind: "order.status.transition",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "identity",
    plannerAdvertisedBy: ["ibatexas/pack-ops"],
    // FE-T23: verbatim from apps/admin's committed INTENT_KIND_LABELS.
    adminLabel: "Avançar status do pedido",
  },
  { kind: "order.status.reconcile", pack: "ibatexas/pack-orders", mutating: true, tier: "identity" },
  // NEW-014 — fiscal (NFC-e/NFe) emission. SYSTEM-only (subscriber-emitted on
  // order delivery); never LLM-proposable → plannerAdvertisedBy stays undefined.
  { kind: "order.fiscal.emit", pack: "ibatexas/pack-orders", mutating: true, tier: "identity", successClaimLinks: ["fiscal-emitted"] },

  // ── pack-reservations (8 — matches RESERVATION_INTENT_KINDS / reservationsPack.intents order) ──
  {
    kind: "reservation.create",
    pack: "ibatexas/pack-reservations",
    mutating: true,
    tier: "chat",
    plannerAdvertisedBy: ["ibatexas/pack-reservations"],
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["create_reservation"],
    description: "Criar uma reserva de mesa.",
    successClaimLinks: ["reservation-confirmed"],
    conversationTriggers: [
      /* S */ "quero uma mesa pra 4 pessoas dia 20/03 às 20h",
      /* P */ "Quero reservar uma mesa para 4 pessoas amanhã às 19h",
      /* P */ "quero reservar uma mesa para 4 pessoas hoje as 20h, meu nome e Fulano",
      /* A */ "quero reservar uma mesa",
      /* A */ "tem mesa pra hoje à noite?",
      /* A */ "queria marcar uma mesa pra 6 pessoas",
      /* A */ "dá pra reservar pra sábado?",
      /* A */ "quero fazer uma reserva",
    ],
    guardRefs: RESERVATIONS_GUARD_REFS,
    refusalCode: "reservation.default.deny",
  },
  {
    kind: "reservation.modify",
    pack: "ibatexas/pack-reservations",
    mutating: true,
    tier: "chat",
    plannerAdvertisedBy: ["ibatexas/pack-reservations"],
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["modify_reservation"],
    description: "Modificar uma reserva existente.",
    successClaimLinks: ["reservation-confirmed"],
    conversationTriggers: [
      /* S */ "muda minha reserva pra sexta, dia 20/03, às 20h",
      /* P */ "muda minha reserva de hoje pra 20h",
      /* P */ "muda minha reserva para 6 pessoas",
      /* P */ "vamos ser 6 em vez de 4 na minha reserva",
      /* A */ "quero mudar o horário da minha reserva",
      /* A */ "dá pra adiar minha reserva?",
      /* A */ "muda a reserva pra mais tarde",
      /* A */ "quero alterar minha reserva",
    ],
    guardRefs: RESERVATIONS_GUARD_REFS,
    refusalCode: "reservation.default.deny",
  },
  {
    kind: "reservation.cancel",
    pack: "ibatexas/pack-reservations",
    mutating: true,
    tier: "chat",
    plannerAdvertisedBy: ["ibatexas/pack-reservations"],
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["cancel_reservation"],
    description: "Cancelar uma reserva existente.",
    // No "reservation-canceled" class exists in SUCCESS_CLAIM_CLASSES today
    // (only "order-canceled" does) — genuinely undefined, not an omission.
    successClaimLinks: ["reservation-canceled"],
    conversationTriggers: [
      /* S */ "cancela minha reserva, surgiu um imprevisto",
      /* P */ "cancela minha reserva",
      /* P */ "quero cancelar minha reserva das 18:30",
      /* P */ "cancela minha reserva de hoje",
      /* A */ "não vou poder ir, cancela a reserva",
      /* A */ "desmarca minha reserva",
      /* A */ "quero desmarcar a mesa",
      /* A */ "cancela a mesa que reservei",
    ],
    guardRefs: RESERVATIONS_GUARD_REFS,
    refusalCode: "reservation.default.deny",
  },
  // Staff-plane kinds — reservations' OWN planner advertises both ONLY on
  // a staff session (`isStaffSession`), never to a customer.
  {
    kind: "reservation.checkin",
    pack: "ibatexas/pack-reservations",
    mutating: true,
    tier: "identity",
    plannerAdvertisedBy: ["ibatexas/pack-reservations"],
    // FE-T22: a real justifiedBy member of "reservation-confirmed"
    // (ibatexas-responder.ts), grounded from that real export.
    successClaimLinks: ["reservation-confirmed"],
  },
  {
    kind: "reservation.complete",
    pack: "ibatexas/pack-reservations",
    mutating: true,
    tier: "identity",
    plannerAdvertisedBy: ["ibatexas/pack-reservations"],
    successClaimLinks: ["reservation-confirmed"],
  },
  // SYSTEM-only (cron) — never in the planner's allowedIntents.
  { kind: "reservation.no_show.mark", pack: "ibatexas/pack-reservations", mutating: true, tier: "identity" },
  {
    kind: "reservation.waitlist.join",
    pack: "ibatexas/pack-reservations",
    mutating: true,
    tier: "chat",
    plannerAdvertisedBy: ["ibatexas/pack-reservations"],
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["join_waitlist"],
    description: "Entrar na lista de espera de um horário lotado.",
    successClaimLinks: undefined,
    conversationTriggers: [
      /* S */ "coloca eu na lista de espera daquele horário, somos 4",
      /* A */ "me põe na lista de espera",
      /* A */ "quero entrar na fila de espera",
      /* A */ "se vagar uma mesa me avisa",
      /* A */ "entra na espera pra mim",
      /* A */ "quero ficar na lista de espera",
      /* A */ "tá lotado, me coloca na espera",
    ],
    guardRefs: RESERVATIONS_GUARD_REFS,
    refusalCode: "reservation.default.deny",
  },
  // SYSTEM-only (cron: waitlist-spot notification) — never in the
  // planner's allowedIntents.

  // ── pack-customer-onboarding (8 — matches CUSTOMER_ONBOARDING_INTENT_KINDS / customerOnboardingPack.intents order) ──
  // SYSTEM-only (OTP-flow seed) — never in the planner's allowedIntents.
  { kind: "customer.create", pack: "ibatexas/pack-customer-onboarding", mutating: true, tier: "identity" },
  // Web/admin-only, no LLM tool — never in the planner's allowedIntents.
  { kind: "customer.profile.update", pack: "ibatexas/pack-customer-onboarding", mutating: true, tier: "identity" },
  {
    kind: "customer.preferences.update",
    pack: "ibatexas/pack-customer-onboarding",
    mutating: true,
    tier: "chat",
    plannerAdvertisedBy: ["ibatexas/pack-customer-onboarding"],
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["update_preferences"],
    description: "Atualizar as preferências do cliente.",
    successClaimLinks: ["preferences-saved"],
    conversationTriggers: [
      /* S */ "sou vegetariano e adoro comida grelhada",
      /* A */ "sou vegetariano",
      /* A */ "não como carne vermelha",
      /* A */ "prefiro comida sem pimenta",
      /* A */ "gosto de comida bem apimentada",
      /* A */ "atualiza minhas preferências",
      /* A */ "quero mudar minhas preferências",
      /* A */ "minha comida favorita é churrasco",
    ],
    guardRefs: CUSTOMER_ONBOARDING_GUARD_REFS,
    refusalCode: "customer.default.deny",
  },
  {
    kind: "customer.pix.details.save",
    pack: "ibatexas/pack-customer-onboarding",
    mutating: true,
    tier: "chat",
    plannerAdvertisedBy: ["ibatexas/pack-customer-onboarding"],
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["save_pix_details"],
    description: "Salvar os dados PIX do cliente para reembolsos.",
    successClaimLinks: undefined,
    conversationTriggers: [
      /* S */ "meu nome é João Silva, email joao@example.com, cpf 123.456.789-00",
      /* A */ "quero salvar meus dados do pix",
      /* A */ "guarda meus dados pra reembolso",
      /* A */ "minha chave pix é meu cpf",
      /* A */ "quero cadastrar minha chave pix",
      /* A */ "salva meus dados bancários pro estorno",
      /* A */ "anota meus dados pra devolução do dinheiro",
    ],
    guardRefs: CUSTOMER_ONBOARDING_GUARD_REFS,
    refusalCode: "customer.default.deny",
  },
  // Web-only, no LLM tool — never in the planner's allowedIntents.
  { kind: "customer.address.add", pack: "ibatexas/pack-customer-onboarding", mutating: true, tier: "identity", successClaimLinks: ["address-updated"] },
  { kind: "customer.address.remove", pack: "ibatexas/pack-customer-onboarding", mutating: true, tier: "identity", successClaimLinks: ["address-updated"] },
  // HTTP-only (task 14 routes) — the destructive flow is NEVER LLM-callable;
  // the planner omits it from allowedIntents regardless of state.
  { kind: "customer.anonymize", pack: "ibatexas/pack-customer-onboarding", mutating: true, tier: "identity", successClaimLinks: ["data-anonymized"] },
  { kind: "customer.anonymize.cancel", pack: "ibatexas/pack-customer-onboarding", mutating: true, tier: "identity" },

  // ── pack-payments (12 — matches PAYMENT_INTENT_KINDS / paymentsPack.intents order) ──
  // Webhook/system-originated — never in the planner's allowedIntents
  // (module doc: "most payment operations are NOT LLM-proposable").
  // BKL-176 (2026-07-18) — the 5 dead `payment.charge.*` kinds were RETIRED
  // (zero-emitter sweep): a governance-only SHADOW of the live `payment.create`
  // / `payment.status.*` taxonomy with no emitter or executor anywhere
  // (`payment.charge.create` even self-documented as an alias of
  // `payment.create`). `payment.charge.confirm` was the only removed
  // `payment-settled` success-claim justifier — the remaining (still zero-
  // emitter, so anti-confabulation-safe) justifier is `payment.cash.confirm`
  // below; nothing was repointed onto the direction-agnostic
  // `payment.status.reconcile`, which handles refunds too and would break
  // `payment-settled`'s refund-direction exclusion (CLAUDE.md).
  { kind: "payment.create", pack: "ibatexas/pack-payments", mutating: true, tier: "identity" },
  {
    kind: "payment.pix.regenerate",
    pack: "ibatexas/pack-payments",
    mutating: true,
    tier: "chat",
    plannerAdvertisedBy: ["ibatexas/pack-payments"],
    surfaces: ["chat"],
    auth: "customer",
    legacyNames: ["regenerate_pix"],
    description: "Gerar um novo código PIX para um pagamento pendente.",
    successClaimLinks: ["pix-generated"],
    conversationTriggers: [
      /* S */ "o código pix expirou, gera outro pra mim",
      /* P */ "o QR code do pix expirou, gera outro pra mim",
      /* A */ "gera um novo pix",
      /* A */ "o pix venceu, manda outro",
      /* A */ "manda o código pix de novo",
      /* A */ "preciso de outro qr code",
      /* A */ "o qr code não funciona, gera de novo",
      /* A */ "quero um pix novo pra pagar",
    ],
    guardRefs: PAYMENTS_GUARD_REFS,
    refusalCode: "payment.default.deny",
    // FE-T23: verbatim from apps/admin's committed INTENT_KIND_LABELS.
    adminLabel: "Regenerar cobrança PIX",
  },
  // De-advertised (P0-7): mapped + MUTATING-classified but NOT in the
  // planner's `allowedIntents` literal — no chat tool is registered for
  // either, so advertising would let the planner propose an envelope no
  // tool can dispatch. WS4 backlog restores their planner entry.
  //
  // FE-T21: `legacyNames` IS populated here (the one common-base field an
  // identity-tier instance may optionally carry — see types.ts) — both
  // have a REAL entry in `PAYMENT_TOOL_TO_INTENT`
  // (packages/pack-payments/src/capabilities.ts), de-advertised, not
  // un-named.
  { kind: "payment.method.switch", pack: "ibatexas/pack-payments", mutating: true, tier: "identity", legacyNames: ["switch_payment_method"], successClaimLinks: ["payment-method-switched"] },
  { kind: "payment.retry", pack: "ibatexas/pack-payments", mutating: true, tier: "identity", legacyNames: ["retry_payment"] },
  // Ops-foreign-advertised ONLY (BKL-085): absent from payments' OWN
  // planner literal — verified (only payment.pix.regenerate is there) —
  // advertised solely via pack-ops' staff allowlist.
  {
    kind: "payment.refund.issue",
    pack: "ibatexas/pack-payments",
    mutating: true,
    tier: "identity",
    plannerAdvertisedBy: ["ibatexas/pack-ops"],
    // FE-T22: a real justifiedBy member of "refund-done"
    // (ibatexas-responder.ts) alongside payment.refund.confirm below —
    // grounded from that real export, not invented.
    successClaimLinks: ["refund-done"],
    // FE-T23: verbatim from apps/admin's committed INTENT_KIND_LABELS.
    adminLabel: "Emitir reembolso",
  },
  // Staff-route / webhook-originated — never in the planner's allowedIntents.
  {
    kind: "payment.refund.confirm",
    pack: "ibatexas/pack-payments",
    mutating: true,
    tier: "identity",
    successClaimLinks: ["refund-done"],
    // FE-T23: verbatim from apps/admin's committed INTENT_KIND_LABELS.
    adminLabel: "Confirmar reembolso",
  },
  { kind: "payment.dispute.open", pack: "ibatexas/pack-payments", mutating: true, tier: "identity" },
  { kind: "payment.cash.confirm", pack: "ibatexas/pack-payments", mutating: true, tier: "identity", successClaimLinks: ["payment-settled"] },
  // FE-T24: both members of BKL-096's FORBIDDEN_OPS_DESTRUCTIVE_KINDS —
  // OWNER-gated irreversible writes (debt write-off / status-lifecycle
  // bypass) that must never be ops-plane advertised.
  {
    kind: "payment.waive",
    pack: "ibatexas/pack-payments",
    mutating: true,
    tier: "identity",
    opsForbiddenDestructive: true,
  },
  {
    kind: "payment.status.force",
    pack: "ibatexas/pack-payments",
    mutating: true,
    tier: "identity",
    opsForbiddenDestructive: true,
  },
  { kind: "payment.status.transition", pack: "ibatexas/pack-payments", mutating: true, tier: "identity" },
  { kind: "payment.status.reconcile", pack: "ibatexas/pack-payments", mutating: true, tier: "identity" },

  // ── pack-whatsapp (3 — matches WHATSAPP_INTENT_KINDS / whatsappPack.intents order) ──
  // BKL-177: whatsapp.message.send + whatsapp.template.send RETIRED (dead
  // duplicates with no emitter; live WhatsApp egress runs through
  // twilio.message.send, packages/tools/src/twilio). The surviving kinds are
  // subscriber/system-emitted (session.handover / conversation.append) or the
  // customer-proposable whatsapp.handoff.request.
  { kind: "whatsapp.session.handover", pack: "ibatexas/pack-whatsapp", mutating: true, tier: "identity" },
  { kind: "conversation.message.append", pack: "ibatexas/pack-whatsapp", mutating: true, tier: "identity" },
  {
    kind: "whatsapp.handoff.request",
    pack: "ibatexas/pack-whatsapp",
    mutating: true,
    tier: "chat",
    // FE-T14 (BKL-030-activation): previously registered-but-unadvertised
    // (the whatsapp planner's `allowedIntents` was `[]` for EVERY session
    // context). Now advertised unconditionally — see capabilities.ts's own
    // module doc — the one guest-accessible, always-allowed verb in the
    // roster.
    plannerAdvertisedBy: ["ibatexas/pack-whatsapp"],
    surfaces: ["chat"],
    // The one guest-accessible tool in the roster —
    // `docs/architecture/design/agent-tools.md`'s `handoff_to_human` entry:
    // "Auth: guest".
    auth: "guest",
    legacyNames: ["request_human_handoff"],
    description:
      "Transferir o atendimento para um atendente humano quando o cliente pedir para falar com uma pessoa.",
    successClaimLinks: undefined,
    conversationTriggers: [
      /* S */ "quero falar com uma pessoa, meu pedido não chegou",
      /* P */ "me passa pra um humano",
      /* P */ "quero falar com um atendente",
      /* P */ "quero falar com um atendente de verdade",
      /* A */ "quero falar com alguém de verdade",
      /* A */ "me transfere pra um atendente",
      /* A */ "chama um humano",
      /* A */ "não quero falar com robô",
      /* A */ "quero suporte humano",
      /* A */ "preciso falar com o gerente",
    ],
    guardRefs: WHATSAPP_GUARD_REFS,
    refusalCode: "whatsapp.default.deny",
  },

  // ── pack-ops (6 — matches OPS_INTENT_KINDS / opsPack.intents order; zero chat-tier) ──
  // All 6 are OWNED by pack-ops and advertised by its OWN planner ONLY on
  // a staff session (`isStaffSession`) — Chat-INVISIBLE by construction
  // (never in CHAT_DRIVABLE_TOOL_KINDS), so every instance is
  // `tier: "identity"`.
  {
    kind: "product.availability.set",
    pack: "ibatexas/pack-ops",
    mutating: true,
    tier: "identity",
    plannerAdvertisedBy: ["ibatexas/pack-ops"],
    // FE-T23: verbatim from apps/admin's committed INTENT_KIND_LABELS.
    adminLabel: "Disponibilidade de item (86 / liberar)",
  },
  {
    kind: "product.price.set",
    pack: "ibatexas/pack-ops",
    mutating: true,
    tier: "identity",
    plannerAdvertisedBy: ["ibatexas/pack-ops"],
    // FE-T23: verbatim from apps/admin's committed INTENT_KIND_LABELS.
    adminLabel: "Alterar preço de item",
  },
  {
    kind: "menu.special.set",
    pack: "ibatexas/pack-ops",
    mutating: true,
    tier: "identity",
    plannerAdvertisedBy: ["ibatexas/pack-ops"],
  },
  {
    kind: "ops.alert.resolve.staff",
    pack: "ibatexas/pack-ops",
    mutating: true,
    tier: "identity",
    plannerAdvertisedBy: ["ibatexas/pack-ops"],
  },
  {
    kind: "incident.ticket.close.staff",
    pack: "ibatexas/pack-ops",
    mutating: true,
    tier: "identity",
    plannerAdvertisedBy: ["ibatexas/pack-ops"],
  },
  {
    kind: "schedule.override.set",
    pack: "ibatexas/pack-ops",
    mutating: true,
    tier: "identity",
    plannerAdvertisedBy: ["ibatexas/pack-ops"],
  },
] as const
