/**
 * Policy combinators — compose guards without boilerplate.
 *
 *   allOf(g1, g2, g3)    — returns the first non-null Decision, or null if all pass
 *   firstMatch(...)      — alias for allOf with clearer semantics at call site
 *   negate(guard, ...)   — inverts a pass/fail semantic for REWRITE-style logic
 *   constant(decision)   — always returns the given Decision (useful in tests)
 */

import type { Decision } from "@ibx/intent-core";
import type { Guard } from "./policy.js";

export function allOf<K extends string, P, S>(
  ...guards: ReadonlyArray<Guard<K, P, S>>
): Guard<K, P, S> {
  return (envelope, state) => {
    for (const g of guards) {
      const d = g(envelope, state);
      if (d !== null) return d;
    }
    return null;
  };
}

/** Semantic alias — emphasize that we return the first guard that expresses an opinion. */
export const firstMatch = allOf;

export function constant<K extends string, P, S>(
  decision: Decision,
): Guard<K, P, S> {
  return () => decision;
}
