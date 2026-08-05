/**
 * Policy-pack composition — the SINGLE source of the post-prepend pack list.
 *
 * The kernel adjudicates each intent against its owning pack's PolicyBundle,
 * but ibatexas prepends ADOPTER-LEVEL guards to every pack at composition:
 *
 *   business phase — the F4 session token-budget guard (REFUSE over budget /
 *   ADR-120) and the confirm-on-autoresolve guard (REQUEST_CONFIRMATION when
 *   an ambiguous money/booking target was auto-resolved).
 *
 *   auth phase (T3-4) — the managed-agent scope guard (REFUSE
 *   `agent_scope_violation` for `agent:`-namespaced envelopes outside the
 *   agent's declared kinds), the per-agent over-budget ESCALATE guards, and the
 *   staff-plane per-role capability guard (BKL-069 Part C — REFUSE
 *   `staff_role_violation` for `admin:`-namespaced envelopes whose role is
 *   absent / unknown / not permitted for the kind, or whose kind is off the
 *   staff verb surface). These MUST sit in AUTH, not business: the kernel
 *   evaluates state → taint → auth → business, and `confirmOnAutoResolveGuard`
 *   is prepended to business — a business-phase scope/role guard would let an
 *   out-of-scope money kind short-circuit into REQUEST_CONFIRMATION before
 *   it could REFUSE (plan-v2 §9, governance critic).
 *
 * None of these guards are in any published `@ibatexas/pack-*`; they live
 * only here (the agent factories in ./agent-guards.ts).
 *
 * Both the production router (`claustrum-bootstrap` → `composePolicyRouter`)
 * AND the policy-manifest exporter (`policy-manifest-export`) consume
 * `buildIbatexasPolicyPacks` so the manifest describes EXACTLY the bundles the
 * kernel runs — it cannot drift from production. Pure (no I/O), so the CLI /
 * exporter can import it without booting the conductor.
 */

import { basis, BASIS_CODES, decisionRefuse, refuse, type PackV0 } from "@adjudicate/core";
import { nameGuard, type Guard, type PolicyBundle } from "@adjudicate/core/kernel";
import { createTokenBudgetGuard, createConfirmGuard } from "@adjudicate/primitives";
import { AGENT_REGISTRY } from "@ibatexas/agents";
import {
  createAgentBudgetGuards,
  createAgentKillSwitchGuard,
  createAgentScopeGuard,
} from "./agent-guards.js";
import {
  orderStatusTransitionBandGuard,
  paymentTransitionBandGuard,
  staffRoleGuard,
} from "./staff-role-guard.js";
// R3-S2 — the DECLARED resolver→guard signal contract. Each adopter guard below
// reads its ctx signal through this ONE declaration instead of re-stating the
// shape in an inline `state as { ctx?: { … } }` cast. Both ends of the channel now
// name the key through the same constant, so a rename breaks the stamp site AND
// the read at tsc; before it, a typo on either end compiled clean and the guard
// silently PASSED (absent key = null = pass).
import {
  ALLERGEN_MENTION_DETECTED,
  AMEND_ITEM_UNRESOLVED,
  AUTO_RESOLVED_MONEY_REF,
  REVIEW_PRODUCT_UNRESOLVED,
  SESSION_TOKENS_CONSUMED,
  readResolutionSignal,
  resolutionSignalIsSet,
} from "./resolution-signals.js";
// R3-S3 — the per-kind profile table. `AUTORESOLVE_CONFIRM_KINDS` is a DERIVED
// view of it (the rows with `confirmOnAutoResolve: true`), replacing the
// hand-written set this file used to carry. Imported rather than re-exported
// straight through, because `confirmOnAutoResolveGuard` below needs the local
// binding; the `export` beside the guard keeps every existing importer working.
// The table module deliberately has no runtime dependency on the 2.8k-line
// resolver, so importing it here does not pull the resolver's domain services /
// Redis / Medusa graph into policy composition — the same discipline
// `resolution-signals.ts` was built with.
import { AUTORESOLVE_CONFIRM_KINDS } from "./kind-resolution-profiles.js";

/** A first-party pack with its K/P/S/C generics erased for heterogeneous storage. */
export type ErasedPack = PackV0<string, unknown, unknown, unknown>;

// ── Session token-budget guard (F4, cost cap / ADR-120) ─────────────────────
// Per-session cumulative LLM-cost cap. LIVE: both sides are wired.
//  WRITE — `emitTurn` folds each turn's planning+synthesis token total (summed
//    onto the TurnRecord by claustrum's loop) into `rk('llm:tokens:…')`.
//  READ  — the pre-adjudication resolve stage (claustrum/resolve-and-assemble.ts)
//    reads that counter back into `state.ctx.sessionTokensConsumed` for EVERY
//    envelope, so the guard below — prepended to every pack's business phase —
//    sees a real total. Enforcement is a config flip (AGENT_SESSION_TOKEN_BUDGET).
// REFUSE (never DEFER — DEFER would park a money intent on a reset signal nobody emits).
export const SESSION_TOKEN_BUDGET = Number.parseInt(
  process.env.AGENT_SESSION_TOKEN_BUDGET ?? "100000",
  10,
);

export const sessionTokenBudgetGuard = nameGuard(
  "sessionTokenBudget",
  createTokenBudgetGuard<string, unknown, unknown>({
    // `?? 0` kept verbatim: this signal is the one THRESHOLD, and its absent-key
    // direction is fail-OPEN at zero (a Redis hiccup must never REFUSE a turn),
    // not the honesty floors' "not true ⇒ pass".
    extractSessionTokens: (state) => readResolutionSignal(state, SESSION_TOKENS_CONSUMED) ?? 0,
    sessionBudget: Number.isFinite(SESSION_TOKEN_BUDGET)
      ? SESSION_TOKEN_BUDGET
      : 100_000,
    action: "REFUSE",
    userFacing:
      "Você atingiu o limite de uso desta conversa. Tente novamente mais tarde.",
  }),
);

// Confirm-on-autoresolve (NL→id confirm-first): when the conductor resolve stage
// auto-resolved a target the customer left implicit ("cancelar meu pedido" →
// most-recent order; "cancelar minha reserva" → the only active booking; PIX
// regenerate → most-recent order; BKL-038 in-flight modify "adiciona uma coca no
// meu pedido" / "muda o endereço do meu pedido" → most-recent order), it sets
// `state.ctx.autoResolvedMoneyRef`. This guard then REQUEST_CONFIRMATIONs so a
// wrong guess can never auto-execute — the user sees the target and confirms.
// On resume (after confirm) the parked envelope carries the EXPLICIT resolved id,
// so the flag is absent → this guard passes → the kernel re-adjudicates against
// fresh entity state. Boolean-as-threshold (1 = flagged). Composed at the
// adopter level (no pack-source change), like the F4 guard. This set MUST mirror
// ORDER_AUTORESOLVE_KINDS + RESERVATION_AUTORESOLVE_KINDS (resolve-and-assemble.ts):
// every kind that auto-resolves an implicit target must confirm it here.
//
// R3-S1 — EXPORTED for the lockstep coverage contract
// (claustrum/__tests__/autoresolve-confirm-lockstep.test.ts), mirroring how
// `ORDER_BY_ID_KINDS` / `OWNERSHIP_GATED_KINDS` are exported for the
// ownership-gating coverage contract. The "MUST mirror" above was comment-only
// until then — both sides were module-private, so no test could compare them
// and the mirror had already drifted in a hand-copied replica. Not a runtime
// API: production reads it only through `confirmOnAutoResolveGuard` below.
//
// R3-S3 — and now there is nothing left to mirror. This was a HAND-WRITTEN set
// whose eleven comments each explained that some kind had joined an auto-resolve
// set in another file; it is DERIVED from the `confirmOnAutoResolve` field of
// `KIND_RESOLUTION_PROFILES`, so the fact is written once, on the row, next to
// the strategy that makes the confirm necessary. The lockstep contract does not
// become vacuous: confirm and auto-resolve derive from DIFFERENT FIELDS, so a row
// declaring a strategy without a confirm still breaks it — see the derivation's
// docblock in kind-resolution-profiles.ts.
//
// Re-exported (not re-declared) so every existing importer of
// `AUTORESOLVE_CONFIRM_KINDS` from this module keeps working unchanged.
export { AUTORESOLVE_CONFIRM_KINDS };
export const confirmOnAutoResolveGuard = nameGuard(
  "confirmOnAutoResolvedRef",
  createConfirmGuard<string, unknown, unknown>({
    matches: (env) => AUTORESOLVE_CONFIRM_KINDS.has(env.kind),
    // TRUTHINESS kept verbatim (not `=== true`): this extractor feeds a numeric
    // threshold, and tightening the test here would change the decision for any
    // non-boolean value a caller ever put on the flag. Behaviour-preserving
    // conversion only — the typed read is the change.
    extract: (_env, state) => (readResolutionSignal(state, AUTO_RESOLVED_MONEY_REF) ? 1 : 0),
    threshold: 1,
    comparator: ">=",
    // BKL-197 — the prompt referred to an ORDER as an "item" (wrong noun) and is
    // shared across kinds that blind-resolve to the customer's MOST-RECENT order.
    // Use the "pedido" noun and keep the wording honest to that most-recent
    // resolution. Rendering a specific "#N" for an explicitly-named order stays
    // BKL-197's own row (a copy change, not resolver behavior).
    //
    // BKL-216 (landed) — the amend kinds (`order.amend.*`) no longer ignore an order
    // the customer NAMED: `resolveAmendOrderReference` binds it and does NOT set
    // `autoResolvedMoneyRef`, so for those kinds this prompt now fires ONLY on the
    // genuinely blind most-recent branch — "mais recente" is TRUE whenever a
    // customer sees it. That removes the hazard that deferred the "#N" split (a
    // number here can no longer name a different order than the one resolved). The
    // remaining autoresolve kinds (order.cancel / note.add / address.change /
    // type.switch / payment.pix.regenerate) still blind-resolve — widening the
    // reference resolution to them is BKL-198.
    //
    // BKL-226 — this same guard fronts the RESERVATION autoresolve kinds
    // (reservation.cancel / reservation.modify are in AUTORESOLVE_CONFIRM_KINDS),
    // where "o seu pedido" is the wrong noun. Make it kind-aware from the envelope
    // (the prompt callback receives it): a reservation kind says "a sua reserva"
    // (feminine agreement → "essa mesma"), everything else keeps "o seu pedido".
    prompt: (_value, _threshold, env) =>
      env.kind.startsWith("reservation.")
        ? "Identifiquei a sua reserva mais recente para esta ação. Confirma que é essa mesma? Responda sim para continuar."
        : "Identifiquei o seu pedido mais recente para esta ação. Confirma que é esse mesmo? Responda sim para continuar.",
  }),
);

// FE-T14 — allergen-mention honesty guard for customer.preferences.update.
// resolve-and-assemble.ts's `isAllergenMentionUtterance` detector stamps
// `state.ctx.allergenMentionDetected` when the RAW utterance looks
// allergen-shaped ("sou alérgico a amendoim, atualiza aí"); this guard turns
// that flag into an honest, kernel-authoritative REFUSE.
//
// Why a guard, not a resolver-level short-circuit: CLAUDE.md rule #9 — the
// kernel is the sole REFUSE authority, never the resolver. The resolver's
// job (resolve-and-assemble.ts's own FE-T14 addition) is to UNCONDITIONALLY
// strip whatever `allergenExclusions` the model supplied and refill it from
// the customer's CURRENT saved value — by itself that make the turn always
// "succeed" (the safety-critical allergen guard, pack-customer-onboarding's
// `validateAllergenExplicitArray`, only fires on an ABSENT/malformed array,
// never on a well-formed refill) — a dishonest silent no-op on exactly the
// turn where the customer asked to change their allergies. This guard
// closes that gap: an allergen-shaped ask REFUSEs honestly instead of
// silently updating unrelated fields (or nothing at all) while looking like
// a success.
export const ALLERGEN_MENTION_REFUSAL_CODE = "allergen_mention_requires_explicit_flow";

const ALLERGEN_MENTION_REFUSAL_PT_BR =
  "Por segurança, alterações de alergia não podem ser feitas por aqui. " +
  "Atualize suas preferências alimentares (não relacionadas a alergia) à vontade, " +
  "mas para alergias, use o formulário do seu perfil.";

export const refuseAllergenMentionGuard: Guard<string, unknown, unknown> = nameGuard(
  "refuseAllergenMention",
  (envelope, state) => {
    if (envelope.kind !== "customer.preferences.update") return null;
    // `resolutionSignalIsSet` IS the `!== true` this replaced: absent / false /
    // any non-`true` value all mean PASS.
    if (!resolutionSignalIsSet(state, ALLERGEN_MENTION_DETECTED)) return null;
    return decisionRefuse(
      refuse("BUSINESS_RULE", ALLERGEN_MENTION_REFUSAL_CODE, ALLERGEN_MENTION_REFUSAL_PT_BR),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          rule: "allergen_mention_requires_explicit_flow",
        }),
      ],
    );
  },
);

// FE-D18 — no-match honesty guard for order.amend.add_item. resolve-and-assemble
// .ts stamps `state.ctx.amendItemUnresolved` when an amend "adiciona X no meu
// pedido" cannot resolve X to a real catalog variant (name absent, no Typesense
// match, or the lexical-overlap floor refused an arbitrary hit — the same floor
// that today already leaves order.item.add's variantId/allergens unset). This
// guard turns that flag into an honest, kernel-authoritative REFUSE.
//
// Why a guard, not a resolver short-circuit: CLAUDE.md rule #9 — the kernel is
// the sole REFUSE authority. And why REFUSE HERE rather than let the parked
// envelope die on resume: order.amend.add_item is in AUTORESOLVE_CONFIRM_KINDS,
// so `confirmOnAutoResolveGuard` (below) would REQUEST_CONFIRMATION with a
// found-implying "Identifiquei o item mais recente… Confirma?" prompt on an
// envelope that carries no variantId/allergens and can never succeed. Composed
// BEFORE confirmOnAutoResolveGuard so the REFUSE pre-empts that dishonest park
// (the same "REFUSE pre-empts a softer decision" ladder the allergen guard
// follows). Fires on the stamped ctx flag ONLY — never on naked variantId
// absence: an explicit non-model variantId is legitimate, and the resume leg
// carries the resolved variantId (flag absent) so it re-adjudicates normally.
// The allergens-absent backstop (pack-orders' requireExplicitAllergens) is
// untouched and still REFUSEs a resume that somehow lost its allergen array.
export const UNRESOLVED_AMEND_ITEM_REFUSAL_CODE = "amend_add_item_not_found";

const UNRESOLVED_AMEND_ITEM_REFUSAL_PT_BR =
  "Não encontrei esse item no cardápio. Confira o nome e tente de novo, " +
  "ou peça para eu listar as opções disponíveis.";

export const refuseUnresolvedAmendItemGuard: Guard<string, unknown, unknown> = nameGuard(
  "refuseUnresolvedAmendItem",
  (envelope, state) => {
    if (envelope.kind !== "order.amend.add_item") return null;
    if (!resolutionSignalIsSet(state, AMEND_ITEM_UNRESOLVED)) return null;
    return decisionRefuse(
      refuse("BUSINESS_RULE", UNRESOLVED_AMEND_ITEM_REFUSAL_CODE, UNRESOLVED_AMEND_ITEM_REFUSAL_PT_BR),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          rule: "amend_add_item_requires_resolved_catalog_item",
        }),
      ],
    );
  },
);

// FE-D28 — no-match / ambiguous honesty guard for order.review.submit.
// resolve-and-assemble.ts stamps `state.ctx.reviewProductUnresolved` when the
// reviewed order has MORE than one product and the customer's NL `item`
// reference matched none (or several) of its lines — so the (Identity-class)
// productId could not be resolved to a single purchased product. Like the
// amend guard above, this turns that flag into an honest, kernel-authoritative
// REFUSE, composed BEFORE confirmOnAutoResolveGuard so it pre-empts a doomed
// "Confirma?" park on an envelope that carries no productId and can never
// write a review. Fires on the stamped ctx flag ONLY (a single-product order
// resolves without any reference, and an explicit match leaves the flag unset),
// so an ordinary review never trips it.
export const UNRESOLVED_REVIEW_PRODUCT_REFUSAL_CODE = "review_product_ambiguous";

const UNRESOLVED_REVIEW_PRODUCT_REFUSAL_PT_BR =
  "Seu pedido tem mais de um produto. Qual deles você quer avaliar? " +
  "Diga o nome do item (ex.: \"a costela\") para eu registrar a avaliação certa.";

export const refuseUnresolvedReviewProductGuard: Guard<string, unknown, unknown> = nameGuard(
  "refuseUnresolvedReviewProduct",
  (envelope, state) => {
    if (envelope.kind !== "order.review.submit") return null;
    if (!resolutionSignalIsSet(state, REVIEW_PRODUCT_UNRESOLVED)) return null;
    return decisionRefuse(
      refuse(
        "BUSINESS_RULE",
        UNRESOLVED_REVIEW_PRODUCT_REFUSAL_CODE,
        UNRESOLVED_REVIEW_PRODUCT_REFUSAL_PT_BR,
      ),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          rule: "review_requires_resolved_ordered_product",
        }),
      ],
    );
  },
);

/**
 * The adopter-level business guards prepended to EVERY pack, in evaluation
 * order: F4 token-budget (REFUSE over budget) → allergen-mention honesty
 * (REFUSE an allergen-shaped customer.preferences.update) → unresolved
 * amend-item honesty (REFUSE an order.amend.add_item whose item didn't
 * resolve to a catalog variant) → unresolved review-product honesty (REFUSE an
 * order.review.submit whose reviewed product couldn't be resolved from the
 * order's line items) → confirm-on-autoresolve (REQUEST_CONFIRMATION). The
 * three REFUSE honesty guards sit BEFORE confirm-on-autoresolve so the "REFUSE
 * pre-empts a softer decision" ladder holds: both order.amend.add_item AND
 * order.review.submit are in AUTORESOLVE_CONFIRM_KINDS, so without this ordering
 * an unresolved item/product would be parked behind a found-implying confirm
 * prompt instead of honestly refused. The REFUSE guards are mutually inert
 * (disjoint kinds), so their relative order is not load-bearing — only their
 * precedence over confirm-on-autoresolve is. All run before each pack's own
 * business guards and only fire for their matching kinds/flags.
 */
export const IBATEXAS_ADOPTER_BUSINESS_GUARDS: ReadonlyArray<
  Guard<string, unknown, unknown>
> = [
  sessionTokenBudgetGuard,
  refuseAllergenMentionGuard,
  refuseUnresolvedAmendItemGuard,
  refuseUnresolvedReviewProductGuard,
  confirmOnAutoResolveGuard,
];

// ── Managed-agent kill + scope + budget guards (T3-4/T3-5) — AUTH phase ─────
// Built once over the composed AGENT_REGISTRY (@ibatexas/agents, T3-3) and
// prepended to EVERY pack's auth phase, in evaluation order: KILL first (a
// killed agent REFUSEs before scope/budget are even considered), then scope
// (an out-of-scope envelope REFUSEs before its budget), then one over-budget
// ESCALATE guard per agent that declares `budgets.tokensPerDay`, then the
// staff-plane role guard (BKL-069 Part C). All the agent guards are inert for
// non-`agent:` traffic and the staff-role guard is inert for non-`admin:`
// traffic, so the two families never both fire on one envelope.
//
// The kill guard reads LIVE per-agent state from the runtime
// AgentKillSwitchManager (T3-5). The guard list is a module-level const built
// at import — before the manager exists — and is ALSO consumed by the pure
// policy-manifest exporter / CLI (no manager). So the kill state is read
// through a late-bound holder: `setAgentKillStateReader()` points it at the
// live manager when the managed-agent plane starts; everywhere else it defaults
// to "never killed" (a kill switch is a runtime control, not static policy — the
// exported manifest must not depend on it).
let agentKillStateReader: (agentNamespace: string) => boolean = () => false;

/**
 * Point the AUTH-phase kill guard at the live per-agent kill state (the
 * AgentKillSwitchManager). Idempotent.
 *
 * ONE production caller: `startManagedAgentPlane` (managed-agent-plane.ts),
 * beside the host-side leg and over the SAME manager binding, so both legs
 * answer from one store. `bootstrapClaustrum` reaches it only through that call,
 * and only when `IBX_AGENTS_ENABLED=true` — a boot with the plane off leaves the
 * default in place, which is correct there because no `agent:`-namespaced
 * envelope exists to kill.
 *
 * "Safe to leave unset" is true only in that narrow sense; unset is NOT a benign
 * default for a process that DOES run agents. It makes `agentKillSwitchGuard` —
 * authGuards[0] of every composed pack — constant-false, which is exactly the
 * state F-51 found and fixed. A test that calls this setter itself therefore
 * proves the guard BODY and nothing about the wiring; the production wiring is
 * covered by `agent-kill-switch-production-wiring.test.ts`, which never names
 * this function.
 */
export function setAgentKillStateReader(
  reader: (agentNamespace: string) => boolean,
): void {
  agentKillStateReader = reader;
}

export const agentKillSwitchGuard = createAgentKillSwitchGuard((ns) =>
  agentKillStateReader(ns),
);
export const agentScopeGuard = createAgentScopeGuard(AGENT_REGISTRY);
export const agentBudgetGuards = createAgentBudgetGuards(AGENT_REGISTRY);

// ── Staff-plane per-role capability guard (BKL-069 Part C) — AUTH phase ──────
// REFUSE `staff_role_violation` for any `admin:`-namespaced envelope whose kind
// is outside the staff-plane role matrix OR whose `actor.role` is absent /
// unknown / not permitted for that kind. Inert (null) for non-staff traffic
// (customer, LLM, `agent:`, system subscribers). It governs a DISJOINT
// namespace from the agent guards (`admin:` vs `agent:`), so it is appended
// after them; ordering among mutually-inert guards is not load-bearing.
//
// COVERAGE (no overstatement): this composition is consumed only by the
// composed-router seam — `composePolicyRouter`/`policyForKind` (conductor +
// agent-approvals gateway resume) and the policy-manifest exporter. So the
// staff-role guard is a live AUTH gate ONLY for `admin:` envelopes routed
// through `policyForKind`, which today is exclusively the future ops-actor
// surface (WS6 / NEW-032). Today's admin HTTP routes do NOT reach this
// composition: they adjudicate the seven staff kinds against the RAW pack
// bundles via the domain command services, whose primary role gate is the
// Fastify preHandler chain (staff-auth.ts). This guard is the kernel
// defense-in-depth that MIRRORS those preHandlers; wiring it into the HTTP
// command-service adjudication path is tracked as BKL-074. See the module
// header in staff-role-guard.ts for the full seam-by-seam breakdown.

export const IBATEXAS_ADOPTER_AUTH_GUARDS: ReadonlyArray<
  Guard<string, unknown, unknown>
> = [
  agentKillSwitchGuard,
  agentScopeGuard,
  ...agentBudgetGuards,
  staffRoleGuard,
  // BKL-075 — payload-aware banding companion (payment.status.transition force/
  // waive → OWNER); composed alongside staffRoleGuard on the conductor router.
  paymentTransitionBandGuard,
  // BKL-131 — payload-aware banding companion (order.status.transition → canceled,
  // a staff reject, requires MANAGER+); composed alongside staffRoleGuard.
  orderStatusTransitionBandGuard,
];

/**
 * Build the production policy-pack list: each first-party pack with the
 * adopter-level auth guards prepended to its `authGuards` phase and the
 * adopter-level business guards prepended to its `business` phase. This is the
 * EXACT composition `composePolicyRouter` dispatches over and the manifest
 * exporter describes — keeping the two in lockstep by construction.
 */
export function buildIbatexasPolicyPacks(
  packs: ReadonlyArray<ErasedPack>,
  adopterBusinessGuards: ReadonlyArray<
    Guard<string, unknown, unknown>
  > = IBATEXAS_ADOPTER_BUSINESS_GUARDS,
  adopterAuthGuards: ReadonlyArray<
    Guard<string, unknown, unknown>
  > = IBATEXAS_ADOPTER_AUTH_GUARDS,
): ReadonlyArray<ErasedPack> {
  return packs.map((p) => {
    const base = p.policy as unknown as PolicyBundle<string, unknown, unknown>;
    return {
      ...p,
      policy: {
        ...base,
        authGuards: [...adopterAuthGuards, ...base.authGuards],
        business: [...adopterBusinessGuards, ...base.business],
      },
    } as unknown as ErasedPack;
  });
}
