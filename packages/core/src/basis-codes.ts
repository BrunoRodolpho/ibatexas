/**
 * BASIS_CODES — vocabulary-controlled decision basis codes.
 *
 * Every DecisionBasis emitted by adjudicate() must have its `code` drawn from
 * the per-category constant here. This prevents semantic drift ("scope_ok" vs
 * "scope_sufficient" vs "scope-valid") in audit records. Adopters extend via
 * module augmentation, not free-form strings.
 *
 * See docs/basis-codes.md for extension guidelines.
 */

export type BasisCategory =
  | "state"
  | "auth"
  | "taint"
  | "ledger"
  | "schema"
  | "business"
  | "validation";

export const BASIS_CODES = {
  state: {
    TRANSITION_VALID: "transition_valid",
    TRANSITION_ILLEGAL: "transition_illegal",
    TERMINAL_STATE: "terminal_state",
  },
  auth: {
    SCOPE_SUFFICIENT: "scope_sufficient",
    SCOPE_INSUFFICIENT: "scope_insufficient",
    IDENTITY_MISSING: "identity_missing",
    IDENTITY_EXPIRED: "identity_expired",
  },
  taint: {
    LEVEL_PERMITTED: "level_permitted",
    LEVEL_INSUFFICIENT: "level_insufficient",
    PROPAGATION_VIOLATION: "propagation_violation",
  },
  ledger: {
    FRESH: "fresh",
    REPLAY_SUPPRESSED: "replay_suppressed",
    RESOURCE_VERSION_STALE: "resource_version_stale",
  },
  schema: {
    VERSION_SUPPORTED: "version_supported",
    VERSION_UNSUPPORTED: "version_unsupported",
    PAYLOAD_INVALID: "payload_invalid",
  },
  business: {
    RULE_SATISFIED: "rule_satisfied",
    RULE_VIOLATED: "rule_violated",
    QUANTITY_CAPPED: "quantity_capped",
  },
  validation: {
    FORBIDDEN_PHRASE_ABSENT: "forbidden_phrase_absent",
    HOMOGLYPH_NORMALIZED: "homoglyph_normalized",
    UNICODE_NORMALIZED: "unicode_normalized",
  },
} as const;

export type BasisCodesMap = typeof BASIS_CODES;

// Distributive — forces the mapped lookup to happen per-branch of the union,
// otherwise `keyof BasisCodesMap[BasisCategory]` collapses to `never`.
export type BasisCode<C extends BasisCategory> = C extends BasisCategory
  ? BasisCodesMap[C][keyof BasisCodesMap[C]]
  : never;

// Distributive so `DecisionBasis<"state" | "auth">` is the union of the two
// category-specific shapes (each with its own narrow `code` type), not a
// single shape with an impossible `code`.
export type DecisionBasis<C extends BasisCategory = BasisCategory> =
  C extends BasisCategory
    ? {
        readonly category: C;
        readonly code: BasisCode<C>;
        readonly detail?: Record<string, unknown>;
      }
    : never;

/**
 * Runtime guard — confirms a DecisionBasis carries a known code for its category.
 * Used by the "basis vocabulary purity" invariant test to catch drift before it
 * reaches an audit sink.
 */
export function isKnownBasisCode<C extends BasisCategory>(
  basis: DecisionBasis<C>,
): boolean {
  const codes = BASIS_CODES[basis.category];
  if (!codes) return false;
  return (Object.values(codes) as string[]).includes(basis.code as string);
}

/**
 * Typed helper to construct a basis with compile-time vocabulary enforcement.
 * Prefer this over raw object literals at call sites.
 */
export function basis<C extends BasisCategory>(
  category: C,
  code: BasisCode<C>,
  detail?: Record<string, unknown>,
): DecisionBasis<C> {
  return {
    category,
    code,
    ...(detail !== undefined ? { detail } : {}),
  } as DecisionBasis<C>;
}
