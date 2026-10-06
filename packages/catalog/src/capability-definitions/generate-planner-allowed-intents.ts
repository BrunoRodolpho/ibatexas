/**
 * Planner `allowedIntents` projection generator — FE-4 MIGRATE 1 (FE-T20).
 *
 * # The boundary, stated honestly (per the ticket's explicit instruction)
 *
 * A `CapabilityPlanner.plan(state, context)` computes `allowedIntents` as a
 * FUNCTION OF STATE — e.g. `pack-orders`' planner returns 5 kinds
 * unconditionally plus 4 more `if (isAuthenticated)`; `pack-reservations`'
 * adds 2 more `if (isStaffSession)`; `pack-ops`' returns `[]` entirely
 * unless staff. That per-state GATING LOGIC is business logic (P5 —
 * "Policy guard bodies, planner per-context predicates… stay hand-authored")
 * and is NOT generated here, nor could it be from DATA alone.
 *
 * What CAN be generated, and is: the STATIC set of kinds a given pack's
 * planner (or another pack's planner ADVERTISING it — see below) can EVER
 * include in `allowedIntents`, under AT LEAST ONE state/context — i.e. the
 * union across every branch, collapsing the conditional structure away.
 * This is `CapabilityDefinition.plannerAdvertisedBy` (see its full doc in
 * `types.ts` — grounded by reading all 6 packs' `capabilities.ts` planners
 * in full for FE-T20, not inferred or guessed).
 *
 * # Why "per advertising pack", not "per owning pack"
 *
 * Advertisement is decoupled from ownership: `pack-ops`'s planner
 * advertises `order.note.add` / `order.status.transition` (owned by
 * pack-orders) and `payment.refund.issue` (owned by pack-payments) to
 * widen its own staff allowlist. Projecting "by owning pack" would put
 * those three under orders/payments and silently miss that pack-ops'
 * OWN planner also advertises them — the wrong axis for THIS generator,
 * whose target is "what can THIS planner return", not "who owns this
 * kind" (that's `generate-pack-intent-kinds.ts`'s job).
 *
 * # Freshness target: runtime materialization, not a committed file
 *
 * Unlike the other three intent-identity generators, there is no single
 * committed hand list this diffs against — `allowedIntents` is runtime
 * planner OUTPUT, not a static source file. Per FE-4.3's own preference
 * ("prefer runtime materializations… which catch generator/registration/
 * logic bugs a shared source cannot"), the freshness test drives the REAL
 * `CapabilityPlanner.plan()` for each pack under synthetic probe states
 * (mirroring `apps/api`'s own `ROSTER_DRIFT_CONTEXTS` pattern) and asserts
 * this generator's projection equals the UNION of what those real calls
 * actually returned — never a second hand-authored list.
 */

import type { CapabilityDefinition } from "./types.js"

/**
 * Project the set of kinds `advertisingPack`'s `CapabilityPlanner` can
 * include in `allowedIntents` under at least one state/context — i.e. the
 * union across every `CapabilityDefinition` (any owning pack) whose
 * `plannerAdvertisedBy` names `advertisingPack`. Order is declaration
 * order across the FULL `defs` array (not scoped to `advertisingPack`'s
 * own group) since a foreign-owned advertised kind (e.g. `order.note.add`
 * for `ibatexas/pack-ops`) is declared under its OWNING pack's group, not
 * the advertising one's. The freshness test compares this as a SET (not
 * order-sensitive) against the real planner's runtime output — order has
 * no meaning for a runtime-executed `allowedIntents` array the way it does
 * for a hand-authored, textually-ordered source file.
 */
export function generatePlannerAllowedIntents(
  defs: readonly CapabilityDefinition[],
  advertisingPack: CapabilityDefinition["pack"],
): readonly string[] {
  const out: string[] = []
  for (const def of defs) {
    if (!(def.plannerAdvertisedBy ?? []).includes(advertisingPack)) continue
    out.push(def.kind)
  }
  return out
}
