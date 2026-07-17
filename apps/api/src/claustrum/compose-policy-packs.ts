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
import { paymentTransitionBandGuard, staffRoleGuard } from "./staff-role-guard.js";

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
    extractSessionTokens: (state) =>
      (state as { ctx?: { sessionTokensConsumed?: number } }).ctx
        ?.sessionTokensConsumed ?? 0,
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
const AUTORESOLVE_CONFIRM_KINDS = new Set([
  "order.cancel",
  "payment.pix.regenerate",
  "reservation.cancel",
  // BKL-038 — same NL→id targeting → same confirm gate, so an auto-resolved
  // "meu pedido" is surfaced before the in-flight modify executes.
  "order.amend.request",
  // FE-T09 (D-a) — the granular amend kinds now auto-resolve orderId too
  // (resolve-and-assemble.ts's ORDER_AUTORESOLVE_KINDS), so they need the
  // same confirm gate as order.amend.request.
  "order.amend.add_item",
  "order.amend.update_qty",
  "order.amend.remove_item",
  "order.note.add",
  "order.address.change",
  "order.type.switch",
  // FE-T14 — reservation.modify now auto-resolves reservationId too
  // (resolve-and-assemble.ts's RESERVATION_AUTORESOLVE_KINDS), so it needs
  // the same confirm gate as reservation.cancel.
  "reservation.modify",
]);
export const confirmOnAutoResolveGuard = nameGuard(
  "confirmOnAutoResolvedRef",
  createConfirmGuard<string, unknown, unknown>({
    matches: (env) => AUTORESOLVE_CONFIRM_KINDS.has(env.kind),
    extract: (_env, state) =>
      (state as { ctx?: { autoResolvedMoneyRef?: boolean } }).ctx
        ?.autoResolvedMoneyRef
        ? 1
        : 0,
    threshold: 1,
    comparator: ">=",
    prompt: () =>
      "Identifiquei o item mais recente para esta ação. Confirma que é esse mesmo? Responda sim para continuar.",
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
    if ((state as { ctx?: { allergenMentionDetected?: boolean } }).ctx?.allergenMentionDetected !== true) {
      return null;
    }
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

/**
 * The adopter-level business guards prepended to EVERY pack, in evaluation
 * order: F4 token-budget (REFUSE over budget) → allergen-mention honesty
 * (REFUSE an allergen-shaped customer.preferences.update) →
 * confirm-on-autoresolve (REQUEST_CONFIRMATION). Allergen-mention sits
 * BEFORE confirm-on-autoresolve so a turn that is BOTH allergen-shaped AND
 * touches an auto-resolved kind (never true today — customer.preferences.
 * update is not in AUTORESOLVE_CONFIRM_KINDS — but kept in this order for
 * the same "REFUSE pre-empts a softer decision" ladder discipline the
 * escalate/confirm money ladder already follows elsewhere). All three run
 * before each pack's own business guards and only fire for their matching
 * kinds/flags.
 */
export const IBATEXAS_ADOPTER_BUSINESS_GUARDS: ReadonlyArray<
  Guard<string, unknown, unknown>
> = [sessionTokenBudgetGuard, refuseAllergenMentionGuard, confirmOnAutoResolveGuard];

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
// live manager at bootstrap; everywhere else it defaults to "never killed" (a
// kill switch is a runtime control, not static policy — the exported manifest
// must not depend on it).
let agentKillStateReader: (agentNamespace: string) => boolean = () => false;

/**
 * Point the AUTH-phase kill guard at the live per-agent kill state (the
 * AgentKillSwitchManager). Called once from claustrum-bootstrap after the
 * manager boots. Idempotent; safe to leave unset (guard then never fires).
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
