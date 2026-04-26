/**
 * Invariant: UNTRUSTED never yields EXECUTE (when policy demands TRUSTED or higher).
 *
 * This is the load-bearing property of the Zero-Trust bridge. If it fails once,
 * the kernel has a path by which user-origin content escalates authority.
 *
 * Phrased as an invariant over the *outcome*, not over the implementation —
 * regardless of which guard, which state, or which business rule, an UNTRUSTED
 * envelope MUST NOT produce EXECUTE for an intent kind whose policy demands
 * TRUSTED/SYSTEM.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  buildEnvelope,
  type IntentEnvelope,
  type Taint,
  type TaintPolicy,
} from "@adjudicate/intent-core";
import { adjudicate } from "../../src/adjudicate.js";
import type { PolicyBundle } from "../../src/policy.js";

const taintArb = fc.constantFrom<Taint>("SYSTEM", "TRUSTED", "UNTRUSTED");

const HIGH_TRUST_KINDS = [
  "payment.send",
  "order.submit",
  "pix.send",
  "refund.issue",
] as const;

const intentKindArb = fc.constantFrom(...HIGH_TRUST_KINDS);

const hightrustPolicy: TaintPolicy = {
  minimumFor: () => "SYSTEM",
};

function emptyBundle(
  defaultKind: "REFUSE" | "EXECUTE" = "EXECUTE",
): PolicyBundle<string, unknown, unknown> {
  return {
    stateGuards: [],
    authGuards: [],
    taint: hightrustPolicy,
    business: [],
    default: defaultKind,
  };
}

function env(
  kind: string,
  taint: Taint,
): IntentEnvelope<string, { x: number }> {
  return buildEnvelope<string, { x: number }>({
    kind,
    payload: { x: 1 },
    actor: { principal: "llm", sessionId: "s" },
    taint,
    createdAt: "2026-04-23T12:00:00.000Z",
  });
}

describe("invariant: UNTRUSTED never yields EXECUTE when policy demands SYSTEM", () => {
  it("holds for any UNTRUSTED envelope and any high-trust intent kind", () => {
    fc.assert(
      fc.property(intentKindArb, (kind) => {
        const decision = adjudicate(env(kind, "UNTRUSTED"), {}, emptyBundle());
        expect(decision.kind).not.toBe("EXECUTE");
      }),
      { numRuns: 10_000 },
    );
  });

  it("holds when the default is EXECUTE (fail-open default must still refuse taint)", () => {
    fc.assert(
      fc.property(intentKindArb, (kind) => {
        const decision = adjudicate(
          env(kind, "UNTRUSTED"),
          {},
          emptyBundle("EXECUTE"),
        );
        expect(decision.kind).not.toBe("EXECUTE");
      }),
      { numRuns: 10_000 },
    );
  });

  it("holds when the default is REFUSE", () => {
    fc.assert(
      fc.property(intentKindArb, (kind) => {
        const decision = adjudicate(
          env(kind, "UNTRUSTED"),
          {},
          emptyBundle("REFUSE"),
        );
        expect(decision.kind).not.toBe("EXECUTE");
      }),
      { numRuns: 10_000 },
    );
  });
});

describe("invariant: TRUSTED never yields EXECUTE when policy demands SYSTEM", () => {
  it("blocks TRUSTED from SYSTEM-minimum kinds", () => {
    fc.assert(
      fc.property(intentKindArb, (kind) => {
        const decision = adjudicate(env(kind, "TRUSTED"), {}, emptyBundle());
        expect(decision.kind).not.toBe("EXECUTE");
      }),
      { numRuns: 10_000 },
    );
  });
});

describe("invariant: SYSTEM passes the taint gate for any intent kind", () => {
  it("allows SYSTEM-taint envelopes through the taint layer", () => {
    fc.assert(
      fc.property(intentKindArb, (kind) => {
        const decision = adjudicate(env(kind, "SYSTEM"), {}, emptyBundle());
        expect(decision.kind).toBe("EXECUTE");
      }),
      { numRuns: 10_000 },
    );
  });
});

describe("invariant: taint-only test, no other guards fire", () => {
  it("the refusal carries taint basis when it short-circuits on taint", () => {
    fc.assert(
      fc.property(taintArb, intentKindArb, (taint, kind) => {
        const decision = adjudicate(env(kind, taint), {}, emptyBundle());
        if (taint !== "SYSTEM") {
          expect(decision.kind).toBe("REFUSE");
          if (decision.kind !== "REFUSE") return;
          expect(
            decision.basis.some(
              (b) => b.category === "taint" && b.code === "level_insufficient",
            ),
          ).toBe(true);
        }
      }),
      { numRuns: 10_000 },
    );
  });
});
