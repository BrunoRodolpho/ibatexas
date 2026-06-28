// ibatexas-claims-kernel-deps.ts — the injected capabilities the published
// Claims kernel composes (SDD §F; §Q.3/§Q.4). Provides the @adjudicate/core
// `ClaimsKernelDeps` the Conductor threads into CLAIMS-VALIDATE
// (`runClaimsKernel` = P1 soundness `claimAllowed` ∘ P2 consistency
// `checkConsistency`):
//
//   { soundness: { owns, outcomeConfirmed, now }, consistency?: { table } }
//
// The kernel holds NO policy of its own — every repo-specific decision is
// INJECTED here (the ownership model, action-outcome confirmation, the clock, the
// same-subject constraint table).
//
// B-PR1 SCOPE — bootstrap seam, FLAG DEFAULT-OFF. The published
// `ConductorOptions.claimsKernel` is a PROCESS-WIDE value (one `ClaimsKernelDeps`
// held by the Conductor, threaded onto every Capsule), but `owns` /
// `outcomeConfirmed` / `now` are genuinely PER-TURN. The published seam has no
// per-turn deps surface yet (the same gap as the per-turn `clock` — PENDING
// R2a), so the process-wide defaults below FAIL CLOSED:
//
//   - `owns`            → `false` (Inv 2: "no owner attribution" ≠ "any owner" →
//                         REFUSED). PENDING the per-turn authority threading —
//                         the real owner check binds the customer-scoped
//                         resolveAndAssemble owned-resource set (authority-wiring.ts).
//   - `outcomeConfirmed`→ `false` (Inv 4: an `action_claim` with no confirmed
//                         outcome is a confabulation → REFUSED). PENDING the
//                         per-turn Action verdict + dispatch threading.
//   - `now`             → captured `Date.now()` ONCE at construction (the
//                         published `SoundnessDeps.now` is a static `number`).
//                         A per-turn `now` is PENDING R2a; it is NOT passed via
//                         `ConductorOptions` (no `clock` field there). Fine for
//                         B-PR1: the claims path is OFF, so the cacheable-tier
//                         staleness window is moot until activation.
//
// Real predicates are INJECTABLE so the activation PR (and the tests) can thread
// the live per-turn capabilities without re-shaping this module.

import {
  DEFAULT_CONSISTENCY_TABLE,
  type ClaimsKernelDeps,
  type ConsistencyConstraint,
  type MinimalClaim,
  type SoundnessDeps,
} from "@adjudicate/core";

export interface IbatexasClaimsKernelDepsConfig {
  /**
   * C1 ownership validation predicate (SDD §E C1; Inv 2): does `actor` own
   * `resource`? Default fail-CLOSED (`() => false`). PENDING the per-turn
   * authority threading (see module header).
   */
  readonly owns?: (actor: unknown, resource: unknown) => boolean;
  /**
   * C4 action-outcome accessor (SDD §E C4; Inv 4): did this `action_claim`'s
   * outcome CONFIRM? Default fail-CLOSED (`() => false`). PENDING the per-turn
   * Action verdict + dispatch threading.
   */
  readonly outcomeConfirmed?: (claim: MinimalClaim) => boolean;
  /**
   * The cacheable-tier staleness clock (epoch-millis), captured ONCE into the
   * static published `SoundnessDeps.now`. Default `Date.now`. A per-turn clock is
   * PENDING R2a (NOT passed via `ConductorOptions` — no `clock` field there).
   */
  readonly now?: () => number;
  /**
   * The P2 same-subject constraint table. Defaults to the published
   * kernel-foundation {@link DEFAULT_CONSISTENCY_TABLE}.
   */
  readonly consistencyTable?: readonly ConsistencyConstraint[];
}

/**
 * Build the process-wide `ClaimsKernelDeps` for the Conductor's CLAIMS-VALIDATE
 * stage. Fail-closed defaults (see the module header); injectable for activation.
 */
export function createIbatexasClaimsKernelDeps(
  config: IbatexasClaimsKernelDepsConfig = {},
): ClaimsKernelDeps {
  const soundness: SoundnessDeps = {
    // Fail CLOSED by default: an un-attributed owner is not an owner (Inv 2).
    owns: config.owns ?? (() => false),
    // Fail CLOSED by default: an unconfirmed action outcome never validates (Inv 4).
    outcomeConfirmed: config.outcomeConfirmed ?? (() => false),
    // Static `now` — captured once (the published SoundnessDeps.now is a number;
    // per-turn clock PENDING R2a).
    now: (config.now ?? (() => Date.now()))(),
  };

  return {
    soundness,
    consistency: { table: config.consistencyTable ?? DEFAULT_CONSISTENCY_TABLE },
  };
}
