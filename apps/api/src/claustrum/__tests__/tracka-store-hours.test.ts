/**
 * BKL-121 — the STORE_HOURS validated render chain, end-to-end through the REAL
 * @adjudicate/core kernel (NOT a stub — these feed the real `runClaimsKernel`). The
 * full chain the tracker row builds: evidence read → value-binding → falsifiers →
 * derive → template. These pin the LOAD-BEARING contract:
 *
 *   1. TAG → DERIVED-VALUE → VALIDATED → RENDER: the 4B emits a TYPE-ONLY proposal
 *      `{type:"STORE_HOURS", subject:"loja"}` (no `value`); ibatexas DERIVES
 *      `value.hoursText` from the SAME first-party today's-hours read the
 *      investigator records (`resolveStoreHours`), so the kernel's C6 value-binding
 *      passes BY CONSTRUCTION and the claim VALIDATEs + renders today's REAL hours.
 *      This is the "reaches VALIDATED through the real kernel" proof (the kernel
 *      eligibility cap requires falsifierComplete ∧ non-empty falsifiers — this
 *      proves the STORE_HOURS spec clears it, not merely that a template exists).
 *   2. FALSIFIER STILL DEMOTES (D1): the SAME derived claim, but with a present
 *      `schedule:schedule_override` OR `schedule:holiday` in the ledger → UNKNOWN.
 *      Proves derivation did NOT skip the falsifier conjunct, and that TODAY'S-hours
 *      honest falsifiers (override/holiday) fire.
 *   3. C6 STILL REFUSES A SEEDED MISMATCH (control): a model-authored value that
 *      disagrees with the ledger → REFUSED. Proves we replaced the value AUTHOR,
 *      never the C6 CHECK.
 *   4. UNKNOWN SAFE-DEGRADE (renderer): an UNKNOWN STORE_HOURS renders the
 *      proposition-free safe self-report — it NEVER asserts an hours fact.
 *
 * Pure unit tests — a hand-built `ModelProvider` mock + real `EvidenceLedger`; no
 * DB / no live model.
 */

import { describe, expect, it } from "vitest";
import {
  EvidenceLedger,
  runClaimsKernel,
  type CandidateClaim,
} from "@adjudicate/core";
import type { ClaimPlannerInput, CognitiveState, Completion, ModelProvider, Plan } from "@claustrum/core";
import { normalizeClaimPlannerResult } from "@claustrum/core";
import {
  createIbatexasPlanner,
  PROPOSE_CLAIM_TOOL,
} from "../ibatexas-planner.js";
import { selectCandidateClaim } from "../claim-registry.js";
import { createIbatexasClaimPlanner } from "../ibatexas-claim-planner.js";
import { createIbatexasClaimsKernelDeps } from "../ibatexas-claims-kernel-deps.js";
import { render, renderRenderables } from "../renderer-from-claims.js";

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

/**
 * BKL-126 — propose through the REAL claim-planner ADAPTER with THIS turn's
 * ledger: the planner no longer re-reads the schedule (the divergence-window
 * deletion); the candidate's value binds ONLY from the ledger entry the
 * investigator recorded (`bindValueFromLedger`, only-undefined), exactly the
 * production path. Returns the bound candidates.
 */
async function proposeBoundCandidates(
  model: ModelProvider,
  text: string,
  ledger: EvidenceLedger,
): Promise<readonly CandidateClaim[]> {
  const planner = createIbatexasPlanner({
    model,
    modelId: "mock",
    capabilityPlanners: [],
  });
  const adapter = createIbatexasClaimPlanner(planner);
  const input: ClaimPlannerInput = {
    cognition: state(text),
    plan: { envelopes: [] } as Plan,
    ledger,
  };
  const { candidates } = normalizeClaimPlannerResult(await adapter.propose(input));
  return candidates;
}

const NOW = 10_000;

/** Today's operating-hours read the investigator would record + the planner derives. */
const HOURS_READ = { hoursText: "11h–15h / 18h–23h" } as const;

/** Record the `schedule:store_hours` entry the investigator would mint. */
function recordStoreHours(ledger: EvidenceLedger, value: unknown): void {
  ledger.record({
    key: "schedule:store_hours",
    value,
    source: "schedule.getTodayHoursText",
    fetchedAt: NOW,
    sourceMode: "live",
    taint: "TRUSTED",
    originProvenance: "FIRST_PARTY",
  });
}

/** Record a PRESENT falsifier entry (override or holiday) — a live contradiction. */
function recordFalsifier(ledger: EvidenceLedger, key: string, value: unknown): void {
  ledger.record({
    key,
    value,
    source: "schedule",
    fetchedAt: NOW,
    sourceMode: "live",
    taint: "TRUSTED",
    originProvenance: "FIRST_PARTY",
  });
}

// ── (1) TAG → DERIVED VALUE → VALIDATED → RENDER (no override/holiday) ──────────

describe("BKL-121 — tag→derive→VALIDATED for STORE_HOURS (through the real kernel)", () => {
  it("derives hoursText from the first-party read though the model emitted NONE, then VALIDATEs + renders today's hours", async () => {
    // The 4B emits ONLY the type tag + subject — NO value. BKL-126: the planner
    // no longer re-reads the schedule; the value binds from the INVESTIGATOR's
    // recorded ledger entry through the real adapter (bindValueFromLedger).
    const ledger = new EvidenceLedger("turn-1");
    recordStoreHours(ledger, HOURS_READ);
    const candidates = await proposeBoundCandidates(
      mockModel([claimCall({ type: "STORE_HOURS", subject: "loja" })]),
      "qual o horário de funcionamento?",
      ledger,
    );

    // The value was BOUND from the recorded entry (model authored none).
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0] as CandidateClaim;
    expect(candidate.type).toBe("STORE_HOURS");
    expect(candidate.value).toEqual({ hoursText: "11h–15h / 18h–23h" });
    // The eligibility cap is real: the spec declares falsifierComplete + falsifiers.
    expect(candidate.soundness.falsifierComplete).toBe(true);
    expect(candidate.soundness.falsifiers?.map((f) => f.key)).toEqual([
      "schedule:schedule_override",
      "schedule:holiday",
    ]);

    // Feed the bound candidate through the REAL kernel against the SAME ledger —
    // C6 PASSes BY CONSTRUCTION (the value IS the entry), and with NO
    // override/holiday present both falsifiers are inert → VALIDATED.
    const result = runClaimsKernel(
      ledger,
      candidates,
      createIbatexasClaimsKernelDeps({ now: () => NOW }),
    );

    expect(result.perClaim[0]?.verdict).toBe("VALIDATED");
    expect(result.terminal).toBe("RENDER");
    expect(result.renderable).toHaveLength(1);
    expect(result.renderable[0]?.value).toEqual({ hoursText: "11h–15h / 18h–23h" });

    const out = render(result.renderableCanonical, result.terminal);
    // The rendered pt-BR sentence carries the LEDGER-sourced hours (Inv 6), 1:1.
    expect(out.text).toBe("Hoje nosso horário de funcionamento é: 11h–15h / 18h–23h.");
  });

  it("VALIDATEs a 'fechado' today's-hours value the same way (evidence-bound, not an absence)", async () => {
    const ledger = new EvidenceLedger("turn-fechado");
    recordStoreHours(ledger, { hoursText: "fechado" });
    const candidates = await proposeBoundCandidates(
      mockModel([claimCall({ type: "STORE_HOURS", subject: "loja" })]),
      "que horas abre hoje?",
      ledger,
    );
    expect((candidates[0] as CandidateClaim).value).toEqual({ hoursText: "fechado" });

    const result = runClaimsKernel(
      ledger,
      candidates,
      createIbatexasClaimsKernelDeps({ now: () => NOW }),
    );
    expect(result.perClaim[0]?.verdict).toBe("VALIDATED");
    const out = render(result.renderableCanonical, result.terminal);
    expect(out.text).toBe("Hoje nosso horário de funcionamento é: fechado.");
  });

  // TTL UNITS regression (adversarial-review pin): the kernel enforces the
  // cacheable ttl in epoch-MILLISECONDS (soundness.js: age = now - fetchedAt,
  // no conversion) even though the published doc says seconds. With the old
  // `ttl: 3600` this test FAILS — 15s of model latency between the investigator
  // read and validation exceeded a 3.6s window and demoted every real turn to
  // UNKNOWN. The registry now declares 3_600_000 (1 hour in ms).
  it("VALIDATEs with realistic model latency between the read and validation (ttl is enforced in ms)", async () => {
    const ledger = new EvidenceLedger("turn-latency");
    recordStoreHours(ledger, HOURS_READ); // fetchedAt = NOW
    const candidates = await proposeBoundCandidates(
      mockModel([claimCall({ type: "STORE_HOURS", subject: "loja" })]),
      "qual o horário de hoje?",
      ledger,
    );
    const result = runClaimsKernel(
      ledger,
      candidates,
      // Validation runs 15 SECONDS after the read — normal 4B claims latency.
      createIbatexasClaimsKernelDeps({ now: () => NOW + 15_000 }),
    );
    expect(result.perClaim[0]?.verdict).toBe("VALIDATED");
  });

  it("demotes to UNKNOWN when the evidence is GENUINELY stale (older than the 1h bound)", async () => {
    const ledger = new EvidenceLedger("turn-stale");
    recordStoreHours(ledger, HOURS_READ); // fetchedAt = NOW
    const candidates = await proposeBoundCandidates(
      mockModel([claimCall({ type: "STORE_HOURS", subject: "loja" })]),
      "qual o horário de hoje?",
      ledger,
    );
    const result = runClaimsKernel(
      ledger,
      candidates,
      createIbatexasClaimsKernelDeps({ now: () => NOW + 2 * 3_600_000 }), // 2h later
    );
    expect(result.perClaim[0]?.verdict).toBe("UNKNOWN"); // stale, never a render
    expect(result.terminal).not.toBe("RENDER");
  });
});

// ── (2) FALSIFIER STILL DEMOTES — derivation did NOT bypass the conjunct ────────

describe("BKL-121 — a present override OR holiday STILL demotes the derived claim (D1)", () => {
  // BKL-126 — candidates now bind from EACH test's ledger (the adapter path).
  async function derivedCandidates(
    ledger: EvidenceLedger,
  ): Promise<readonly CandidateClaim[]> {
    const candidates = await proposeBoundCandidates(
      mockModel([claimCall({ type: "STORE_HOURS", subject: "loja" })]),
      "qual o horário?",
      ledger,
    );
    expect((candidates[0] as CandidateClaim).value).toEqual({
      hoursText: "11h–15h / 18h–23h",
    });
    return candidates;
  }

  it("UNKNOWN when a ScheduleOverride is present, even with a VALID derived value", async () => {
    const ledger = new EvidenceLedger("turn-override");
    recordStoreHours(ledger, HOURS_READ);
    const candidates = await derivedCandidates(ledger);
    // A PRESENT per-date override contradicts today's weekly hours (D1 falsifier).
    recordFalsifier(ledger, "schedule:schedule_override", {
      date: "2026-06-29",
      isOpen: false,
    });

    const result = runClaimsKernel(
      ledger,
      candidates,
      createIbatexasClaimsKernelDeps({ now: () => NOW }),
    );
    expect(result.perClaim[0]?.verdict).toBe("UNKNOWN"); // falsifier fired
    expect(result.renderable).toHaveLength(0);
    const out = render(result.renderableCanonical, result.terminal);
    // Safe-degrade: no derived hours asserted.
    expect(out.text).not.toContain("11h");
  });

  it("UNKNOWN when a holiday is present, even with a VALID derived value", async () => {
    const ledger = new EvidenceLedger("turn-holiday");
    recordStoreHours(ledger, HOURS_READ);
    const candidates = await derivedCandidates(ledger);
    // A PRESENT holiday contradicts today's weekly hours (D1 falsifier).
    recordFalsifier(ledger, "schedule:holiday", {
      date: "2026-12-25",
      label: "Natal",
    });

    const result = runClaimsKernel(
      ledger,
      candidates,
      createIbatexasClaimsKernelDeps({ now: () => NOW }),
    );
    expect(result.perClaim[0]?.verdict).toBe("UNKNOWN"); // falsifier fired
    expect(result.renderable).toHaveLength(0);
    const out = render(result.renderableCanonical, result.terminal);
    expect(out.text).not.toContain("11h");
  });
});

// ── (3) CONTROL — C6 still REFUSES a model-authored value that disagrees ────────

describe("BKL-121 — C6 still REFUSES a seeded mismatch (we replaced the AUTHOR, not the CHECK)", () => {
  it("REFUSED when a NON-derived (model) value contradicts the ledger value", () => {
    // Bypass derivation: build the candidate DIRECTLY with a wrong model value.
    const mismatched = selectCandidateClaim({
      type: "STORE_HOURS",
      subject: "loja",
      actor: "system",
      value: { hoursText: "9h–12h" }, // the model said "9h–12h"…
    }) as CandidateClaim;

    const ledger = new EvidenceLedger("turn-mismatch");
    recordStoreHours(ledger, HOURS_READ); // …but the ledger says "11h–15h / 18h–23h"

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

// ── (4) UNKNOWN SAFE-DEGRADE (renderer) ────────────────────────────────────────

describe("BKL-121 — an UNKNOWN STORE_HOURS renders the safe self-report (no hours fact)", () => {
  it("renders the proposition-free UNKNOWN template, never an hours proposition", () => {
    const out = renderRenderables(
      [{ subject: "loja", type: "STORE_HOURS", verdict: "UNKNOWN", value: { hoursText: "11h–15h" } }],
      "RENDER",
    );
    // The safe self-report — asserts nothing about the schedule.
    expect(out.text).toContain("Não localizei essa informação confirmada agora");
    expect(out.text).not.toContain("11h");
    expect(out.lines[0]?.kind).toBe("ABSTENTION");
  });
});
