/**
 * PolicyBundle — the pluggable policy surface that drives adjudicate().
 *
 * An adopter builds one PolicyBundle per domain (order, appointment, shipment).
 * The kernel remains state-agnostic; the bundle carries every domain rule.
 *
 * Guards run in four categories, evaluated in this fixed order:
 *   state → auth → taint → business
 *
 * Each guard returns `Decision | null`. `null` means "this guard has no opinion —
 * continue evaluating." A non-null Decision short-circuits.
 */

import type {
  Decision,
  IntentEnvelope,
  TaintPolicy,
} from "@ibx/intent-core";

export type Guard<K extends string, P, S> = (
  envelope: IntentEnvelope<K, P>,
  state: S,
) => Decision | null;

export interface PolicyBundle<K extends string, P, S> {
  readonly stateGuards: ReadonlyArray<Guard<K, P, S>>;
  readonly authGuards: ReadonlyArray<Guard<K, P, S>>;
  /** Declares the minimum Taint required per intent kind. */
  readonly taint: TaintPolicy;
  readonly business: ReadonlyArray<Guard<K, P, S>>;
  /**
   * Behavior when every guard returns null.
   *  - "REFUSE": fail-safe default (recommended — aligns with Refusal-by-Design)
   *  - "EXECUTE": fail-open default (use only for read-only or confirmation intents)
   */
  readonly default: "REFUSE" | "EXECUTE";
}
