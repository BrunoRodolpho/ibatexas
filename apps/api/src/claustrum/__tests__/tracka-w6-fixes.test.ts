/**
 * Track-A / W6 fixes (RCA 2026-06-29) — the ibatexas app half.
 *
 * Pins the three ibatexas-side RCA-confirmed fixes that, together with the
 * claustrum CLAIMS-VALIDATE per-turn reconciliation, let a correctly-classified
 * owner-scoped first-party claim VALIDATE for the legit owner instead of falling
 * back to the lie-capable prose responder:
 *
 *   fix 3  — CASING ROBUSTNESS: a miscased-but-correct registry tag from the 4B
 *            (`ORDER_fulfillment_stage`) is canonicalized, NOT dropped. A truly
 *            unknown tag still degrades SAFE (undefined → dropped by the wall).
 *   fix 4a — ORDER_FULFILLMENT_STAGE valueBinding.path reconciled to the read's
 *            ACTUAL field (`fulfillmentStatus`), so C6 compares a real scalar.
 *   fix 2  — per-turn OWNS: `buildPerTurnOwnsFromLedger` derives the owned set
 *            ONLY from owner-scoped reads that returned PRESENT (IDOR closed), and
 *            `selectCandidateClaim` derives the C1 resource binding from `subject`.
 *
 * Plus the end-to-end chain (miscased tag + present owner-scoped read + ledger-
 * exact value + per-turn owns) → VALIDATED. Mocks only: the REAL @adjudicate/core
 * claims runtime + the REAL ibatexas registry/deps. No live model / DB.
 */

import { describe, expect, it } from "vitest";
import {
  EvidenceLedger,
  runClaimsKernel,
  type CandidateClaim,
} from "@adjudicate/core";
import {
  canonicalizeRegistryType,
  selectCandidateClaim,
} from "../claim-registry.js";
import {
  buildPerTurnOwnsFromLedger,
  createPerTurnClaimsKernelDeps,
} from "../ibatexas-claims-kernel-deps.js";

const NOW = 10_000;

// ── fix 3 — casing robustness ─────────────────────────────────────────────────

describe("fix 3 — registry-type casing robustness", () => {
  it("canonicalizes a miscased-but-correct tag to its UPPER_SNAKE registry form", () => {
    expect(canonicalizeRegistryType("ORDER_fulfillment_stage")).toBe(
      "ORDER_FULFILLMENT_STAGE",
    );
    expect(canonicalizeRegistryType("PAYMENT_status")).toBe("PAYMENT_STATUS");
    expect(canonicalizeRegistryType("store_open_now")).toBe("STORE_OPEN_NOW");
    // Already-canonical passes through.
    expect(canonicalizeRegistryType("ORDER_FULFILLMENT_STAGE")).toBe(
      "ORDER_FULFILLMENT_STAGE",
    );
  });

  it("a truly-unknown tag canonicalizes to undefined (degrade SAFE, never fabricate)", () => {
    expect(canonicalizeRegistryType("TOTALLY_MADE_UP")).toBeUndefined();
    expect(canonicalizeRegistryType("")).toBeUndefined();
    expect(canonicalizeRegistryType(42)).toBeUndefined();
    expect(canonicalizeRegistryType(undefined)).toBeUndefined();
  });

  it("selectCandidateClaim RESCUES a miscased tag (emits the CANONICAL type), not the raw tag", () => {
    const candidate = selectCandidateClaim({
      type: "ORDER_fulfillment_stage",
      subject: "order-1",
      actor: "cust-1",
      value: undefined,
    });
    expect(candidate).toBeDefined();
    expect(candidate!.type).toBe("ORDER_FULFILLMENT_STAGE");
  });

  it("selectCandidateClaim DROPS a truly out-of-enum tag (undefined → the prose path never sees it)", () => {
    expect(
      selectCandidateClaim({
        type: "ORDER_made_up_thing",
        subject: "order-1",
        actor: "cust-1",
        value: undefined,
      }),
    ).toBeUndefined();
  });
});

// ── fix 4a — valueBinding.path reconciliation ─────────────────────────────────

describe("fix 4a — ORDER_FULFILLMENT_STAGE valueBinding path matches the read field", () => {
  it("binds the read's ACTUAL `fulfillmentStatus` field (not the stale `stage`)", () => {
    const candidate = selectCandidateClaim({
      type: "ORDER_FULFILLMENT_STAGE",
      subject: "order-1",
      actor: "cust-1",
      value: undefined,
    }) as CandidateClaim;
    expect(candidate.soundness.valueBinding?.path).toEqual(["fulfillmentStatus"]);
    // valueBinding.key stays a requiredEvidence member (C6 structural guard).
    expect(candidate.soundness.requiredEvidence.map((e) => e.key)).toContain(
      candidate.soundness.valueBinding?.key,
    );
  });
});

// ── fix 2 — per-turn owns from the ledger (IDOR-safe) ─────────────────────────

describe("fix 2 — buildPerTurnOwnsFromLedger derives owns from PRESENT owner-scoped reads", () => {
  function base() {
    return createPerTurnClaimsKernelDeps({
      now: NOW,
      ownership: { principal: "", ownedResources: new Set<string>() },
      outcomes: [],
    });
  }

  it("owns=true ONLY for a resource whose owner-scoped read returned PRESENT", () => {
    const ledger = new EvidenceLedger("turn-1");
    ledger.record({
      key: "order_fulfillment_stage:order-1",
      value: { orderId: "order-1", fulfillmentStatus: "preparing" },
      source: "order.getById",
      fetchedAt: NOW,
      sourceMode: "live",
      taint: "TRUSTED",
      originProvenance: "FIRST_PARTY",
    });
    const deps = buildPerTurnOwnsFromLedger({
      ledger,
      customerId: "cust-1",
      base: base(),
    });
    expect(deps.soundness.owns("cust-1", "order-1")).toBe(true);
    // A resource that was NOT read this turn is not owned (no "any owner" leak).
    expect(deps.soundness.owns("cust-1", "order-OTHER")).toBe(false);
  });

  it("IDOR — an ERRORED (cross-owner / unavailable) owner-scoped read NEVER attributes ownership", () => {
    const ledger = new EvidenceLedger("turn-2");
    // The investigator's owner-scoped read returned null → recorded fail-closed.
    ledger.recordError(
      "payment_status:order-OWNER",
      "payment_status unavailable for this customer (not owned or absent): order-OWNER",
    );
    const deps = buildPerTurnOwnsFromLedger({
      ledger,
      customerId: "mallory",
      base: base(),
    });
    expect(deps.soundness.owns("mallory", "order-OWNER")).toBe(false);
  });

  it("public (schedule) keys are NOT treated as owner resources", () => {
    const ledger = new EvidenceLedger("turn-3");
    ledger.record({
      key: "schedule:store_open_now",
      value: { isClosed: false, mealPeriod: "dinner" },
      source: "schedule",
      fetchedAt: NOW,
      sourceMode: "live",
      taint: "TRUSTED",
      originProvenance: "FIRST_PARTY",
    });
    const deps = buildPerTurnOwnsFromLedger({
      ledger,
      customerId: "cust-1",
      base: base(),
    });
    expect(deps.soundness.owns("cust-1", "store_open_now")).toBe(false);
  });

  it("selectCandidateClaim derives the C1 resource binding from `subject` (owner-scoped per-resource type)", () => {
    const candidate = selectCandidateClaim({
      type: "ORDER_FULFILLMENT_STAGE",
      subject: "order-1",
      actor: "cust-1",
      value: undefined,
    }) as CandidateClaim;
    expect(candidate.soundness.resources).toEqual({
      "order_fulfillment_stage:order-1": "order-1",
    });
  });
});

// ── End-to-end: the full fix chain → VALIDATED for the legit owner ─────────────

describe("Track-A W6 chain — miscased ORDER tag + present owner-scoped read → VALIDATED", () => {
  it("VALIDATEs for the legit owner (canonicalize + resource binding + per-turn owns + ledger-exact value)", () => {
    const ledger = new EvidenceLedger("turn-e2e");
    const readValue = { orderId: "order-1", fulfillmentStatus: "out_for_delivery" };
    ledger.record({
      key: "order_fulfillment_stage:order-1",
      value: readValue,
      source: "order.getById",
      fetchedAt: NOW,
      sourceMode: "live",
      taint: "TRUSTED",
      originProvenance: "FIRST_PARTY",
    });

    // fix 3: a MISCASED tag is rescued to the canonical type + the C1 binding is
    // derived from `subject`.
    const candidate = selectCandidateClaim({
      type: "ORDER_fulfillment_stage",
      subject: "order-1",
      actor: "cust-1",
      value: undefined,
    }) as CandidateClaim;
    // claustrum claims-validate.ts (4b) binds the still-undefined value to the
    // PRESENT ledger entry; replicate that ledger-exact derivation here.
    const withValue: CandidateClaim = { ...candidate, value: readValue };

    // fix 2: per-turn owns from the present owner-scoped read.
    const deps = buildPerTurnOwnsFromLedger({
      ledger,
      customerId: "cust-1",
      base: createPerTurnClaimsKernelDeps({
        now: NOW,
        ownership: { principal: "", ownedResources: new Set<string>() },
        outcomes: [],
      }),
    });

    const result = runClaimsKernel(ledger, [withValue], deps);
    expect(result.perClaim[0]?.verdict).toBe("VALIDATED");
    expect(result.terminal).toBe("RENDER");
    expect(result.renderable.map((c) => c.type)).toEqual([
      "ORDER_FULFILLMENT_STAGE",
    ]);
  });

  it("IDOR — the SAME chain for a NON-owner (cross-owner read errored) → not VALIDATED, no leak", () => {
    const ledger = new EvidenceLedger("turn-e2e-idor");
    // Mallory probes the owner's order; the owner-scoped read refused → error.
    ledger.recordError(
      "order_fulfillment_stage:order-1",
      "order_fulfillment_stage unavailable for this customer (not owned or absent): order-1",
    );
    const candidate = selectCandidateClaim({
      type: "ORDER_fulfillment_stage",
      subject: "order-1",
      actor: "mallory",
      value: undefined,
    }) as CandidateClaim;
    const deps = buildPerTurnOwnsFromLedger({
      ledger,
      customerId: "mallory",
      base: createPerTurnClaimsKernelDeps({
        now: NOW,
        ownership: { principal: "", ownedResources: new Set<string>() },
        outcomes: [],
      }),
    });
    const result = runClaimsKernel(ledger, [candidate], deps);
    expect(result.perClaim[0]?.verdict).not.toBe("VALIDATED");
    expect(result.renderable).toHaveLength(0);
  });
});
