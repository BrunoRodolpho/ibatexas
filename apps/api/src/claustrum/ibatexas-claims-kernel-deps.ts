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
import type {
  ActiveResourceRef,
  ActiveResourcesForTurn,
  ClaimsKernelDepsForTurn,
} from "@claustrum/core";
import { isAuthenticatedCustomer } from "./ibatexas-investigator.js";

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

// ── W5b PER-TURN OWNS builder (fix 2 — the Conductor `claimsKernelDepsForTurn`) ──

/**
 * The OWNER-SCOPED per-resource ledger key prefixes the investigator writes
 * (ibatexas-investigator.ts): `order_fulfillment_stage:{id}` / `payment_status:{id}`
 * / `reservation_status:{id}`. The resource id is the SUFFIX after the prefix.
 * These are the ONLY keys whose presence attributes ownership; public keys
 * (`schedule:*`) are NOT owner resources and are excluded.
 */
export const OWNER_SCOPED_KEY_PREFIXES = [
  "order_fulfillment_stage:",
  "payment_status:",
  "reservation_status:",
  // BKL-139 — CART_CONTENTS is owner-scoped, keyed `cart_contents:{customerId}` (the
  // cart is 1-per-customer, resolved server-side from the session — never a model id).
  // Listing it here makes the present cart read attribute ownership (the customerId
  // subject enters `ownedResources` → the kernel's owns predicate passes for the legit
  // owner) and makes the customerId subject an admissible classify-only subject.
  "cart_contents:",
  // FE-D03 slice C — ORDER_HISTORY / PAYMENT_HISTORY are owner-scoped, keyed
  // `{order,payment}_history:{customerId}` (per-customer list reads). Listing them here
  // makes the present history read attribute ownership (the customerId subject enters
  // `ownedResources` → owns passes for the legit owner) and an admissible classify-only
  // subject, in lockstep with the parameterized registry keys.
  "order_history:",
  "payment_history:",
] as const;

/**
 * Group the AUTHENTICATED owner-scoped resource ids this turn's ledger holds by
 * their BASE key (the prefix without the trailing `:`), reading ONLY entries that
 * resolved PRESENT (FIX 2 — owner-scoped subject resolution; the IDOR close).
 *
 * The result is `{ order_fulfillment_stage: [id, …], payment_status: [id, …] }`
 * — the EXACT, owner-scoped set of subjects the claim planner may bind to an
 * owner-scoped candidate. Because the set is built ONLY from PRESENT owner-scoped
 * reads (a forged / cross-owner read errored → absent → excluded), a model- or
 * session-supplied non-owned id is NEVER an admissible subject ("no owner" ≠
 * "any owner", Inv 2). PURE — the kernel/planner contract requires it.
 */
export function ownedResourceIdsByBaseKey(
  ledger: EvidenceLedgerLike,
): Map<string, string[]> {
  const byBase = new Map<string, string[]>();
  for (const { base, resourceId } of presentOwnerScopedResources(ledger)) {
    const ids = byBase.get(base);
    if (ids === undefined) byBase.set(base, [resourceId]);
    else if (!ids.includes(resourceId)) ids.push(resourceId);
  }
  return byBase;
}

/** The minimal read-only ledger surface the owner-scope helpers need (a subset of
 *  the published `EvidenceLedger`) — keeps them unit-testable with a tiny stub and
 *  avoids importing the full ledger type here. */
export interface EvidenceLedgerLike {
  keys(): Iterable<string>;
  resolve(key: string): { readonly state: string };
}

/**
 * The SINGLE owner-scope IDOR filter, shared by {@link ownedResourceIdsByBaseKey}
 * and {@link buildPerTurnOwnsFromLedger} so a future edit cannot reopen the wall in
 * only one copy. Yields `{ base, resourceId }` for every ledger key that BOTH (a)
 * starts with an {@link OWNER_SCOPED_KEY_PREFIXES} prefix AND (b) resolved PRESENT
 * this turn — the IDOR close: an errored/absent owner-scoped read (cross-owner /
 * unavailable) never attributes ownership. `base` is the prefix without its
 * trailing ":"; `resourceId` is the (non-empty) suffix. PURE — the kernel/planner
 * contract requires it.
 */
function* presentOwnerScopedResources(
  ledger: EvidenceLedgerLike,
): Iterable<{ readonly base: string; readonly resourceId: string }> {
  for (const key of ledger.keys()) {
    const prefix = OWNER_SCOPED_KEY_PREFIXES.find((p) => key.startsWith(p));
    if (prefix === undefined) continue;
    if (ledger.resolve(key).state !== "present") continue;
    const resourceId = key.slice(prefix.length);
    if (resourceId.length === 0) continue;
    yield { base: prefix.slice(0, -1), resourceId };
  }
}

/**
 * Build the per-turn `ClaimsKernelDeps` (the Conductor `claimsKernelDepsForTurn`
 * seam) by rebuilding the REAL `owns` predicate from THIS turn's threaded Evidence
 * Ledger + the AUTHENTICATED `customerId` (fix 2 / Inv 2; SDD §E C1). PURE — the
 * kernel requires it.
 *
 * The owned-resource set is derived ONLY from owner-scoped ledger entries that
 * resolved PRESENT this turn: a forged / cross-owner read throws
 * `OwnerScopedReadUnavailable` in the investigator → `recordError` → state `error`
 * (NOT present) → its resource is NEVER added to the owned set → `owns → false` →
 * REFUSED ("no owner" ≠ "any owner"). The principal is the conductor's
 * authenticated `customerId` — NEVER the envelope's self-reported actor or a
 * session/model id. `outcomeConfirmed` / `now` are inherited from `base` (the
 * deps already carry the per-turn floored `now`; `outcomeConfirmed` stays
 * fail-closed — read_claims do not trigger C4).
 */
export const buildPerTurnOwnsFromLedger: ClaimsKernelDepsForTurn = ({
  ledger,
  customerId,
  base,
}): ClaimsKernelDeps => {
  const ownedResources = new Set<string>();
  // PRESENT-ONLY owner-scope filter (the IDOR close), shared with
  // `ownedResourceIdsByBaseKey` via `presentOwnerScopedResources`.
  for (const { resourceId } of presentOwnerScopedResources(ledger)) {
    ownedResources.add(resourceId);
  }
  return {
    ...base,
    soundness: {
      ...base.soundness,
      // De-vacuumed: owns is true ONLY for a resource present in THIS turn's
      // owner-scoped read set, and (defense-in-depth in buildOwns) only when the
      // claim actor matches the authenticated principal.
      owns: buildOwns({ principal: customerId, ownedResources }),
    },
  };
};

/** Adopter resource vocabulary for the {@link activeResourcesFromLedger} seam:
 *  the owner-scoped ledger BASE key → the ActiveResourceRef.kind the ibatexas
 *  required-claim decomposer speaks (OWNERSHIP_GATED_TYPES: order / payment). */
const OWNER_SCOPED_BASE_TO_RESOURCE_KIND: Readonly<Record<string, string>> = {
  order_fulfillment_stage: "order",
  payment_status: "payment",
  reservation_status: "reservation",
};

/**
 * The reserved {@link ActiveResourceRef.kind} SENTINEL that carries a PROVABLE-EMPTY
 * signal to the renderer's §O#15 decomposer (BKL-073). `kind` is contractually
 * adopter-OPAQUE (claustrum assigns it no meaning; `handleTurn` threads the array
 * through untouched), so the sentinel rides it WITHOUT a @claustrum/core change: a
 * `{ kind: PROVABLY_EMPTY_KIND, id: "order" | "payment" }` ref means "this customer
 * PROVABLY owns no active resource of that kind THIS turn." The renderer adapter
 * (`ownershipFromActiveResources`) turns its presence into a `hasActive* = false` —
 * the ONLY signal that DROPS an ownership-gated required companion.
 */
export const PROVABLY_EMPTY_KIND = "provably_empty";

/**
 * BKL-004 / BKL-073 — the #8 decomposer ownership signal, as the @claustrum/core
 * 0.5.0 `ActiveResourcesForTurn` seam. `handleTurn` invokes it at RENDER-FROM-CLAIMS
 * and threads the result as `ClaimsRenderContext.activeResources` (the resources the
 * required-claim decomposer may demand companions FOR — and, via the PROVABLY_EMPTY
 * sentinel, the ones it must STOP demanding).
 *
 * Derived ONLY from the threaded read-only Evidence Ledger + the AUTHENTICATED
 * `customerId` — the SAME IDOR filter as `buildPerTurnOwnsFromLedger` (a forged /
 * cross-owner read errored → absent → never an active resource; "no owner" ≠ "any
 * owner", Inv 2). No session/model id ever appears.
 *
 * It emits TWO kinds of ref:
 *
 *   1. POSITIVE refs — one `{ kind: "order"|"payment"|"reservation", id }` for every
 *      PRESENT owner-scoped read whose base has a mapped decomposer kind. A base with
 *      NO entry in {@link OWNER_SCOPED_BASE_TO_RESOURCE_KIND} is SKIPPED (fail-safe
 *      against a future 4th prefix added without a map entry; today the prefix set and
 *      the map are in lockstep, so nothing is skipped). `presentOwnerScopedResources`
 *      yields only the unique prefixes, so no (kind,id) can repeat — no dedupe needed.
 *
 *   2. PROVABLE-EMPTY sentinels ({@link PROVABLY_EMPTY_KIND}) — the SOUND
 *      negative-drop signal (BKL-073), under TWO rules:
 *      - GUEST (#8a): an unauthenticated turn short-circuits BEFORE the investigator's
 *        owner-scoped enumeration (there is no per-customer marker), but a guest
 *        PROVABLY owns nothing → emit BOTH sentinels (`order` + `payment`)
 *        unconditionally.
 *      - RULE B′ (authenticated): emit an `order` / `payment` sentinel IFF that
 *        dimension's enumeration MARKER (`active_orders:{customerId}` /
 *        `active_payments:{customerId}`, both written by the investigator) resolved
 *        PRESENT this turn AND its `count === 0` AND no positive ref of that kind
 *        exists this turn. The full conjunction is load-bearing per dimension: a
 *        marker ERRORED/ABSENT ("could not check") emits NOTHING (companion KEPT →
 *        honest UNKNOWN, the §O#15 falsifier); marker `count > 0` with no positive
 *        refs is the PARTIAL-LEDGER RACE (the enumeration saw active resources but
 *        every per-resource read errored — count is the only witness) and emits
 *        NOTHING; a positive ref (e.g. a model-extracted TERMINAL order whose read is
 *        present) suppresses that dimension's sentinel even at count 0. BKL-079 adds
 *        the PAYMENT mirror: the `active_payments` marker counts the customer's total
 *        payments (countByCustomer — see turn-reads.ts), so its `count === 0` is a
 *        STRICTER (sound, conservative) provable-empty witness than an active-only
 *        count.
 *
 * PURE; byte-identical when unwired (the seam is only threaded under the flag).
 */
export const activeResourcesFromLedger: ActiveResourcesForTurn = ({
  ledger,
  customerId,
}) => {
  const refs: ActiveResourceRef[] = [];

  // POSITIVE refs (see rule 1 above). Track whether a positive ORDER / PAYMENT ref
  // exists this turn — each Rule B′'s per-dimension suppression key.
  let hasPositiveOrderRef = false;
  let hasPositivePaymentRef = false;
  for (const { base, resourceId } of presentOwnerScopedResources(ledger)) {
    const kind = OWNER_SCOPED_BASE_TO_RESOURCE_KIND[base];
    if (kind === undefined) continue;
    if (kind === "order") hasPositiveOrderRef = true;
    if (kind === "payment") hasPositivePaymentRef = true;
    refs.push({ kind, id: resourceId });
  }

  // GUEST (#8a) — a guest provably owns nothing; emit BOTH provable-empty sentinels.
  // (A genuine guest has no owner-scoped read in the ledger, so this never
  // contradicts a positive ref.)
  if (!isAuthenticatedCustomer(customerId)) {
    refs.push({ kind: PROVABLY_EMPTY_KIND, id: "order" });
    refs.push({ kind: PROVABLY_EMPTY_KIND, id: "payment" });
    return refs;
  }

  // RULE B′ (authenticated) — the provable-empty ORDER sentinel fires ONLY on the
  // full CONJUNCTION: marker PRESENT ∧ marker count === 0 ∧ no positive order ref
  // this turn. Each conjunct closes a distinct wrong-drop hole:
  //   - marker "error"/"absent" ("could not check") → NO sentinel → companion KEPT →
  //     honest UNKNOWN (the §O#15 falsifier);
  //   - count > 0 with NO positive order refs → the PARTIAL-LEDGER RACE: the
  //     enumeration SUCCEEDED and saw active orders, but every per-order read errored,
  //     so no positive ref exists to suppress the sentinel — count===0 is the only
  //     witness distinguishing "provably none" from "has orders, reads failed";
  //   - count === 0 WITH a positive order ref (a model-extracted TERMINAL order whose
  //     read is present) → the positive ref suppresses the sentinel.
  // A malformed/unexpected marker value fails toward KEEPING the companion.
  const marker = ledger.resolve(`active_orders:${customerId}`);
  const markerValue =
    marker.state === "present"
      ? (marker.entry?.value as { count?: unknown } | undefined)
      : undefined;
  const provablyZero = typeof markerValue?.count === "number" && markerValue.count === 0;
  if (provablyZero && !hasPositiveOrderRef) {
    refs.push({ kind: PROVABLY_EMPTY_KIND, id: "order" });
  }

  // RULE B′ (PAYMENT — BKL-079) — the EXACT MIRROR of the order sentinel above, over
  // the `active_payments:{customerId}` enumeration marker (written by the
  // investigator's countActivePayments read). Emit the `payment` sentinel ONLY on the
  // full CONJUNCTION: marker PRESENT ∧ marker count === 0 ∧ no positive `payment` ref
  // (a present `payment_status:{orderId}` read) this turn. Each conjunct closes the
  // same wrong-drop hole as the order mirror:
  //   - marker "error"/"absent" ("could not check") → NO sentinel → payment companion
  //     KEPT → honest UNKNOWN (the §O#15 falsifier);
  //   - count > 0 with NO positive payment ref → the PARTIAL-LEDGER RACE → NO sentinel;
  //   - count === 0 WITH a positive payment ref → the positive ref suppresses it.
  // A malformed/unexpected marker value fails toward KEEPING the companion. NOTE: the
  // count is the customer's TOTAL payment count (countByCustomer counts ALL, incl.
  // terminal), so count===0 is a STRICTER (sound, conservative) provable-empty witness
  // than an active-only count would be (see turn-reads.ts countActivePayments).
  const paymentMarker = ledger.resolve(`active_payments:${customerId}`);
  const paymentMarkerValue =
    paymentMarker.state === "present"
      ? (paymentMarker.entry?.value as { count?: unknown } | undefined)
      : undefined;
  const paymentProvablyZero =
    typeof paymentMarkerValue?.count === "number" && paymentMarkerValue.count === 0;
  if (paymentProvablyZero && !hasPositivePaymentRef) {
    refs.push({ kind: PROVABLY_EMPTY_KIND, id: "payment" });
  }

  return refs;
};
