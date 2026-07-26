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
  checkConsistency,
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
  IBATEXAS_CONSISTENCY_TABLE,
  PROVABLY_EMPTY_KIND,
  SCHEDULE_CLUSTER_COMPATIBLE,
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

  it("defaults the consistency table to IBATEXAS_CONSISTENCY_TABLE", () => {
    const deps = createIbatexasClaimsKernelDeps();
    expect(deps.consistency?.table).toBe(IBATEXAS_CONSISTENCY_TABLE);
  });

  // BKL-234 — the repo table EXTENDS the published one; it never edits or drops a
  // published constraint (that would silently re-relate a pair the kernel foundation
  // already reviewed).
  it("carries every published constraint VERBATIM, plus the schedule-cluster additions", () => {
    for (const published of DEFAULT_CONSISTENCY_TABLE) {
      expect(IBATEXAS_CONSISTENCY_TABLE).toContainEqual(published);
    }
    expect(IBATEXAS_CONSISTENCY_TABLE).toHaveLength(
      DEFAULT_CONSISTENCY_TABLE.length + SCHEDULE_CLUSTER_COMPATIBLE.length,
    );
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
});

// ── BKL-073: the provable-empty ORDER sentinel (Rule B) + the guest path (#8a) ──

describe("activeResourcesFromLedger — BKL-073 provable-empty sentinel", () => {
  function recordPresent(l: EvidenceLedger, key: string, value: unknown = { present: true }): void {
    l.record({
      key,
      value,
      source: "test",
      fetchedAt: 1_000,
      sourceMode: "live",
      taint: "TRUSTED",
      originProvenance: "FIRST_PARTY",
    });
  }
  /** The investigator's marker shape: read() returns `{count}` on enumeration success. */
  function recordMarker(l: EvidenceLedger, customerId: string, count: number): void {
    recordPresent(l, `active_orders:${customerId}`, { count });
  }
  const orderSentinel = { kind: PROVABLY_EMPTY_KIND, id: "order" };
  const paymentSentinel = { kind: PROVABLY_EMPTY_KIND, id: "payment" };

  it("Rule B′: marker PRESENT {count:0} + no positive order ref → emits the order sentinel", () => {
    const l = new EvidenceLedger("t");
    recordMarker(l, "cust-1", 0); // the count-0 provable-empty marker.
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "cust-1" });
    expect(refs).toContainEqual(orderSentinel);
    // No positive order ref, and (authed) NO payment sentinel (that mirror is BKL-079).
    expect(refs).not.toContainEqual(paymentSentinel);
    expect(refs.filter((r) => r.kind !== PROVABLY_EMPTY_KIND)).toEqual([]);
  });

  it("Rule B′ PARTIAL-LEDGER RACE pin: marker PRESENT {count:2} + NO positive order refs → NO sentinel (enumeration saw orders; per-order reads failed — count is the only witness)", () => {
    const l = new EvidenceLedger("t");
    recordMarker(l, "cust-1", 2); // enumeration SUCCEEDED and saw 2 active orders...
    // ...but no order_fulfillment_stage:<id> read is present (all errored) → no
    // positive ref exists to suppress a naive marker-present∧no-ref rule. The
    // count>0 conjunct is what keeps the companion → honest UNKNOWN, not a drop.
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "cust-1" });
    expect(refs.some((r) => r.kind === PROVABLY_EMPTY_KIND)).toBe(false);
  });

  it("Rule B′ malformed-marker pin: marker PRESENT without a numeric count → NO sentinel (fails toward keeping the companion)", () => {
    const l = new EvidenceLedger("t");
    recordPresent(l, "active_orders:cust-1"); // value {present:true} — no count field.
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "cust-1" });
    expect(refs.some((r) => r.kind === PROVABLY_EMPTY_KIND)).toBe(false);
  });

  it("Rule B: marker in state \"error\" → NO sentinel (could-not-check keeps the companion → honest UNKNOWN)", () => {
    const l = new EvidenceLedger("t");
    l.recordError("active_orders:cust-1", "enumeration backend down");
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "cust-1" });
    expect(refs.some((r) => r.kind === PROVABLY_EMPTY_KIND)).toBe(false);
  });

  it("Rule B: marker ABSENT (never recorded) → NO sentinel", () => {
    const l = new EvidenceLedger("t");
    recordPresent(l, "schedule:store_hours"); // an unrelated present read, no marker.
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "cust-1" });
    expect(refs.some((r) => r.kind === PROVABLY_EMPTY_KIND)).toBe(false);
    expect(refs).toEqual([]);
  });

  it("Rule B′ is conservative: marker PRESENT {count:0} but a positive order ref exists → NO sentinel (model-extracted terminal order)", () => {
    const l = new EvidenceLedger("t");
    recordMarker(l, "cust-1", 0);
    recordPresent(l, "order_fulfillment_stage:o1"); // a model-extracted (present) order.
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "cust-1" });
    expect(refs.some((r) => r.kind === PROVABLY_EMPTY_KIND)).toBe(false);
    expect(refs).toEqual([{ kind: "order", id: "o1" }]);
  });

  it("positive refs are emitted UNCHANGED alongside the order sentinel (payment ref + order sentinel)", () => {
    const l = new EvidenceLedger("t");
    recordMarker(l, "cust-1", 0); // provably-empty ORDER.
    recordPresent(l, "payment_status:o1"); // but a present payment read exists.
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "cust-1" });
    expect(refs).toContainEqual({ kind: "payment", id: "o1" });
    expect(refs).toContainEqual(orderSentinel);
  });

  it("GUEST (#8a): an unauthenticated turn emits BOTH sentinels unconditionally (a guest owns nothing)", () => {
    const l = new EvidenceLedger("t"); // empty — a guest short-circuits before enumeration.
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "guest:abc" });
    expect(refs).toContainEqual(orderSentinel);
    expect(refs).toContainEqual(paymentSentinel);
    expect(refs).toHaveLength(2);
  });

  it("an EMPTY customerId is treated as a guest (both sentinels)", () => {
    const refs = activeResourcesFromLedger({ ledger: new EvidenceLedger("t"), customerId: "" });
    expect(refs).toContainEqual(orderSentinel);
    expect(refs).toContainEqual(paymentSentinel);
  });
});

// ── BKL-079: the provable-empty PAYMENT sentinel (Rule B′) — mirror of BKL-073 ─────

describe("activeResourcesFromLedger — BKL-079 provable-empty PAYMENT sentinel", () => {
  function recordPresent(l: EvidenceLedger, key: string, value: unknown = { present: true }): void {
    l.record({
      key,
      value,
      source: "test",
      fetchedAt: 1_000,
      sourceMode: "live",
      taint: "TRUSTED",
      originProvenance: "FIRST_PARTY",
    });
  }
  /** The investigator's PAYMENT marker shape: read() returns `{count}` on enumeration success. */
  function recordPaymentMarker(l: EvidenceLedger, customerId: string, count: number): void {
    recordPresent(l, `active_payments:${customerId}`, { count });
  }
  const orderSentinel = { kind: PROVABLY_EMPTY_KIND, id: "order" };
  const paymentSentinel = { kind: PROVABLY_EMPTY_KIND, id: "payment" };

  it("Rule B′: payment marker PRESENT {count:0} + no positive payment ref → emits the payment sentinel", () => {
    const l = new EvidenceLedger("t");
    recordPaymentMarker(l, "cust-1", 0); // the count-0 provable-empty payment marker.
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "cust-1" });
    expect(refs).toContainEqual(paymentSentinel);
    // No order marker present → NO order sentinel (each dimension is independent).
    expect(refs).not.toContainEqual(orderSentinel);
    expect(refs.filter((r) => r.kind !== PROVABLY_EMPTY_KIND)).toEqual([]);
  });

  it("Rule B′ PARTIAL-LEDGER RACE pin: payment marker PRESENT {count:2} + NO positive payment refs → NO sentinel (enumeration saw payments; per-payment reads failed — count is the only witness)", () => {
    const l = new EvidenceLedger("t");
    recordPaymentMarker(l, "cust-1", 2); // enumeration SUCCEEDED and saw 2 payments...
    // ...but no payment_status:<id> read is present → no positive ref to suppress a
    // naive marker-present∧no-ref rule. The count>0 conjunct keeps the companion.
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "cust-1" });
    expect(refs.some((r) => r.kind === PROVABLY_EMPTY_KIND)).toBe(false);
  });

  it("Rule B′ malformed-marker pin: payment marker PRESENT without a numeric count → NO sentinel (fails toward keeping the companion)", () => {
    const l = new EvidenceLedger("t");
    recordPresent(l, "active_payments:cust-1"); // value {present:true} — no count field.
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "cust-1" });
    expect(refs.some((r) => r.kind === PROVABLY_EMPTY_KIND)).toBe(false);
  });

  it('Rule B′: payment marker in state "error" → NO sentinel (could-not-check keeps the companion → honest UNKNOWN)', () => {
    const l = new EvidenceLedger("t");
    l.recordError("active_payments:cust-1", "payment count backend down");
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "cust-1" });
    expect(refs.some((r) => r.kind === PROVABLY_EMPTY_KIND)).toBe(false);
  });

  it("Rule B′: payment marker ABSENT (never recorded) → NO sentinel", () => {
    const l = new EvidenceLedger("t");
    recordPresent(l, "schedule:store_hours"); // an unrelated present read, no marker.
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "cust-1" });
    expect(refs.some((r) => r.kind === PROVABLY_EMPTY_KIND)).toBe(false);
    expect(refs).toEqual([]);
  });

  it("Rule B′ is conservative: payment marker PRESENT {count:0} but a positive payment ref exists → NO sentinel", () => {
    const l = new EvidenceLedger("t");
    recordPaymentMarker(l, "cust-1", 0);
    recordPresent(l, "payment_status:o1"); // a present (model-extracted) payment read.
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "cust-1" });
    expect(refs.some((r) => r.kind === PROVABLY_EMPTY_KIND)).toBe(false);
    expect(refs).toEqual([{ kind: "payment", id: "o1" }]);
  });

  it("an ORDER positive ref does NOT suppress the payment sentinel (dimensions are independent)", () => {
    const l = new EvidenceLedger("t");
    recordPaymentMarker(l, "cust-1", 0); // provably-empty PAYMENT.
    recordPresent(l, "order_fulfillment_stage:o1"); // but a present ORDER read exists.
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "cust-1" });
    // The order ref is emitted unchanged, AND the payment sentinel still fires.
    expect(refs).toContainEqual({ kind: "order", id: "o1" });
    expect(refs).toContainEqual(paymentSentinel);
    // No order sentinel (no order marker present).
    expect(refs).not.toContainEqual(orderSentinel);
  });

  it("BOTH markers count-0 → BOTH sentinels (authed order + payment, symmetric)", () => {
    const l = new EvidenceLedger("t");
    recordPresent(l, "active_orders:cust-1", { count: 0 });
    recordPaymentMarker(l, "cust-1", 0);
    const refs = activeResourcesFromLedger({ ledger: l, customerId: "cust-1" });
    expect(refs).toContainEqual(orderSentinel);
    expect(refs).toContainEqual(paymentSentinel);
    expect(refs).toHaveLength(2);
  });
});

// ── BKL-234 — the schedule-cluster co-render declarations ─────────────────────
//
// STRUCTURAL pins over the P2 table. These complement the ops turn-seam suite
// (ops-hours-read.e2e.test.ts): that one proves the operator gets the hours, these
// prove the declaration is exactly as narrow as its justification — every pair inside
// the cluster is declared, and nothing outside it is.

describe("BKL-234 — SCHEDULE_CLUSTER_COMPATIBLE", () => {
  const CLUSTER = ["STORE_OPEN_NOW", "STORE_HOURS", "STORE_HOURS_FOR_DATE"] as const;

  it("declares EVERY unordered pair inside the cluster, all COMPATIBLE", () => {
    // 3 types ⇒ C(3,2) = 3 pairs. A cluster member added without its pairs would
    // silently fall back to §O#1 default-deny on the turn that co-renders it.
    expect(SCHEDULE_CLUSTER_COMPATIBLE).toHaveLength(
      (CLUSTER.length * (CLUSTER.length - 1)) / 2,
    );
    for (const c of SCHEDULE_CLUSTER_COMPATIBLE) {
      expect(c.relation).toBe("COMPATIBLE");
    }
    const pairKeys = new Set(
      SCHEDULE_CLUSTER_COMPATIBLE.map((c) => [c.typeA, c.typeB].sort().join("|")),
    );
    for (let i = 0; i < CLUSTER.length; i++) {
      for (let j = i + 1; j < CLUSTER.length; j++) {
        expect(pairKeys).toContain(
          [CLUSTER[i] as string, CLUSTER[j] as string].sort().join("|"),
        );
      }
    }
  });

  it("declares ONLY schedule types — the narrowing of §O#1 reaches nothing else", () => {
    for (const c of SCHEDULE_CLUSTER_COMPATIBLE) {
      expect(CLUSTER).toContain(c.typeA);
      expect(CLUSTER).toContain(c.typeB);
      // A self-pair would be meaningless: SAME-type consistency is decided by the
      // kernel's SAME_TYPE_VALUE_CONFLICT arm, which this table cannot reach.
      expect(c.typeA).not.toBe(c.typeB);
    }
  });

  it("leaves an OFF-CLUSTER same-subject pair UNDECLARED (still default-deny)", () => {
    // The safety property that makes this change reviewable: a schedule type paired
    // with anything outside the cluster is NOT relieved of §O#1, so an un-reviewed
    // co-render still fails safe.
    const pairKey = (a: string, b: string): string => [a, b].sort().join("|");
    const declared = new Set(
      IBATEXAS_CONSISTENCY_TABLE.map((c) => pairKey(c.typeA, c.typeB)),
    );

    expect(declared).not.toContain(pairKey("STORE_HOURS", "MENU_OVERVIEW"));
    expect(declared).not.toContain(pairKey("STORE_HOURS", "CART_CONTENTS"));
    expect(declared).not.toContain(pairKey("STORE_OPEN_NOW", "PAYMENT_STATUS"));
  });
});

// ── BKL-234 — the P2 verdict the declaration changes, proven both ways ────────
//
// The consistency table is PLANE-INDEPENDENT (both conductors compose these deps),
// so the co-render property belongs at the kernel, not in one plane's turn seam. This
// drives the REAL published `checkConsistency` over two same-subject VALIDATED
// schedule claims and pins the BEFORE (default-deny ESCALATE) against the AFTER
// (co-render), which is the whole of the BKL-234 fix in one assertion pair.

describe("BKL-234 — same-subject schedule claims co-render under the repo table", () => {
  /** Two VALIDATED schedule claims on ONE subject — what the persona now produces. */
  const scheduleClaims = [
    { subject: "loja", type: "STORE_HOURS", verdict: "VALIDATED" as const, value: { hoursText: "11h–15h / 18h–23h" } },
    { subject: "loja", type: "STORE_OPEN_NOW", verdict: "VALIDATED" as const, value: { mealPeriod: "dinner" } },
  ];

  it("BEFORE (published table): §O#1 default-deny suppresses BOTH → ESCALATE", () => {
    const result = checkConsistency(scheduleClaims, { table: DEFAULT_CONSISTENCY_TABLE });

    // The exact live symptom: two grounded facts annihilate each other.
    expect(result.terminal).toBe("ESCALATE");
    expect(result.renderable).toHaveLength(0);
    expect(result.suppressions.length).toBeGreaterThan(0);
    expect(result.suppressions[0]?.reason).toBe("UNMODELLED_SAME_SUBJECT");
  });

  it("AFTER (repo table): both render, no suppression", () => {
    const result = checkConsistency(scheduleClaims, { table: IBATEXAS_CONSISTENCY_TABLE });

    expect(result.terminal).not.toBe("ESCALATE");
    expect(result.renderable).toHaveLength(2);
    expect(result.suppressions).toHaveLength(0);
  });

  // The declaration must not become a blanket "schedule claims never conflict": two
  // VALIDATED claims of the SAME type with DIFFERENT values are still a P2 violation,
  // decided by the kernel's SAME_TYPE_VALUE_CONFLICT arm that no table can relax.
  it("still suppresses two CONTRADICTORY same-type hours claims", () => {
    const result = checkConsistency(
      [
        { subject: "loja", type: "STORE_HOURS", verdict: "VALIDATED", value: { hoursText: "11h–15h" } },
        { subject: "loja", type: "STORE_HOURS", verdict: "VALIDATED", value: { hoursText: "18h–23h" } },
      ],
      { table: IBATEXAS_CONSISTENCY_TABLE },
    );

    expect(result.terminal).toBe("ESCALATE");
    expect(result.suppressions[0]?.reason).toBe("SAME_TYPE_VALUE_CONFLICT");
  });

  // …and a schedule type paired with an OFF-CLUSTER type still default-denies, so the
  // narrowing is genuinely scoped to the reviewed cluster.
  it("still default-denies a schedule type paired with an OFF-CLUSTER type", () => {
    const result = checkConsistency(
      [
        { subject: "loja", type: "STORE_HOURS", verdict: "VALIDATED", value: { hoursText: "11h–15h" } },
        { subject: "loja", type: "MENU_OVERVIEW", verdict: "VALIDATED", value: { overviewText: "..." } },
      ],
      { table: IBATEXAS_CONSISTENCY_TABLE },
    );

    expect(result.terminal).toBe("ESCALATE");
    expect(result.suppressions[0]?.reason).toBe("UNMODELLED_SAME_SUBJECT");
  });
});
