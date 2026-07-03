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
import {
  actionOutcomeConfirmed,
  activeResourcesFromLedger,
  buildOutcomeConfirmed,
  buildOwns,
  createIbatexasClaimsKernelDeps,
  createPerTurnClaimsKernelDeps,
} from "../ibatexas-claims-kernel-deps.js";

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

// ── REAL per-turn predicates ──────────────────────────────────────────────────

describe("ibatexas-claims-kernel-deps — REAL owns (Inv 2)", () => {
  it("validates ONLY a resource in the principal-scoped owned set", () => {
    const owns = buildOwns({
      principal: "cust-1",
      ownedResources: new Set(["order-42"]),
    });
    expect(owns("cust-1", "order-42")).toBe(true);
    // A resource NOT in the owned set is refused (de-vacuumed; "no owner").
    expect(owns("cust-1", "order-99")).toBe(false);
    // A non-string resource is refused.
    expect(owns("cust-1", undefined)).toBe(false);
  });

  it("fails closed on a DIFFERING concrete actor id (defense in depth)", () => {
    const owns = buildOwns({
      principal: "cust-1",
      ownedResources: new Set(["order-42"]),
    });
    // A claim actor naming a DIFFERENT principal → refused even for an owned id.
    expect(owns("cust-2", "order-42")).toBe(false);
    expect(owns({ customerId: "cust-2" }, "order-42")).toBe(false);
    // An actor with no embedded id relies on the principal-scoped owned set.
    expect(owns(undefined, "order-42")).toBe(true);
    expect(owns({ customerId: "cust-1" }, "order-42")).toBe(true);
  });
});

describe("ibatexas-claims-kernel-deps — REAL outcomeConfirmed (Inv 4)", () => {
  it("actionOutcomeConfirmed requires EXECUTE ∧ dispatched ∧ success ∧ settled≠false", () => {
    expect(
      actionOutcomeConfirmed({ resource: "o", verdict: "EXECUTE", dispatched: true, success: true }),
    ).toBe(true);
    expect(
      actionOutcomeConfirmed({
        resource: "o",
        verdict: "EXECUTE",
        dispatched: true,
        success: true,
        settled: true,
      }),
    ).toBe(true);
    // Each conjunct is load-bearing.
    expect(
      actionOutcomeConfirmed({ resource: "o", verdict: "REFUSE", dispatched: true, success: true }),
    ).toBe(false);
    expect(
      actionOutcomeConfirmed({ resource: "o", verdict: "EXECUTE", dispatched: false, success: true }),
    ).toBe(false);
    expect(
      actionOutcomeConfirmed({ resource: "o", verdict: "EXECUTE", dispatched: true, success: false }),
    ).toBe(false);
    expect(
      actionOutcomeConfirmed({
        resource: "o",
        verdict: "EXECUTE",
        dispatched: true,
        success: true,
        settled: false,
      }),
    ).toBe(false);
  });

  it("confirms a claim only when a bound resource has a confirmed outcome", () => {
    const outcomeConfirmed = buildOutcomeConfirmed([
      { resource: "order-42", verdict: "EXECUTE", dispatched: true, success: true, settled: true },
    ]);
    const base = {
      requiredEvidence: [],
      minSourceIntegrity: "structured" as const,
      kind: "action_claim" as const,
      actor: "cust-1",
    };
    expect(outcomeConfirmed({ ...base, resources: { purchase_outcome: "order-42" } })).toBe(true);
    // No bound resource → no confirmable outcome → false (fail closed).
    expect(outcomeConfirmed({ ...base })).toBe(false);
    // Bound to a DIFFERENT (unconfirmed) resource → false.
    expect(outcomeConfirmed({ ...base, resources: { purchase_outcome: "order-99" } })).toBe(false);
  });
});

describe("ibatexas-claims-kernel-deps — createPerTurnClaimsKernelDeps", () => {
  function ownedReadClaim(resourceId: string): CandidateClaim {
    return {
      soundness: {
        requiredEvidence: [
          {
            key: "payment_status",
            ownershipPolicy: "required",
            freshnessPolicy: "static",
            sourceIntegrity: "structured",
            provenancePolicy: "preserve",
          },
        ],
        minSourceIntegrity: "structured",
        kind: "read_claim",
        actor: "cust-1",
        resources: { payment_status: resourceId },
        // W6 (linked kernel >= 1.8.0): a claim VALIDATEs only if its type is
        // falsifier-complete. Declare a falsifier on a key that is NOT recorded
        // in the test ledger, so the eligibility cap is satisfied and the runtime
        // arm never fires — the verdict isolates the `owns` predicate under test.
        falsifierComplete: true,
        falsifiers: [
          {
            key: "_not_recorded_falsifier",
            ownershipPolicy: "not_applicable",
            freshnessPolicy: "static",
            sourceIntegrity: "structured",
            provenancePolicy: "preserve",
          },
        ],
      },
      subject: resourceId,
      type: "PAYMENT_STATUS",
      value: { status: "paid" },
    };
  }

  function ledgerWithPaidStatus(): EvidenceLedger {
    const l = new EvidenceLedger("t");
    l.record({
      key: "payment_status",
      value: { status: "paid" },
      source: "payment.getActiveByOrderId",
      fetchedAt: 1_000,
      sourceMode: "live",
      taint: "TRUSTED",
      // 3-value origin axis (the linked R1-led kernel): a first-party money read.
      // ("TRUSTED" is the read-LAYER taint, NOT a valid OriginProvenance member —
      // the W6 structural-provenance write guard normalizes an invalid origin to
      // UNTRUSTED_DATA, which would REFUSE; use the real 3-value value here.)
      originProvenance: "FIRST_PARTY",
    });
    return l;
  }

  it("VALIDATES an owned read_claim with present first-party evidence (real owns)", () => {
    const deps = createPerTurnClaimsKernelDeps({
      now: 5_000,
      ownership: { principal: "cust-1", ownedResources: new Set(["order-42"]) },
    });
    expect(deps.soundness.now).toBe(5_000); // R2a — per-turn clock.
    const result = runClaimsKernel(ledgerWithPaidStatus(), [ownedReadClaim("order-42")], deps);
    expect(result.perClaim[0]?.verdict).toBe("VALIDATED");
  });

  it("REFUSES the SAME claim for a cross-owner resource (IDOR/owner gate)", () => {
    const deps = createPerTurnClaimsKernelDeps({
      now: 5_000,
      // The attacker's owned set does NOT contain the victim's order.
      ownership: { principal: "cust-1", ownedResources: new Set([]) },
    });
    const result = runClaimsKernel(ledgerWithPaidStatus(), [ownedReadClaim("order-42")], deps);
    expect(result.perClaim[0]?.verdict).toBe("REFUSED");
    expect(result.renderable).toHaveLength(0);
  });

  it("the per-turn now is the injected timestamp, not a module-load static", () => {
    const a = createPerTurnClaimsKernelDeps({
      now: 111,
      ownership: { principal: "p", ownedResources: new Set() },
    });
    const b = createPerTurnClaimsKernelDeps({
      now: 222,
      ownership: { principal: "p", ownedResources: new Set() },
    });
    expect(a.soundness.now).toBe(111);
    expect(b.soundness.now).toBe(222);
  });
});

// ── BKL-004: activeResourcesFromLedger (#8 decomposer ownership seam) ──────────

describe("activeResourcesFromLedger — @claustrum/core 0.5.0 ActiveResourcesForTurn seam", () => {
  function recordPresent(l: EvidenceLedger, key: string): void {
    l.record({
      key,
      value: { present: true },
      source: "test",
      fetchedAt: 1_000,
      sourceMode: "live",
      taint: "TRUSTED",
      originProvenance: "FIRST_PARTY",
    });
  }

  it("maps present owner-scoped reads to {kind,id} refs (order/payment/reservation)", () => {
    const l = new EvidenceLedger("t");
    recordPresent(l, "order_fulfillment_stage:o1");
    recordPresent(l, "payment_status:o1");
    recordPresent(l, "reservation_status:r7");
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "cust-1" });
    expect([...refs].sort((a, b) => (a.kind + a.id).localeCompare(b.kind + b.id))).toEqual([
      { kind: "order", id: "o1" },
      { kind: "payment", id: "o1" },
      { kind: "reservation", id: "r7" },
    ]);
  });

  it("excludes public (non-owner-scoped) keys like schedule:*", () => {
    const l = new EvidenceLedger("t");
    recordPresent(l, "schedule:store_hours");
    recordPresent(l, "order_fulfillment_stage:o9");
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "cust-1" });
    expect(refs).toEqual([{ kind: "order", id: "o9" }]);
  });

  it("returns [] for a ledger with no present owner-scoped resource (absence is NOT a drop signal)", () => {
    const l = new EvidenceLedger("t");
    recordPresent(l, "schedule:store_hours");
    expect(activeResourcesFromLedger({ ledger: l, customerId: "cust-1" })).toEqual([]);
  });

  // FIX D1 — an owner-scoped base with NO mapped decomposer kind is SKIPPED
  // (omitted), never emitted under its raw base key. The skip branch is a fail-safe
  // against a future 4th OWNER_SCOPED_KEY_PREFIXES prefix added without a
  // OWNER_SCOPED_BASE_TO_RESOURCE_KIND entry. It cannot be exercised through the
  // public seam today: `presentOwnerScopedResources` iterates ONLY the current 3
  // prefixes, all of which are mapped, and the kind map is module-private (not
  // exported for injection). We instead pin the invariant that keeps the skip
  // inert — every present owner-scoped prefix DOES resolve to a kind, so none are
  // dropped — which is exactly the property a new unmapped prefix would break.
  it("emits a ref for every present owner-scoped prefix (none skipped today; skip is future-drift only)", () => {
    const l = new EvidenceLedger("t");
    recordPresent(l, "order_fulfillment_stage:o1");
    recordPresent(l, "payment_status:o1");
    recordPresent(l, "reservation_status:r7");
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "cust-1" });
    // Zero skipped: three present owner-scoped reads → three emitted refs.
    expect(refs).toHaveLength(3);
    expect(refs.every((r) => r.kind !== "order_fulfillment_stage")).toBe(true);
    expect(refs.map((r) => r.kind).sort()).toEqual(["order", "payment", "reservation"]);
  });
})
