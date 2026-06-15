/**
 * Policy-pack composition — the SINGLE source of the post-prepend pack list.
 *
 * The kernel adjudicates each intent against its owning pack's PolicyBundle,
 * but ibatexas prepends two ADOPTER-LEVEL business guards to every pack's
 * `business` phase at composition: the F4 session token-budget guard (REFUSE
 * over budget / ADR-120) and the confirm-on-autoresolve guard
 * (REQUEST_CONFIRMATION when an ambiguous money/booking target was
 * auto-resolved). These guards are NOT in any published `@ibatexas/pack-*`;
 * they live only here.
 *
 * Both the production router (`claustrum-bootstrap` → `composePolicyRouter`)
 * AND the policy-manifest exporter (`policy-manifest-export`) consume
 * `buildIbatexasPolicyPacks` so the manifest describes EXACTLY the bundles the
 * kernel runs — it cannot drift from production. Pure (no I/O), so the CLI /
 * exporter can import it without booting the conductor.
 */

import type { PackV0 } from "@adjudicate/core";
import { nameGuard, type Guard, type PolicyBundle } from "@adjudicate/core/kernel";
import { createTokenBudgetGuard, createConfirmGuard } from "@adjudicate/primitives";

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
// auto-resolved an ambiguous target for an IRREVERSIBLE money/booking intent
// ("cancelar meu pedido" → most-recent order; "cancelar minha reserva" → the only
// active booking; PIX regenerate → most-recent order), it sets
// `state.ctx.autoResolvedMoneyRef`. This guard then REQUEST_CONFIRMATIONs so a
// wrong guess can never auto-execute — the user sees the target and confirms.
// On resume (after confirm) the parked envelope carries the EXPLICIT resolved id,
// so the flag is absent → this guard passes → the kernel re-adjudicates against
// fresh entity state. Boolean-as-threshold (1 = flagged). Composed at the
// adopter level (no pack-source change), like the F4 guard.
const AUTORESOLVE_CONFIRM_KINDS = new Set([
  "order.cancel",
  "payment.pix.regenerate",
  "reservation.cancel",
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

/**
 * The adopter-level business guards prepended to EVERY pack, in evaluation
 * order: F4 token-budget (REFUSE over budget) → confirm-on-autoresolve
 * (REQUEST_CONFIRMATION). Both run before each pack's own business guards and
 * only fire for their matching kinds/flags.
 */
export const IBATEXAS_ADOPTER_BUSINESS_GUARDS: ReadonlyArray<
  Guard<string, unknown, unknown>
> = [sessionTokenBudgetGuard, confirmOnAutoResolveGuard];

/**
 * Build the production policy-pack list: each first-party pack with the
 * adopter-level business guards prepended to its `business` phase. This is the
 * EXACT composition `composePolicyRouter` dispatches over and the manifest
 * exporter describes — keeping the two in lockstep by construction.
 */
export function buildIbatexasPolicyPacks(
  packs: ReadonlyArray<ErasedPack>,
  adopterBusinessGuards: ReadonlyArray<
    Guard<string, unknown, unknown>
  > = IBATEXAS_ADOPTER_BUSINESS_GUARDS,
): ReadonlyArray<ErasedPack> {
  return packs.map((p) => {
    const base = p.policy as unknown as PolicyBundle<string, unknown, unknown>;
    return {
      ...p,
      policy: {
        ...base,
        business: [...adopterBusinessGuards, ...base.business],
      },
    } as unknown as ErasedPack;
  });
}
