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
// TWO construction paths:
//
//   1. `createIbatexasClaimsKernelDeps` — the PROCESS-WIDE, FAIL-CLOSED bootstrap
//      seam (B-PR1). The published `ConductorOptions.claimsKernel` is a
//      process-wide value (one `ClaimsKernelDeps` threaded onto every Capsule),
//      but `owns` / `outcomeConfirmed` / `now` are genuinely PER-TURN. Absent the
//      per-turn threading, the defaults FAIL CLOSED (`owns → false`,
//      `outcomeConfirmed → false`, `now` captured once). Used where no per-turn
//      facts exist yet.
//
//   2. `createPerTurnClaimsKernelDeps` — the REAL per-turn path (Track-A INPUT
//      precondition). Given this turn's facts it builds deps with:
//        - `owns`             — REAL owner attribution derived from the
//          source-of-record owned-resource set (the customer-scoped
//          resolveAndAssemble `owned` set / authority-wiring.ts), NOT a stub
//          `true`. "no owner attribution" ≠ "any owner" → a resource outside the
//          owned set is REFUSED (Inv 2). The PAYMENT_STATUS IDOR is closed UPSTREAM
//          at the read (turn-reads.ts) so the owned set never contains a
//          cross-owner resource.
//        - `outcomeConfirmed` — REAL, derived from this turn's Action-kernel
//          verdict + dispatch result (`EXECUTE ∧ dispatched ∧ result.success ∧
//          settlement`), NOT a stub (Inv 4).
//        - `now` (R2a)        — a PER-TURN timestamp captured at TURN START and
//          passed in, instead of the module-load static `Date.now()`. The
//          published `SoundnessDeps.now` stays a `number` (signature-compatible);
//          this path simply supplies a fresh per-turn value.
//      The Conductor seam threading (one deps per turn) is W5b; this wave provides
//      the REAL builders that wave injects.

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

// ── REAL per-turn soundness predicates (Track-A INPUT precondition) ────────────

/**
 * The per-turn ownership facts the REAL `owns` predicate quantifies over (Inv 2;
 * SDD §E C1). Sourced from the source-of-record, NOT a stub:
 *  - `principal`      — the AUTHENTICATED customer for this turn (the conductor
 *    identity, not the envelope's self-reported actor — authority-wiring.ts).
 *  - `ownedResources` — the resources the customer was OWNERSHIP-CONFIRMED to own
 *    this turn (the customer-scoped resolveAndAssemble `owned` set). Because the
 *    set is built from owner-scoped DB reads, a forged / cross-owner resource is
 *    never in it ⇒ the predicate REFUSEs (de-vacuumed; "no owner" ≠ "any owner").
 */
export interface OwnershipFacts {
  readonly principal: string;
  readonly ownedResources: ReadonlySet<string>;
}

/** Best-effort identity of a kernel-abstract `actor` (string id, or `{ principal
 *  | customerId | id }`); `undefined` when the actor carries no embedded id. */
function actorIdOf(actor: unknown): string | undefined {
  if (typeof actor === "string") return actor;
  if (typeof actor === "object" && actor !== null) {
    const o = actor as Record<string, unknown>;
    for (const k of ["principal", "customerId", "id"] as const) {
      if (typeof o[k] === "string") return o[k];
    }
  }
  return undefined;
}

/**
 * Build the REAL `owns(actor, resource)` predicate (Inv 2; SDD §E C1) from this
 * turn's {@link OwnershipFacts}. PURE (no IO) — the kernel requires it. A claim
 * VALIDATEs ownership iff:
 *   - `resource` is a non-empty string IN the principal-scoped owned set, AND
 *   - the claim's `actor`, when it carries a concrete identity, matches the
 *     authenticated `principal` (defense in depth — a DIFFERING actor id fails
 *     closed; an actor with no embedded id relies on the owned-set scoping).
 */
export function buildOwns(
  facts: OwnershipFacts,
): (actor: unknown, resource: unknown) => boolean {
  return (actor, resource) => {
    if (typeof resource !== "string" || !facts.ownedResources.has(resource)) {
      return false;
    }
    const actorId = actorIdOf(actor);
    return actorId === undefined || actorId === facts.principal;
  };
}

/**
 * One action's outcome this turn (SDD §E C4; Inv 4) — the Action-kernel verdict +
 * dispatch result for a single resource the action acted on. `confirmed` requires
 * `EXECUTE ∧ dispatched ∧ result.success ∧ (settlement, for money)`; `settled`
 * absent = not-applicable (a present `false` is distinct — settlement ≠ session).
 */
export interface ActionOutcome {
  /** The resource the action acted on (e.g. an orderId) — the C1 binding key. */
  readonly resource: string;
  /** The Action-kernel decision kind; only `"EXECUTE"` can confirm. */
  readonly verdict: string;
  /** Dispatch reached the handler. */
  readonly dispatched: boolean;
  /** `result.success` of the dispatched action. */
  readonly success: boolean;
  /** Durable downstream settlement (money). Absent = n/a; a present `false` blocks. */
  readonly settled?: boolean;
}

/** Did this action's outcome CONFIRM (SDD §E C4 / Inv 4)? Pure. */
export function actionOutcomeConfirmed(o: ActionOutcome): boolean {
  return o.verdict === "EXECUTE" && o.dispatched && o.success && o.settled !== false;
}

/**
 * Build the REAL `outcomeConfirmed(claim)` accessor (Inv 4; SDD §E C4) from this
 * turn's action outcomes. PURE. An `action_claim` confirms ONLY when one of its
 * bound resources (`claim.resources` values) has a CONFIRMED outcome this turn;
 * no bound resource ⇒ no confirmable outcome ⇒ `false` (fail closed — an
 * unconfirmed action never validates).
 */
export function buildOutcomeConfirmed(
  outcomes: readonly ActionOutcome[] = [],
): (claim: MinimalClaim) => boolean {
  const confirmed = new Set<string>();
  for (const o of outcomes) {
    if (actionOutcomeConfirmed(o)) confirmed.add(o.resource);
  }
  return (claim) => {
    const bound = Object.values(claim.resources ?? {}).filter(
      (r): r is string => typeof r === "string",
    );
    return bound.length > 0 && bound.some((r) => confirmed.has(r));
  };
}

/** This turn's facts for the REAL {@link createPerTurnClaimsKernelDeps}. */
export interface PerTurnClaimsKernelFacts {
  /** R2a — the per-turn timestamp captured at TURN START (epoch-millis). */
  readonly now: number;
  /** Owner-attribution facts for the REAL `owns` predicate. */
  readonly ownership: OwnershipFacts;
  /** This turn's Action verdict + dispatch outcomes for the REAL `outcomeConfirmed`. */
  readonly outcomes?: readonly ActionOutcome[];
  /** Optional consistency-table override; defaults to DEFAULT_CONSISTENCY_TABLE. */
  readonly consistencyTable?: readonly ConsistencyConstraint[];
}

/**
 * Build the REAL per-turn `ClaimsKernelDeps` (Track-A INPUT precondition). Unlike
 * the process-wide fail-closed {@link createIbatexasClaimsKernelDeps}, this binds
 * the genuine per-turn capabilities: REAL owner attribution, REAL action-outcome
 * confirmation, and the per-turn R2a clock (`facts.now`, captured at turn start —
 * NOT the module-load static). Signature-compatible with the CURRENT published
 * kernel (`SoundnessDeps.now` stays a `number`). The Conductor seam threading
 * (one deps per turn) is W5b.
 */
export function createPerTurnClaimsKernelDeps(
  facts: PerTurnClaimsKernelFacts,
): ClaimsKernelDeps {
  return {
    soundness: {
      owns: buildOwns(facts.ownership),
      outcomeConfirmed: buildOutcomeConfirmed(facts.outcomes ?? []),
      // R2a — per-turn `now` captured at turn start (not module-load static).
      now: facts.now,
    },
    consistency: {
      table: facts.consistencyTable ?? DEFAULT_CONSISTENCY_TABLE,
    },
  };
}
