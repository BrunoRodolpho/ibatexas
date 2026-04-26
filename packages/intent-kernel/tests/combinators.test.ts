import { describe, expect, it } from "vitest";
import {
  basis,
  BASIS_CODES,
  buildEnvelope,
  decisionExecute,
  decisionRefuse,
  refuse,
  type IntentEnvelope,
} from "@ibx/intent-core";
import { allOf, constant, firstMatch } from "../src/combinators.js";
import type { Guard } from "../src/policy.js";

type Kind = "order.tool.propose";
type State = null;

function env(): IntentEnvelope<Kind, { x: number }> {
  return buildEnvelope<Kind, { x: number }>({
    kind: "order.tool.propose",
    payload: { x: 1 },
    actor: { principal: "llm", sessionId: "s" },
    taint: "UNTRUSTED",
    createdAt: "2026-04-23T12:00:00.000Z",
  });
}

describe("allOf", () => {
  it("returns null when all guards return null", () => {
    const g: Guard<Kind, { x: number }, State> = allOf<Kind, { x: number }, State>(
      () => null,
      () => null,
      () => null,
    );
    expect(g(env(), null)).toBe(null);
  });

  it("returns the first non-null decision", () => {
    const refuseDecision = decisionRefuse(
      refuse("BUSINESS_RULE", "first", "first"),
      [basis("business", BASIS_CODES.business.RULE_VIOLATED)],
    );
    const g = allOf<Kind, { x: number }, State>(
      () => null,
      () => refuseDecision,
      () => decisionExecute([]),
    );
    const result = g(env(), null);
    expect(result).toBe(refuseDecision);
  });

  it("firstMatch is an alias for allOf", () => {
    expect(firstMatch).toBe(allOf);
  });
});

describe("constant", () => {
  it("always returns the same decision", () => {
    const d = decisionExecute([basis("state", BASIS_CODES.state.TRANSITION_VALID)]);
    const g = constant<Kind, { x: number }, State>(d);
    expect(g(env(), null)).toBe(d);
    expect(g(env(), null)).toBe(d);
  });
});
