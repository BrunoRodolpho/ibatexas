/**
 * Internal helpers for appending DecisionBasis entries as the kernel walks
 * through the PolicyBundle.
 *
 * The adjudicator collects bases from every guard that returns null (a "pass").
 * The final Decision carries this array so auditors can see every check that
 * ran, not only the one that made the final call.
 */

import { basis, BASIS_CODES, type DecisionBasis } from "@ibx/intent-core";

type PassCategory = "state" | "auth" | "taint" | "business";

export function makePassBasis(
  category: PassCategory,
): DecisionBasis<"state"> | DecisionBasis<"auth"> | DecisionBasis<"taint"> | DecisionBasis<"business"> {
  switch (category) {
    case "state":
      return basis("state", BASIS_CODES.state.TRANSITION_VALID);
    case "auth":
      return basis("auth", BASIS_CODES.auth.SCOPE_SUFFICIENT);
    case "taint":
      return basis("taint", BASIS_CODES.taint.LEVEL_PERMITTED);
    case "business":
      return basis("business", BASIS_CODES.business.RULE_SATISFIED);
  }
}
