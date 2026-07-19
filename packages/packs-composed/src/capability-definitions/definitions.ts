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
    successClaimLinks: undefined,
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
  { kind: "order.address.change", pack: "ibatexas/pack-orders", mutating: true, tier: "identity" },
  { kind: "order.type.switch", pack: "ibatexas/pack-orders", mutating: true, tier: "identity" },
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
    successClaimLinks: undefined,
    guardRefs: ORDERS_GUARD_REFS,
    refusalCode: "order.default.deny",
  },
  { kind: "order.reorder", pack: "ibatexas/pack-orders", mutating: true, tier: "identity" },
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
  { kind: "order.fiscal.emit", pack: "ibatexas/pack-orders", mutating: true, tier: "identity" },

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
    successClaimLinks: undefined,
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
    successClaimLinks: undefined,
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
    guardRefs: CUSTOMER_ONBOARDING_GUARD_REFS,
    refusalCode: "customer.default.deny",
  },
  // Web-only, no LLM tool — never in the planner's allowedIntents.
  { kind: "customer.address.add", pack: "ibatexas/pack-customer-onboarding", mutating: true, tier: "identity" },
  { kind: "customer.address.remove", pack: "ibatexas/pack-customer-onboarding", mutating: true, tier: "identity" },
  // HTTP-only (task 14 routes) — the destructive flow is NEVER LLM-callable;
  // the planner omits it from allowedIntents regardless of state.
  { kind: "customer.anonymize", pack: "ibatexas/pack-customer-onboarding", mutating: true, tier: "identity" },
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
  { kind: "payment.method.switch", pack: "ibatexas/pack-payments", mutating: true, tier: "identity", legacyNames: ["switch_payment_method"] },
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
