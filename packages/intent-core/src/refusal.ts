/**
 * Refusal — stratified, first-class, never an exception.
 *
 * Four categories, each with distinct user-facing semantics:
 *  - SECURITY      → "I can't do that." (no detail to caller)
 *  - BUSINESS_RULE → "This isn't allowed in this state." (explain the rule)
 *  - AUTH          → "Please sign in / verify your phone."
 *  - STATE         → "That order has already shipped."
 */

export type RefusalKind = "SECURITY" | "BUSINESS_RULE" | "AUTH" | "STATE";

export interface Refusal {
  readonly kind: RefusalKind;
  /** Stable, machine-readable identifier, e.g. "post_order.forbidden_phrase". */
  readonly code: string;
  /** The text the end user sees — pt-BR in IbateXas per CLAUDE.md rule #4. */
  readonly userFacing: string;
  /** Operator/log-facing detail — may reveal internal reasoning. */
  readonly detail?: string;
}

export function refuse(
  kind: RefusalKind,
  code: string,
  userFacing: string,
  detail?: string,
): Refusal {
  return {
    kind,
    code,
    userFacing,
    ...(detail !== undefined ? { detail } : {}),
  };
}
