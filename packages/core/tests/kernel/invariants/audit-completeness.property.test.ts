/**
 * Invariant: Audit completeness.
 *
 * Every Decision returned by adjudicate() carries a non-empty basis array.
 * No silent decisions — an auditor should always see what was checked.
 *
 * Additionally: every buildAuditRecord(envelope, decision, ...) produces a
 * record whose decision_basis matches the decision's basis. The two must
 * never diverge.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  buildAuditRecord,
  buildEnvelope,
  type IntentEnvelope,
  type Taint,
  type TaintPolicy,
} from "@adjudicate/core";
import { adjudicate } from "../../src/adjudicate.js";
import type { PolicyBundle } from "../../src/policy.js";

const taintArb = fc.constantFrom<Taint>("SYSTEM", "TRUSTED", "UNTRUSTED");
const defaultArb = fc.constantFrom<"REFUSE" | "EXECUTE">("REFUSE", "EXECUTE");

function env(taint: Taint): IntentEnvelope<string, { x: number }> {
  return buildEnvelope<string, { x: number }>({
    kind: "order.tool.propose",
    payload: { x: 1 },
    actor: { principal: "llm", sessionId: "s" },
    taint,
    createdAt: "2026-04-23T12:00:00.000Z",
  });
}

const permissiveTaint: TaintPolicy = { minimumFor: () => "UNTRUSTED" };

function bundle(
  def: "REFUSE" | "EXECUTE",
): PolicyBundle<string, unknown, unknown> {
  return {
    stateGuards: [],
    authGuards: [],
    taint: permissiveTaint,
    business: [],
    default: def,
  };
}

describe("invariant: every decision carries a non-empty basis", () => {
  it("holds across taint × default matrix", () => {
    fc.assert(
      fc.property(taintArb, defaultArb, (taint, def) => {
        const decision = adjudicate(env(taint), {}, bundle(def));
        expect(decision.basis.length).toBeGreaterThan(0);
      }),
      { numRuns: 10_000 },
    );
  });
});

describe("invariant: audit record basis matches decision basis", () => {
  it("decision_basis === decision.basis for every produced record", () => {
    fc.assert(
      fc.property(taintArb, defaultArb, (taint, def) => {
        const decision = adjudicate(env(taint), {}, bundle(def));
        const record = buildAuditRecord({
          envelope: env(taint),
          decision,
          durationMs: 1,
        });
        expect(record.decision_basis).toEqual(decision.basis);
      }),
      { numRuns: 10_000 },
    );
  });
});
