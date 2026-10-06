/**
 * resolution-signals — THE DECLARED CONTRACT for the resolver→guard honesty-floor
 * channel (R3-S2).
 *
 * ── WHAT THIS CHANNEL IS ─────────────────────────────────────────────────────
 *
 * The pre-adjudication resolve stage (`resolve-and-assemble.ts`) knows things no
 * guard can re-derive: that a money/booking target was GUESSED rather than named,
 * that an amend item never resolved to a catalog variant, that the customer's own
 * words contradict the payload the model filled. It hands each of those to the
 * kernel as ONE BOOLEAN (or, for F4, one integer) on `state.ctx`, and an
 * adopter/pack guard turns it into a REFUSE / REQUEST_CONFIRMATION. Raw prose
 * never crosses the seam — only these values do, which is exactly what makes them
 * model-unforgeable (see `confirmDeliveryContradiction`'s docblock in
 * `packages/pack-orders/src/policies.ts`).
 *
 * ── WHY IT NEEDED A CONTRACT ─────────────────────────────────────────────────
 *
 * `Ctx` is `Record<string, unknown>`, so before this module both ends of the
 * channel spelled the key as a bare string: five stamp sites wrote
 * `ctx.amendItemUnresolved = true`, and five guards re-declared the shape inline
 * (`(state as { ctx?: { amendItemUnresolved?: boolean } }).ctx?.…`). Every guard
 * here is LENIENT WHEN ABSENT — an absent key returns null, i.e. PASS. So a typo
 * on EITHER end compiled clean and left the guard SILENTLY INERT, and the failure
 * direction is the bad one: an un-guarded EXECUTE against a guessed target, or a
 * lost honesty floor that ships a found-implying confirm for an item that was
 * never found. Nothing in tsc, eslint, or any test would have said a word.
 *
 * The deliverable is therefore a COMPILE-TIME property, not a runtime check:
 * renaming a signal here breaks its stamp site AND its guard read at tsc, and an
 * undeclared key cannot be spelled through the accessors at all.
 *
 * ── THE SIX SIGNALS, AND WHO READS EACH ──────────────────────────────────────
 *
 *   autoResolvedMoneyRef    → `confirmOnAutoResolveGuard`         (compose-policy-packs.ts)
 *   allergenMentionDetected → `refuseAllergenMentionGuard`        (compose-policy-packs.ts)
 *   amendItemUnresolved     → `refuseUnresolvedAmendItemGuard`    (compose-policy-packs.ts)
 *   reviewProductUnresolved → `refuseUnresolvedReviewProductGuard`(compose-policy-packs.ts)
 *   sessionTokensConsumed   → `sessionTokenBudgetGuard`           (compose-policy-packs.ts)
 *   stayHomeDeliveryMarker  → `confirmDeliveryContradiction`      (@ibatexas/pack-orders)
 *
 * The last one is READ IN A PUBLISHED PACK, which cannot import from `apps/api`
 * (the dependency arrow only runs the other way). So its reader stays the pack's
 * own already-typed `state.ctx.stayHomeDeliveryMarker`, and this contract DERIVES
 * the field from `OrderState` instead of mirroring it by hand — the key name and
 * the value type are both pinned to the pack's declaration below, so a pack-side
 * rename breaks this module rather than silently orphaning the stamp.
 *
 * ── WHAT THIS SLICE DOES *NOT* CLOSE ─────────────────────────────────────────
 *
 * `Ctx` stays `Record<string, unknown>` (it carries ~60 other keys, and every
 * existing consumer reads them by string), so a FUTURE raw `ctx.newFlag = true`
 * outside these accessors is still expressible. What the accessors buy is that
 * every DECLARED signal has exactly one spelling, checked on both ends. Narrowing
 * `Ctx` itself, and the per-kind profile table that would say WHICH signals a kind
 * may carry, are a later slice.
 */

// The pack's own declaration of the one signal a PACK guard reads. Type-only, so
// nothing is added to this module's runtime graph.
import type { OrderState } from "@ibatexas/pack-orders";

/**
 * Every signal the resolve stage may hand a guard, with its declared value type.
 *
 * ALL OPTIONAL, DELIBERATELY: absence is the channel's PASS direction and the
 * whole reason the guards are safe to compose onto every pack. A signal is
 * stamped only on the turn that earned it (and never on the confirm-RESUME leg,
 * which re-resolves with no utterance text), so `undefined` is the normal case.
 *
 * The property NAMES are the wire: they are the literal `state.ctx` keys the
 * guards read, the keys existing tests assert on, and — for
 * `stayHomeDeliveryMarker` — a field of a published pack's public type. Renaming
 * one is a wire change, not a refactor; `__tests__/resolution-signals.test.ts`
 * pins the six strings against a hard-coded historical list for that reason.
 */
export interface ResolutionSignals {
  /**
   * TRUE when the resolve stage auto-resolved a money/booking target the customer
   * left implicit ("cancela meu pedido" → the most-recent order). Stamped by
   * `applyAutoResolve`'s verdict in `resolveAndAssemble`; read by
   * `confirmOnAutoResolveGuard`, which REQUEST_CONFIRMATIONs so a wrong guess can
   * never auto-execute. Absent on the resume leg (which carries the EXPLICIT id),
   * which is how the confirmed envelope gets re-adjudicated against fresh state.
   */
  readonly autoResolvedMoneyRef?: boolean;
  /**
   * FE-T14 — TRUE when a `customer.preferences.update` utterance was
   * allergen-shaped ("sou alérgico a amendoim, atualiza aí"). Read by
   * `refuseAllergenMentionGuard`: without it the unconditional
   * allergenExclusions strip+refill would silently "succeed" as a no-op on
   * exactly the turn where the customer asked to change their allergies.
   */
  readonly allergenMentionDetected?: boolean;
  /**
   * FE-D18 — TRUE when an `order.amend.add_item` item never resolved to a real
   * catalog variant. Read by `refuseUnresolvedAmendItemGuard`, which REFUSEs
   * BEFORE `confirmOnAutoResolveGuard` can park a doomed envelope behind a
   * found-implying "Confirma?" prompt.
   */
  readonly amendItemUnresolved?: boolean;
  /**
   * FE-D28 — TRUE when an `order.review.submit`'s reviewed product could not be
   * resolved to a single purchased line (no match, or several). Read by
   * `refuseUnresolvedReviewProductGuard`, same REFUSE-pre-empts-the-park posture
   * as the amend flag above.
   */
  readonly reviewProductUnresolved?: boolean;
  /**
   * BKL-280 — TRUE when the customer's OWN utterance carried a stay-home /
   * delivery-request marker. DERIVED FROM THE PACK, never mirrored: the reader is
   * `confirmDeliveryContradiction` in `@ibatexas/pack-orders`, whose typed field
   * this indexed access points at. If the pack renames or retypes the field, this
   * line fails to compile and the stamp site fails with it — which is the only
   * way a cross-package signal can be kept honest from this side.
   */
  readonly stayHomeDeliveryMarker?: OrderState["ctx"]["stayHomeDeliveryMarker"];
  /**
   * F4 / ADR-120 — the per-session cumulative LLM-token total, read back from
   * Redis for EVERY envelope. The one non-boolean signal: read by
   * `sessionTokenBudgetGuard` as a threshold, where absence means 0 (fail-OPEN by
   * design — a Redis hiccup must not REFUSE a customer's turn) rather than PASS.
   */
  readonly sessionTokensConsumed?: number;
}

/** Every declared signal name. An undeclared key is unrepresentable here. */
export type ResolutionSignalName = keyof ResolutionSignals;

/**
 * The boolean-valued signals — the honesty-FLOOR subset, where the guard-facing
 * question is only ever "is it exactly `true`?" (`resolutionSignalIsSet`).
 * Derived from the declaration above, so a new boolean signal joins it for free
 * and `sessionTokensConsumed` (a threshold, not a flag) stays out by type.
 */
export type BooleanResolutionSignalName = {
  [K in ResolutionSignalName]: NonNullable<ResolutionSignals[K]> extends boolean ? K : never;
}[ResolutionSignalName];

/**
 * The mutable per-turn `ctx` object the resolve stage stamps onto —
 * structurally `resolve-and-assemble.ts`'s exported `Ctx`.
 *
 * Declared here rather than imported so the contract has NO dependency on the
 * 2.8k-line resolver: `compose-policy-packs.ts` imports this module to READ the
 * signals, and a shared contract must not drag the resolver (and its domain
 * services / Redis / Medusa imports) into the policy-composition graph.
 */
export type ResolutionSignalSink = Record<string, unknown>;

// ── The named constants both ends spell the signal with ─────────────────────
//
// `satisfies` — never a `: ResolutionSignalName` annotation. The annotation would
// WIDEN each constant to the full union, and then a rename in `ResolutionSignals`
// would error HERE and nowhere else; the stamp sites and guard reads would keep
// compiling against a key nothing stamps. With `satisfies` each constant keeps its
// literal type, so a rename fails at this declaration AND at every call site that
// passes it — the compile-time property this slice exists to deliver.

export const AUTO_RESOLVED_MONEY_REF = "autoResolvedMoneyRef" satisfies ResolutionSignalName;
export const ALLERGEN_MENTION_DETECTED = "allergenMentionDetected" satisfies ResolutionSignalName;
export const AMEND_ITEM_UNRESOLVED = "amendItemUnresolved" satisfies ResolutionSignalName;
export const REVIEW_PRODUCT_UNRESOLVED = "reviewProductUnresolved" satisfies ResolutionSignalName;
/**
 * Pinned to BOTH sides of the cross-package seam: a declared signal name here AND
 * a real key of the pack ctx the reader indexes. A pack-side rename breaks this
 * line — the alternative (a hand-copied string) would leave the stamp writing a
 * key no guard reads, with no error anywhere.
 */
export const STAY_HOME_DELIVERY_MARKER = "stayHomeDeliveryMarker" satisfies
  ResolutionSignalName & keyof OrderState["ctx"];
export const SESSION_TOKENS_CONSUMED = "sessionTokensConsumed" satisfies ResolutionSignalName;

/**
 * The declared signals as a runtime list, exhaustive BY CONSTRUCTION:
 * `satisfies Record<ResolutionSignalName, true>` rejects a missing entry, and the
 * object-literal excess-property check rejects an undeclared one. So the
 * enumeration test (`__tests__/resolution-signals.test.ts`) cannot silently miss a
 * signal added to the interface — the table below stops compiling first.
 */
const SIGNAL_NAME_TABLE = {
  autoResolvedMoneyRef: true,
  allergenMentionDetected: true,
  amendItemUnresolved: true,
  reviewProductUnresolved: true,
  stayHomeDeliveryMarker: true,
  sessionTokensConsumed: true,
} as const satisfies Record<ResolutionSignalName, true>;

export const RESOLUTION_SIGNAL_NAMES: ReadonlyArray<ResolutionSignalName> = Object.keys(
  SIGNAL_NAME_TABLE,
) as ResolutionSignalName[];

/**
 * THE WRITER — the only way the resolve stage stamps a signal.
 *
 * One assignment, the declared key, a value of the declared type. Semantically
 * identical to the `ctx.<key> = <value>` it replaced (same key string, same value,
 * same point in the control flow, so ctx's key insertion order is unchanged and a
 * serialized ctx is byte-identical); what it adds is that `signal` must be a
 * DECLARED name and `value` must match that signal's declared type.
 *
 * Takes the sink as a parameter and mutates it (rather than returning a new
 * object) because every call site stamps onto a `ctx` that later loaders /
 * `stampPreviousOrderCtx` also write to — a copy here would silently drop their
 * fields.
 */
export function stampResolutionSignal<K extends ResolutionSignalName>(
  ctx: ResolutionSignalSink,
  signal: K,
  value: NonNullable<ResolutionSignals[K]>,
): void {
  ctx[signal] = value;
}

/**
 * THE READER — the typed read that replaces each guard's inline cast.
 *
 * Returns the DECLARED type (or `undefined` when absent), so each guard keeps its
 * own comparison and its own absent-key semantics: `?? 0` for the F4 threshold,
 * truthiness for the confirm extractor, `!== true` for the honesty floors. This
 * function deliberately decides NOTHING about the PASS direction — see
 * `resolutionSignalIsSet` for the one shape that is shared.
 *
 * `state` is `unknown` because that is what a `Guard<string, unknown, unknown>`
 * receives. The `state` access is NOT null-guarded on purpose: the casts this
 * replaces would throw on a null state, the kernel never passes one, and adding
 * tolerance here would be a behaviour change rather than a typing change.
 */
export function readResolutionSignal<K extends ResolutionSignalName>(
  state: unknown,
  signal: K,
): ResolutionSignals[K] | undefined {
  return (state as { ctx?: ResolutionSignals }).ctx?.[signal];
}

/**
 * The honesty-FLOOR predicate: is this boolean signal stamped?
 *
 * Exactly `value === true`, i.e. the `!== true → return null` test the three
 * REFUSE guards each wrote by hand. Absent, `false`, and any non-`true` value all
 * answer FALSE, which is the PASS direction — one place to read that rule instead
 * of three, and the reason a threshold signal is kept out of it by type
 * (`sessionTokensConsumed` fails OPEN at 0, not at "not true").
 */
export function resolutionSignalIsSet(
  state: unknown,
  signal: BooleanResolutionSignalName,
): boolean {
  return readResolutionSignal(state, signal) === true;
}
