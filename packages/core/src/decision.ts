/**
 * Decision — the 6-valued output of adjudicate(envelope, state, policy).
 *
 *   EXECUTE              → mutation is authorized; proceed to side effect
 *   REFUSE               → not allowed; surface a typed Refusal to the user
 *   ESCALATE             → defer to a human or supervisor; block until resolved
 *   REQUEST_CONFIRMATION → ask the user to re-confirm, then re-adjudicate
 *   DEFER                → valid but awaits an external signal (e.g. payment webhook)
 *   REWRITE              → kernel substitutes a sanitized/normalized/capped envelope
 *
 * REWRITE is scope-restricted: sanitization, normalization, and safe mechanical
 * capping only. Never business transformation. See @adjudicate/intent-kernel/README.md.
 */

import type { IntentEnvelope } from "./envelope.js";
import type { DecisionBasis } from "./basis-codes.js";
import type { Refusal } from "./refusal.js";

export type DecisionKind =
  | "EXECUTE"
  | "REFUSE"
  | "ESCALATE"
  | "REQUEST_CONFIRMATION"
  | "DEFER"
  | "REWRITE";

export type Decision =
  | { kind: "EXECUTE"; basis: readonly DecisionBasis[] }
  | { kind: "REFUSE"; refusal: Refusal; basis: readonly DecisionBasis[] }
  | {
      kind: "ESCALATE";
      to: "human" | "supervisor";
      reason: string;
      basis: readonly DecisionBasis[];
    }
  | {
      kind: "REQUEST_CONFIRMATION";
      prompt: string;
      basis: readonly DecisionBasis[];
    }
  | {
      kind: "DEFER";
      signal: string;
      timeoutMs: number;
      basis: readonly DecisionBasis[];
    }
  | {
      kind: "REWRITE";
      rewritten: IntentEnvelope;
      reason: string;
      basis: readonly DecisionBasis[];
    };

/** Construct an EXECUTE decision with the given basis list. */
export function decisionExecute(basis: readonly DecisionBasis[]): Decision {
  return { kind: "EXECUTE", basis };
}

export function decisionRefuse(
  refusal: Refusal,
  basis: readonly DecisionBasis[],
): Decision {
  return { kind: "REFUSE", refusal, basis };
}

export function decisionEscalate(
  to: "human" | "supervisor",
  reason: string,
  basis: readonly DecisionBasis[],
): Decision {
  return { kind: "ESCALATE", to, reason, basis };
}

export function decisionRequestConfirmation(
  prompt: string,
  basis: readonly DecisionBasis[],
): Decision {
  return { kind: "REQUEST_CONFIRMATION", prompt, basis };
}

export function decisionDefer(
  signal: string,
  timeoutMs: number,
  basis: readonly DecisionBasis[],
): Decision {
  return { kind: "DEFER", signal, timeoutMs, basis };
}

export function decisionRewrite(
  rewritten: IntentEnvelope,
  reason: string,
  basis: readonly DecisionBasis[],
): Decision {
  return { kind: "REWRITE", rewritten, reason, basis };
}
