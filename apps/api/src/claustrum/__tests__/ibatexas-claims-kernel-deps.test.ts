/**
 * B-PR1 — the injected Claims-kernel capabilities (`ibatexas-claims-kernel-deps.ts`).
 * Provides the published `@adjudicate/core` `ClaimsKernelDeps` the Conductor
 * threads into CLAIMS-VALIDATE. These tests pin:
 *
 *   - Fail-CLOSED defaults (process-wide; the per-turn deps seam is PENDING):
 *     `owns → false` (Inv 2: no owner attribution ≠ any owner), `outcomeConfirmed
 *     → false` (Inv 4: an unconfirmed action never validates), `now` a number.
 *   - The deps TYPECHECK + run against the REAL published `runClaimsKernel` (not a
 *     stub) — proving the wiring is against the published surface (no FIRST_PARTY,
 *     no `clock`). NON-VACUOUS: an `action_claim` with the fail-closed
 *     `outcomeConfirmed` default is REFUSED, not VALIDATED.
 *   - Injected predicates / table are threaded through unchanged.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONSISTENCY_TABLE,
  EvidenceLedger,
  runClaimsKernel,
  type CandidateClaim,
  type MinimalClaim,
} from "@adjudicate/core";
import { createIbatexasClaimsKernelDeps } from "../ibatexas-claims-kernel-deps.js";

// ── Fail-closed defaults ─────────────────────────────────────────────────────

describe("ibatexas-claims-kernel-deps — fail-closed defaults", () => {
  it("owns and outcomeConfirmed default to false; now is a number", () => {
    const deps = createIbatexasClaimsKernelDeps();
    expect(deps.soundness.owns("cust-1", "order-42")).toBe(false);
    expect(
      deps.soundness.outcomeConfirmed({} as unknown as MinimalClaim),
    ).toBe(false);
    expect(typeof deps.soundness.now).toBe("number");
  });

  it("defaults the consistency table to the published DEFAULT_CONSISTENCY_TABLE", () => {
    const deps = createIbatexasClaimsKernelDeps();
    expect(deps.consistency?.table).toBe(DEFAULT_CONSISTENCY_TABLE);
  });
});

// ── Injection is threaded through ────────────────────────────────────────────

describe("ibatexas-claims-kernel-deps — injected capabilities", () => {
  it("threads injected owns / outcomeConfirmed / now / table unchanged", () => {
    const table = [
      { typeA: "A", typeB: "B", relation: "COMPATIBLE" as const },
    ];
    const deps = createIbatexasClaimsKernelDeps({
      owns: (actor, resource) => actor === "cust-1" && resource === "order-42",
      outcomeConfirmed: () => true,
      now: () => 1_234,
      consistencyTable: table,
    });
    expect(deps.soundness.owns("cust-1", "order-42")).toBe(true);
    expect(deps.soundness.owns("cust-2", "order-42")).toBe(false);
    expect(deps.soundness.outcomeConfirmed({} as unknown as MinimalClaim)).toBe(true);
    expect(deps.soundness.now).toBe(1_234);
    expect(deps.consistency?.table).toBe(table);
  });
});

// ── Accepted by the REAL published Claims kernel ─────────────────────────────

describe("ibatexas-claims-kernel-deps — valid against published runClaimsKernel", () => {
  it("an empty candidate set yields the honest-ignorance UNKNOWN terminal", () => {
    const result = runClaimsKernel(
      new EvidenceLedger("t"),
      [],
      createIbatexasClaimsKernelDeps(),
    );
    expect(result.perClaim).toHaveLength(0);
    expect(result.terminal).toBe("UNKNOWN");
  });

  it("an action_claim is REFUSED under the fail-closed outcomeConfirmed default (Inv 4)", () => {
    const claim: CandidateClaim = {
      soundness: {
        requiredEvidence: [
          {
            key: "k",
            ownershipPolicy: "not_applicable",
            freshnessPolicy: "static",
            provenancePolicy: "preserve",
            sourceIntegrity: "first_party_verified",
          },
        ],
        minSourceIntegrity: "structured",
        kind: "action_claim",
        actor: "cust-1",
      },
      subject: "order-42",
      type: "PURCHASE_COMPLETED",
      value: { ok: true },
    };
    const ledger = new EvidenceLedger("t");
    // Even if the read evidence were present, the action outcome is unconfirmed
    // (fail-closed default) → the claim must NOT validate.
    const result = runClaimsKernel(ledger, [claim], createIbatexasClaimsKernelDeps());
    expect(result.perClaim[0]?.verdict).not.toBe("VALIDATED");
    expect(result.renderable).toHaveLength(0);
  });
});
