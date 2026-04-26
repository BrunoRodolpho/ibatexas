/**
 * adjudicate() — the pure deterministic heart of IBX-IGE.
 *
 * Takes a proposed IntentEnvelope, the current state snapshot, and a
 * PolicyBundle. Returns a single Decision. No LLM calls. No side effects. No
 * randomness. Same inputs always produce the same output — the replay harness
 * depends on this.
 *
 * Evaluation order (strict — do not reorder):
 *   1. Schema version — unknown versions are SECURITY refusals
 *   2. stateGuards   — legality of the transition the intent proposes
 *   3. authGuards    — caller identity and scope
 *   4. taint gate    — provenance check via canPropose()
 *   5. business      — domain-specific rules
 *   6. policy.default
 *
 * Each guard returning null contributes a "pass" basis to the final decision.
 */

import { basis, BASIS_CODES, type DecisionBasis } from "../basis-codes.js";
import { canPropose } from "../taint.js";
import {
  decisionExecute,
  decisionRefuse,
  type Decision,
} from "../decision.js";
import {
  hasUnknownEnvelopeVersion,
  INTENT_ENVELOPE_VERSION,
  type IntentEnvelope,
} from "../envelope.js";
import { refuse } from "../refusal.js";
import type { PolicyBundle } from "./policy.js";
import { makePassBasis } from "./basis.js";

export function adjudicate<K extends string, P, S>(
  envelope: IntentEnvelope<K, P>,
  state: S,
  policy: PolicyBundle<K, P, S>,
): Decision {
  const accumulated: DecisionBasis[] = [];

  // 1. Schema version gate — we accept only the known version. Callers that
  //    receive decoded JSON use hasUnknownEnvelopeVersion() upstream; this
  //    check is the last line of defense inside the kernel.
  if (envelope.version !== INTENT_ENVELOPE_VERSION) {
    return decisionRefuse(
      refuse(
        "SECURITY",
        "schema_version_unsupported",
        "Não foi possível processar essa ação no momento.",
        `Unknown envelope version: ${String((envelope as { version?: unknown }).version)}`,
      ),
      [
        basis("schema", BASIS_CODES.schema.VERSION_UNSUPPORTED, {
          seen: (envelope as { version?: unknown }).version,
          supported: INTENT_ENVELOPE_VERSION,
        }),
      ],
    );
  }
  accumulated.push(basis("schema", BASIS_CODES.schema.VERSION_SUPPORTED));

  // 2. State guards
  for (const guard of policy.stateGuards) {
    const d = guard(envelope, state);
    if (d !== null) return enrichBasis(d, accumulated);
  }
  accumulated.push(makePassBasis("state"));

  // 3. Auth guards
  for (const guard of policy.authGuards) {
    const d = guard(envelope, state);
    if (d !== null) return enrichBasis(d, accumulated);
  }
  accumulated.push(makePassBasis("auth"));

  // 4. Taint gate — declarative, driven by policy.taint.
  //    canPropose() is the single call — do not walk payload fields by inspection.
  //    When v1.1 ships field-level taint this call gains precision transparently.
  if (!canPropose(envelope.taint, envelope.kind, policy.taint)) {
    return decisionRefuse(
      refuse(
        "SECURITY",
        "taint_level_insufficient",
        "Não posso realizar essa ação com a informação disponível.",
        `Taint ${envelope.taint} insufficient for intent kind ${envelope.kind}`,
      ),
      [
        ...accumulated,
        basis("taint", BASIS_CODES.taint.LEVEL_INSUFFICIENT, {
          actual: envelope.taint,
          kind: envelope.kind,
        }),
      ],
    );
  }
  accumulated.push(makePassBasis("taint"));

  // 5. Business rules
  for (const guard of policy.business) {
    const d = guard(envelope, state);
    if (d !== null) return enrichBasis(d, accumulated);
  }
  accumulated.push(makePassBasis("business"));

  // 6. Policy default
  if (policy.default === "EXECUTE") {
    return decisionExecute(accumulated);
  }
  return decisionRefuse(
    refuse(
      "BUSINESS_RULE",
      "default_deny",
      "Essa ação não é permitida neste momento.",
    ),
    accumulated,
  );
}

/**
 * Prepend the accumulated "pass" bases to a Decision returned by a guard.
 * This preserves the full audit trail of everything that ran before the
 * short-circuit.
 */
function enrichBasis(decision: Decision, passed: DecisionBasis[]): Decision {
  const merged: DecisionBasis[] = [...passed, ...decision.basis];
  switch (decision.kind) {
    case "EXECUTE":
      return { kind: "EXECUTE", basis: merged };
    case "REFUSE":
      return { kind: "REFUSE", refusal: decision.refusal, basis: merged };
    case "ESCALATE":
      return {
        kind: "ESCALATE",
        to: decision.to,
        reason: decision.reason,
        basis: merged,
      };
    case "REQUEST_CONFIRMATION":
      return {
        kind: "REQUEST_CONFIRMATION",
        prompt: decision.prompt,
        basis: merged,
      };
    case "DEFER":
      return {
        kind: "DEFER",
        signal: decision.signal,
        timeoutMs: decision.timeoutMs,
        basis: merged,
      };
    case "REWRITE":
      return {
        kind: "REWRITE",
        rewritten: decision.rewritten,
        reason: decision.reason,
        basis: merged,
      };
  }
}
