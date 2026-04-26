/**
 * CapabilityPlanner — security-sensitive layer.
 *
 * Reads (state, context) and returns a Plan: which READ tools are visible,
 * which Intent kinds may be proposed, and which concepts are forbidden.
 *
 * This is where "what can the LLM even see right now?" is decided. A
 * misbehaving planner widens the attack surface. Adopters MUST unit-test
 * the planner at byte level — the PromptRenderer that consumes it is only
 * cosmetic.
 */

export interface Plan {
  /** READ tools the LLM may call directly this turn. */
  readonly visibleReadTools: ReadonlyArray<string>;
  /** Intent kinds the LLM may propose via the intent bridge. */
  readonly allowedIntents: ReadonlyArray<string>;
  /** Free-text phrases the LLM MUST NOT emit in this state. */
  readonly forbiddenConcepts: ReadonlyArray<string>;
}

export interface CapabilityPlanner<S, C = unknown> {
  plan(state: S, context: C): Plan;
}

/**
 * A trivial planner that returns the fixed plan it was constructed with.
 * Useful for tests and for adopters that want a hand-written plan per state.
 */
export function staticPlanner<S, C = unknown>(plan: Plan): CapabilityPlanner<S, C> {
  return { plan: () => plan };
}
