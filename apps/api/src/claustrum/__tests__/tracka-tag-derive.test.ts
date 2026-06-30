/**
 * Track A on Nemotron-4B — tag-then-derive + key-alignment + IDOR-safe owns
 * (TRACK_A_NEMOTRON_ONLY_PLAN.md). These tests pin the LOAD-BEARING contract of
 * the publish-free activation, against the LINKED `@adjudicate/core` kernel (NOT a
 * stub — they feed the real `runClaimsKernel`):
 *
 *   1. TAG → DERIVED-VALUE → VALIDATED (STORE_OPEN_NOW, open, no override): the
 *      4B emits a TYPE-ONLY proposal `{type:"STORE_OPEN_NOW", subject:"loja"}`
 *      (no `value`); ibatexas DERIVES `value.mealPeriod` from the SAME first-party
 *      schedule read the investigator records, so the kernel's C6 value-binding
 *      passes BY CONSTRUCTION and the claim VALIDATEs + renders the ledger-sourced
 *      meal-period proposition.
 *   2. FALSIFIER STILL DEMOTES (HARD GUARD i): the SAME derived claim, but with a
 *      present `schedule:schedule_override` in the ledger → UNKNOWN (the CE#3
 *      runtime arm fires). Proves derivation did NOT skip the falsifier conjunct.
 *   3. C6 STILL REFUSES A SEEDED MISMATCH (control): when the value is NOT derived
 *      (a model-authored value that disagrees with the ledger) → REFUSED. Proves
 *      we replaced the value AUTHOR, never the C6 CHECK.
 *   4. KEY ALIGNMENT + IDOR-SAFE owns (HARD GUARD ii / STEP 3): ORDER/PAYMENT keys
 *      are parameterized by subject to match the investigator's `:{id}` keys;
 *      STORE_OPEN_NOW is NOT. A NON-OWNER PAYMENT_STATUS degrades SAFE to
 *      UNKNOWN/REFUSED (read-error OR owns=false) — never another customer's data.
 *
 * Pure unit tests — a hand-built `ModelProvider` mock + real `EvidenceLedger`;
 * no DB / no live model.
 */

import { describe, expect, it } from "vitest";
import {
  EvidenceLedger,
  runClaimsKernel,
  type CandidateClaim,
  type TurnTerminal,
} from "@adjudicate/core";
import type { CognitiveState, Completion, ModelProvider } from "@claustrum/core";
import {
  createIbatexasPlanner,
  PROPOSE_CLAIM_TOOL,
} from "../ibatexas-planner.js";
import { selectCandidateClaim } from "../claim-registry.js";
import {
  createIbatexasClaimsKernelDeps,
  createPerTurnClaimsKernelDeps,
} from "../ibatexas-claims-kernel-deps.js";
import { render } from "../renderer-from-claims.js";

// ── Test doubles ──────────────────────────────────────────────────────────────

function mockModel(toolCalls: Completion["toolCalls"]): ModelProvider {
  return {
    async complete(): Promise<Completion> {
      return {
        model: "mock",
        stopReason: "tool_use",
        text: "",
        toolCalls,
        inputTokens: 1,
        outputTokens: 1,
      };
    },
    stream() {
      throw new Error("not used");
    },
    async embed() {
      return [];
    },
  };
}

function state(text: string): CognitiveState {
  return {
    perception: { text, channel: "web", receivedAt: "2026-06-29T00:00:00.000Z" },
    memory: {} as CognitiveState["memory"],
    retrieval: {} as CognitiveState["retrieval"],
    tenantId: "t1",
    locale: "pt-BR",
    conversationId: "conv-1",
    turnId: "turn-1",
  };
}

function claimCall(input: unknown): NonNullable<Completion["toolCalls"]>[number] {
  return { id: "tc-1", name: PROPOSE_CLAIM_TOOL, input };
}

const RENDER: TurnTerminal = "RENDER";
const NOW = 10_000;

/** A first-party schedule signal — the bound `mealPeriod` is the ledger scalar. */
const OPEN_SIGNAL = { isClosed: false, mealPeriod: "dinner" } as const;

/** Record the `schedule:store_open_now` entry the investigator would mint. */
function recordSchedule(ledger: EvidenceLedger, signal: unknown): void {
  ledger.record({
    key: "schedule:store_open_now",
    value: signal,
    source: "schedule.getScheduleSignal",
    fetchedAt: NOW,
    sourceMode: "live",
    taint: "TRUSTED",
    originProvenance: "FIRST_PARTY",
  });
}

// ── (1) TAG → DERIVED VALUE → VALIDATED (STORE_OPEN_NOW, open, no override) ─────

describe("Track A 4B — tag→derive→VALIDATED for STORE_OPEN_NOW", () => {
  it("derives value from the first-party read though the model emitted NONE, then VALIDATEs + renders", async () => {
    // The 4B emits ONLY the type tag + subject — NO value (the tool schema has no
    // `value` field). The planner re-reads the SAME schedule the investigator does.
    const planner = createIbatexasPlanner({
      model: mockModel([claimCall({ type: "STORE_OPEN_NOW", subject: "loja" })]),
      modelId: "mock",
      capabilityPlanners: [],
      resolveScheduleSignal: () => OPEN_SIGNAL,
    });
    const plan = await planner.proposeClaims(state("Vocês estão abertos agora?"));

    // The value was DERIVED (model authored none): mealPeriod from the read.
    expect(plan.candidates).toHaveLength(1);
    const candidate = plan.candidates[0] as CandidateClaim;
    expect(candidate.type).toBe("STORE_OPEN_NOW");
    expect(candidate.value).toEqual({ mealPeriod: "dinner" });

    // Feed the derived candidate through the REAL kernel against a ledger whose
    // bound entry is byte-equal to the derived value → C6 PASSes by construction.
    const ledger = new EvidenceLedger("turn-1");
    recordSchedule(ledger, OPEN_SIGNAL); // no schedule_override present → falsifier inert
    const result = runClaimsKernel(
      ledger,
      plan.candidates,
      createIbatexasClaimsKernelDeps({ now: () => NOW }),
    );

    expect(result.perClaim[0]?.verdict).toBe("VALIDATED");
    expect(result.terminal).toBe("RENDER");
    expect(result.renderable).toHaveLength(1);
    // The derived value equals the ledger entry's bound field (not a model value).
    expect(result.renderable[0]?.value).toEqual({ mealPeriod: "dinner" });

    const out = render(result.renderable, result.terminal);
    expect(out.text).toContain("dinner");
  });
});

// ── (2) FALSIFIER STILL DEMOTES — derivation did NOT bypass the conjunct ───────

describe("Track A 4B — a present override STILL demotes the derived claim (HARD GUARD i)", () => {
  it("UNKNOWN when schedule_override is present, even with a VALID derived value", async () => {
    const planner = createIbatexasPlanner({
      model: mockModel([claimCall({ type: "STORE_OPEN_NOW", subject: "loja" })]),
      modelId: "mock",
      capabilityPlanners: [],
      resolveScheduleSignal: () => OPEN_SIGNAL,
    });
    const plan = await planner.proposeClaims(state("estão abertos?"));
    // Sanity: the derived value is the same VALID value as test (1).
    expect((plan.candidates[0] as CandidateClaim).value).toEqual({ mealPeriod: "dinner" });

    const ledger = new EvidenceLedger("turn-2");
    recordSchedule(ledger, OPEN_SIGNAL);
    // A PRESENT per-date ScheduleOverride contradicts the computed signal (CE#3).
    ledger.record({
      key: "schedule:schedule_override",
      value: { date: "2026-06-29", isOpen: false },
      source: "schedule.readScheduleOverride",
      fetchedAt: NOW,
      sourceMode: "live",
      taint: "TRUSTED",
      originProvenance: "FIRST_PARTY",
    });

    const result = runClaimsKernel(
      ledger,
      plan.candidates,
      createIbatexasClaimsKernelDeps({ now: () => NOW }),
    );

    // The falsifier RUNTIME arm fired → UNKNOWN (NOT bypassed by derivation).
    expect(result.perClaim[0]?.verdict).toBe("UNKNOWN");
    expect(result.renderable).toHaveLength(0);
    const out = render(result.renderable, result.terminal);
    // Proposition-free safe terminal — no derived meal-period asserted.
    expect(out.text).not.toContain("dinner");
  });
});

// ── (3) CONTROL — C6 still REFUSES a model-authored value that disagrees ───────

describe("Track A 4B — C6 still REFUSES a seeded mismatch (we replaced the AUTHOR, not the CHECK)", () => {
  it("REFUSED when a NON-derived (model) value contradicts the ledger value", () => {
    // Bypass derivation: build the candidate DIRECTLY with a wrong model value.
    const mismatched = selectCandidateClaim({
      type: "STORE_OPEN_NOW",
      subject: "loja",
      actor: "system",
      value: { mealPeriod: "almoco" }, // the model said "almoco"…
    }) as CandidateClaim;

    const ledger = new EvidenceLedger("turn-3");
    recordSchedule(ledger, OPEN_SIGNAL); // …but the ledger says "dinner"

    const result = runClaimsKernel(
      ledger,
      [mismatched],
      createIbatexasClaimsKernelDeps({ now: () => NOW }),
    );

    // C6 dominates: an over-claim contradicting its licensing evidence → REFUSED.
    expect(result.perClaim[0]?.verdict).toBe("REFUSED");
    expect(result.renderable).toHaveLength(0);
  });
});

// ── (4) KEY ALIGNMENT (STEP 3) + IDOR-SAFE owns (HARD GUARD ii) ────────────────

describe("Track A 4B — STEP 3 key alignment", () => {
  it("parameterizes ORDER/PAYMENT keys by subject; leaves STORE_OPEN_NOW verbatim", () => {
    const pay = selectCandidateClaim({
      type: "PAYMENT_STATUS",
      subject: "order-42",
      actor: "cust-1",
      value: undefined,
    }) as CandidateClaim;
    expect(pay.soundness.requiredEvidence[0]?.key).toBe("payment_status:order-42");
    expect(pay.soundness.valueBinding?.key).toBe("payment_status:order-42");
    // valueBinding.key stays a member of requiredEvidence (C6 structural guard).
    expect(pay.soundness.requiredEvidence.map((e) => e.key)).toContain(
      pay.soundness.valueBinding?.key,
    );
    // Falsifier keys are parameterized too.
    expect(pay.soundness.falsifiers?.map((f) => f.key)).toEqual([
      "payment_refund:order-42",
      "payment_chargeback:order-42",
    ]);

    const ord = selectCandidateClaim({
      type: "ORDER_FULFILLMENT_STAGE",
      subject: "order-42",
      actor: "cust-1",
      value: undefined,
    }) as CandidateClaim;
    expect(ord.soundness.requiredEvidence[0]?.key).toBe("order_fulfillment_stage:order-42");
    expect(ord.soundness.valueBinding?.key).toBe("order_fulfillment_stage:order-42");

    // STORE_OPEN_NOW (public single-key) is NOT parameterized — matches verbatim.
    const son = selectCandidateClaim({
      type: "STORE_OPEN_NOW",
      subject: "loja",
      actor: "system",
      value: undefined,
    }) as CandidateClaim;
    expect(son.soundness.requiredEvidence[0]?.key).toBe("schedule:store_open_now");
  });
});

describe("Track A 4B — a non-owner PAYMENT_STATUS degrades SAFE (HARD GUARD ii / W5a IDOR)", () => {
  // MALLORY (≠ owner) probes the OWNER's order. The candidate's key is aligned to
  // the investigator's per-resource key; owns is built ONLY from MALLORY's OWN
  // owner-confirmed resources, which never include the owner's order.
  function mallorysPayCandidate(): CandidateClaim {
    return selectCandidateClaim({
      type: "PAYMENT_STATUS",
      subject: "order-OWNER",
      actor: "mallory",
      // The C1 ownership binding is keyed by the PARAMETERIZED evidence key.
      resources: { "payment_status:order-OWNER": "order-OWNER" },
      value: { status: "paid" },
    }) as CandidateClaim;
  }

  function mallorysDeps() {
    return createPerTurnClaimsKernelDeps({
      now: NOW,
      // owns is built from MALLORY's owner-confirmed reads — NOT the owner's order.
      ownership: { principal: "mallory", ownedResources: new Set(["order-mallory"]) },
      outcomes: [],
    });
  }

  it("read-ERROR (cross-owner read refused) → UNKNOWN, never the owner's data", () => {
    const ledger = new EvidenceLedger("turn-4a");
    // The investigator's owner-scoped read returned null → recorded fail-closed.
    ledger.recordError(
      "payment_status:order-OWNER",
      "payment_status unavailable for this customer (not owned or absent): order-OWNER",
    );

    const result = runClaimsKernel(ledger, [mallorysPayCandidate()], mallorysDeps());
    expect(result.perClaim[0]?.verdict).toBe("UNKNOWN");
    expect(result.renderable).toHaveLength(0);
    const out = render(result.renderable, result.terminal);
    expect(out.text).not.toContain("paid");
  });

  it("present value but owns=false (the owns predicate itself) → not VALIDATED, no leak", () => {
    // Even if a per-resource value were PRESENT in the ledger, the IDOR-safe owns
    // predicate (built only from MALLORY's confirmed resources) refuses it.
    const ledger = new EvidenceLedger("turn-4b");
    ledger.record({
      key: "payment_status:order-OWNER",
      value: { status: "paid" },
      source: "payment.getActiveByOrderId",
      fetchedAt: NOW,
      sourceMode: "live",
      taint: "TRUSTED",
      originProvenance: "FIRST_PARTY",
    });

    const result = runClaimsKernel(ledger, [mallorysPayCandidate()], mallorysDeps());
    // owns(mallory, "order-OWNER") === false → ownership DENIED → REFUSED (safe).
    expect(result.perClaim[0]?.verdict).not.toBe("VALIDATED");
    expect(result.renderable).toHaveLength(0);
    const out = render(result.renderable, result.terminal);
    expect(out.text).not.toContain("paid");
  });
});
