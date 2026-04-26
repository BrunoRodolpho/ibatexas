/**
 * Invariant: Schema-version fuzz safety.
 *
 * Any IntentEnvelope with a version that is NOT the current supported version
 * must produce REFUSE { kind: "SECURITY", code: "schema_version_unsupported" }.
 *
 * This protects against future rollback attacks: if an adversary somehow
 * crafts a v2 envelope before v2 ships, the current kernel must refuse rather
 * than silently accept malformed data.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  buildEnvelope,
  INTENT_ENVELOPE_VERSION,
  type IntentEnvelope,
} from "@adjudicate/core";
import { adjudicate } from "../../src/adjudicate.js";
import type { PolicyBundle } from "../../src/policy.js";

const permissiveBundle: PolicyBundle<string, unknown, unknown> = {
  stateGuards: [],
  authGuards: [],
  taint: { minimumFor: () => "UNTRUSTED" },
  business: [],
  default: "EXECUTE",
};

function base(): IntentEnvelope<string, { x: number }> {
  return buildEnvelope<string, { x: number }>({
    kind: "order.tool.propose",
    payload: { x: 1 },
    actor: { principal: "llm", sessionId: "s" },
    taint: "SYSTEM",
    createdAt: "2026-04-23T12:00:00.000Z",
  });
}

describe("invariant: schema-version fuzz safety", () => {
  it("any non-current version → REFUSE with security code", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 30 }).filter((v) => v !== INTENT_ENVELOPE_VERSION),
        (badVersion) => {
          const env = { ...base(), version: badVersion as 1 };
          const decision = adjudicate(env, {}, permissiveBundle);
          expect(decision.kind).toBe("REFUSE");
          if (decision.kind !== "REFUSE") return;
          expect(decision.refusal.kind).toBe("SECURITY");
          expect(decision.refusal.code).toBe("schema_version_unsupported");
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it("the current version always passes the schema gate", () => {
    const decision = adjudicate(base(), {}, permissiveBundle);
    expect(decision.kind).toBe("EXECUTE");
  });
});
