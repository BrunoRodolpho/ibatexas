/**
 * BKL-138 — the STORE_HOURS_FOR_DATE validated render chain (SCN-002/003), end-to-end
 * through the REAL @adjudicate/core kernel (NOT a stub). The day-specific twin of the
 * BKL-121 STORE_HOURS chain: NL date → resolved ISO subject → date-keyed evidence read
 * → value-binding → date-keyed falsifiers → derive → template. Pins:
 *
 *   1. NL-DATE → SUBJECT → DERIVED-VALUE → VALIDATED → RENDER: the 4B emits a TYPE-ONLY
 *      proposal (no value, and its `subject` is IGNORED); the planner DETERMINISTICALLY
 *      resolves the queried ISO date from the request text and DERIVES `value.hoursText`
 *      from the SAME per-date read the investigator records, so C6 passes BY
 *      CONSTRUCTION and the claim VALIDATEs + renders that day's REAL hours.
 *   2. A FALSIFIER ON THE QUERIED DATE STILL DEMOTES (SCN-003): a present
 *      `schedule:holiday:{date}` OR `schedule:schedule_override:{date}` → UNKNOWN.
 *   3. TODAY'S HOLIDAY DOES NOT POISON A FUTURE DATE (SCN-003 soundness pin — the OTHER
 *      direction): the BARE `schedule:holiday` (today's) present in the ledger does NOT
 *      demote a clean future-date claim, because the falsifier key is date-SUFFIXED.
 *   4. C6 STILL REFUSES A SEEDED MISMATCH (control): a model-authored value that
 *      disagrees with the ledger → REFUSED (we replaced the AUTHOR, not the CHECK).
 *   5. UNKNOWN SAFE-DEGRADE (renderer): an UNKNOWN STORE_HOURS_FOR_DATE renders the
 *      proposition-free safe self-report — never an hours fact.
 *   6. TTL is enforced in ms (BKL-121/-125 regression) + genuine staleness demotes.
 *
 * Pure unit tests — a hand-built ModelProvider mock + real EvidenceLedger, a FROZEN
 * clock so the resolved date is deterministic; no DB / no live model.
 */

import { describe, expect, it } from "vitest";
import {
  EvidenceLedger,
  runClaimsKernel,
  type CandidateClaim,
} from "@adjudicate/core";
import type { CognitiveState, Completion, ModelProvider } from "@claustrum/core";
import {
  createIbatexasPlanner,
  PROPOSE_CLAIM_TOOL,
} from "../ibatexas-planner.js";
import { selectCandidateClaim } from "../claim-registry.js";
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
    perception: { text, channel: "web", receivedAt: "2026-07-10T15:00:00.000Z" },
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

const NOW = 10_000;
/** FROZEN request-side clock: Friday 2026-07-10 12:00 in São Paulo. So "domingo"
 *  resolves to the next Sunday, 2026-07-12. */
const FRI_NOON_MS = new Date("2026-07-10T15:00:00Z").getTime();
const SUNDAY = "2026-07-12";

/** The queried Sunday's operating-hours read the investigator would record + the
 *  planner derives (byte-equal, keyed by the resolved date). */
const HOURS_READ = { hoursText: "11h–15h / 18h–23h" } as const;

/** A STORE_HOURS_FOR_DATE planner wired to resolve the queried day's hours + freeze
 *  the request clock (so "domingo" → 2026-07-12 deterministically). */
function datePlanner(
  resolveHoursForDate: (isoDate: string) => { hoursText: string } | undefined,
) {
  return createIbatexasPlanner({
    model: mockModel([claimCall({ type: "STORE_HOURS_FOR_DATE", subject: "ignored" })]),
    modelId: "mock",
    capabilityPlanners: [],
    resolveHoursForDate,
    now: () => FRI_NOON_MS,
  });
}

/** Record the date-keyed hours entry the investigator would mint (`:{date}` suffix). */
function recordHoursForDate(ledger: EvidenceLedger, date: string, value: unknown): void {
  ledger.record({
    key: `schedule:store_hours:${date}`,
    value,
    source: "schedule.getHoursTextForDate",
    fetchedAt: NOW,
    sourceMode: "live",
    taint: "TRUSTED",
    originProvenance: "FIRST_PARTY",
  });
}

/** Record a PRESENT ledger entry under an arbitrary key (a falsifier — bare or dated). */
function recordEntry(ledger: EvidenceLedger, key: string, value: unknown): void {
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

// ── (1) NL-DATE → SUBJECT → DERIVED VALUE → VALIDATED → RENDER ───────────────────

describe("BKL-138 — tag→resolve-date→derive→VALIDATED for STORE_HOURS_FOR_DATE (real kernel)", () => {
  it("resolves the queried date, derives its hoursText, VALIDATEs + renders that day's hours", async () => {
    const planner = datePlanner(() => HOURS_READ);
    const plan = await planner.proposeClaims(state("qual o horário de domingo?"));

    expect(plan.candidates).toHaveLength(1);
    const candidate = plan.candidates[0] as CandidateClaim;
    expect(candidate.type).toBe("STORE_HOURS_FOR_DATE");
    // The model's `subject` was IGNORED — the planner resolved the ISO date itself.
    expect(candidate.subject).toBe(SUNDAY);
    // The value was DERIVED (model authored none).
    expect(candidate.value).toEqual({ hoursText: "11h–15h / 18h–23h" });
    // The evidence + falsifier keys are DATE-SUFFIXED (perResourceKey parameterization).
    expect(candidate.soundness.requiredEvidence[0]?.key).toBe(
      `schedule:store_hours:${SUNDAY}`,
    );
    expect(candidate.soundness.falsifierComplete).toBe(true);
    expect(candidate.soundness.falsifiers?.map((f) => f.key)).toEqual([
      `schedule:schedule_override:${SUNDAY}`,
      `schedule:holiday:${SUNDAY}`,
    ]);

    // Real kernel against a ledger whose DATE-KEYED entry is byte-equal to the derived
    // value → C6 PASSes; no override/holiday on that date → both falsifiers inert →
    // VALIDATED.
    const ledger = new EvidenceLedger("turn-1");
    recordHoursForDate(ledger, SUNDAY, HOURS_READ);
    const result = runClaimsKernel(
      ledger,
      plan.candidates,
      createIbatexasClaimsKernelDeps({ now: () => NOW }),
    );

    expect(result.perClaim[0]?.verdict).toBe("VALIDATED");
    expect(result.terminal).toBe("RENDER");
    const out = render(result.renderableCanonical, result.terminal);
    expect(out.text).toBe("Nesse dia, nosso horário de funcionamento é: 11h–15h / 18h–23h.");
  });

  it("VALIDATEs a 'fechado' day the same way (evidence-bound, not an absence)", async () => {
    const planner = datePlanner(() => ({ hoursText: "fechado" }));
    const plan = await planner.proposeClaims(state("abrem no domingo?"));
    expect((plan.candidates[0] as CandidateClaim).value).toEqual({ hoursText: "fechado" });

    const ledger = new EvidenceLedger("turn-fechado");
    recordHoursForDate(ledger, SUNDAY, { hoursText: "fechado" });
    const result = runClaimsKernel(
      ledger,
      plan.candidates,
      createIbatexasClaimsKernelDeps({ now: () => NOW }),
    );
    expect(result.perClaim[0]?.verdict).toBe("VALIDATED");
    const out = render(result.renderableCanonical, result.terminal);
    expect(out.text).toBe("Nesse dia, nosso horário de funcionamento é: fechado.");
  });

  it("VALIDATEs with realistic model latency between the read and validation (ttl in ms)", async () => {
    const planner = datePlanner(() => HOURS_READ);
    const plan = await planner.proposeClaims(state("horário de domingo?"));
    const ledger = new EvidenceLedger("turn-latency");
    recordHoursForDate(ledger, SUNDAY, HOURS_READ);
    const result = runClaimsKernel(
      ledger,
      plan.candidates,
      createIbatexasClaimsKernelDeps({ now: () => NOW + 15_000 }), // 15s later
    );
    expect(result.perClaim[0]?.verdict).toBe("VALIDATED");
  });

  it("demotes to UNKNOWN when the evidence is GENUINELY stale (older than the 1h bound)", async () => {
    const planner = datePlanner(() => HOURS_READ);
    const plan = await planner.proposeClaims(state("horário de domingo?"));
    const ledger = new EvidenceLedger("turn-stale");
    recordHoursForDate(ledger, SUNDAY, HOURS_READ);
    const result = runClaimsKernel(
      ledger,
      plan.candidates,
      createIbatexasClaimsKernelDeps({ now: () => NOW + 2 * 3_600_000 }), // 2h later
    );
    expect(result.perClaim[0]?.verdict).toBe("UNKNOWN");
    expect(result.terminal).not.toBe("RENDER");
  });

  it("stays UNKNOWN when no per-date read is available (value undefined → C6 ABSTAIN)", async () => {
    // No resolveHoursForDate wired → the candidate keeps value undefined.
    const planner = datePlanner(() => undefined);
    const plan = await planner.proposeClaims(state("horário de domingo?"));
    expect((plan.candidates[0] as CandidateClaim).value).toBeUndefined();
    const ledger = new EvidenceLedger("turn-absent");
    recordHoursForDate(ledger, SUNDAY, HOURS_READ);
    const result = runClaimsKernel(
      ledger,
      plan.candidates,
      createIbatexasClaimsKernelDeps({ now: () => NOW }),
    );
    expect(result.perClaim[0]?.verdict).toBe("UNKNOWN");
  });
});

// ── (2) A FALSIFIER ON THE QUERIED DATE STILL DEMOTES (SCN-003, direction A) ─────

describe("BKL-138 — a holiday/override ON THE QUERIED DATE demotes the derived claim", () => {
  async function derivedCandidates(): Promise<readonly CandidateClaim[]> {
    const planner = datePlanner(() => HOURS_READ);
    const plan = await planner.proposeClaims(state("qual o horário de domingo?"));
    expect((plan.candidates[0] as CandidateClaim).value).toEqual(HOURS_READ);
    return plan.candidates;
  }

  it("UNKNOWN when a holiday is present ON the queried date (SCN-003 abstain)", async () => {
    const candidates = await derivedCandidates();
    const ledger = new EvidenceLedger("turn-holiday-on-date");
    recordHoursForDate(ledger, SUNDAY, HOURS_READ);
    recordEntry(ledger, `schedule:holiday:${SUNDAY}`, { date: SUNDAY, label: "Feriado" });
    const result = runClaimsKernel(
      ledger,
      candidates,
      createIbatexasClaimsKernelDeps({ now: () => NOW }),
    );
    expect(result.perClaim[0]?.verdict).toBe("UNKNOWN");
    const out = render(result.renderableCanonical, result.terminal);
    expect(out.text).not.toContain("11h");
  });

  it("UNKNOWN when a ScheduleOverride is present ON the queried date", async () => {
    const candidates = await derivedCandidates();
    const ledger = new EvidenceLedger("turn-override-on-date");
    recordHoursForDate(ledger, SUNDAY, HOURS_READ);
    recordEntry(ledger, `schedule:schedule_override:${SUNDAY}`, {
      date: SUNDAY,
      isOpen: false,
    });
    const result = runClaimsKernel(
      ledger,
      candidates,
      createIbatexasClaimsKernelDeps({ now: () => NOW }),
    );
    expect(result.perClaim[0]?.verdict).toBe("UNKNOWN");
  });
});

// ── (3) TODAY'S HOLIDAY DOES NOT POISON A FUTURE DATE (SCN-003, direction B) ─────

describe("BKL-138 — TODAY's holiday/override does NOT demote a clean future-date claim", () => {
  it("VALIDATEs the Sunday claim even though TODAY (a different date) is a holiday", async () => {
    const planner = datePlanner(() => HOURS_READ);
    const plan = await planner.proposeClaims(state("qual o horário de domingo?"));

    const ledger = new EvidenceLedger("turn-today-holiday");
    recordHoursForDate(ledger, SUNDAY, HOURS_READ);
    // TODAY's holiday/override under the BARE keys (what STORE_HOURS/STORE_OPEN_NOW read)
    // — these must NOT fire the DATE-SUFFIXED falsifiers of the Sunday claim.
    recordEntry(ledger, "schedule:holiday", { date: "2026-07-10", label: "Feriado hoje" });
    recordEntry(ledger, "schedule:schedule_override", { date: "2026-07-10", isOpen: false });

    const result = runClaimsKernel(
      ledger,
      plan.candidates,
      createIbatexasClaimsKernelDeps({ now: () => NOW }),
    );
    expect(result.perClaim[0]?.verdict).toBe("VALIDATED");
    const out = render(result.renderableCanonical, result.terminal);
    expect(out.text).toBe("Nesse dia, nosso horário de funcionamento é: 11h–15h / 18h–23h.");
  });
});

// ── (4) CONTROL — C6 still REFUSES a model-authored value that disagrees ─────────

describe("BKL-138 — C6 still REFUSES a seeded mismatch (we replaced the AUTHOR, not the CHECK)", () => {
  it("REFUSED when a NON-derived (model) value contradicts the ledger value", () => {
    // Build the candidate DIRECTLY with a wrong model value + the resolved date subject.
    const mismatched = selectCandidateClaim({
      type: "STORE_HOURS_FOR_DATE",
      subject: SUNDAY,
      actor: "system",
      value: { hoursText: "9h–12h" }, // the model said "9h–12h"…
    }) as CandidateClaim;

    const ledger = new EvidenceLedger("turn-mismatch");
    recordHoursForDate(ledger, SUNDAY, HOURS_READ); // …but the ledger says otherwise

    const result = runClaimsKernel(
      ledger,
      [mismatched],
      createIbatexasClaimsKernelDeps({ now: () => NOW }),
    );
    expect(result.perClaim[0]?.verdict).toBe("REFUSED");
    expect(result.renderable).toHaveLength(0);
  });
});

// ── (5) UNKNOWN SAFE-DEGRADE (renderer) ──────────────────────────────────────────

describe("BKL-138 — an UNKNOWN STORE_HOURS_FOR_DATE renders the safe self-report (no hours)", () => {
  it("renders the proposition-free UNKNOWN template, never an hours proposition", () => {
    const out = renderRenderables(
      [
        {
          subject: SUNDAY,
          type: "STORE_HOURS_FOR_DATE",
          verdict: "UNKNOWN",
          value: { hoursText: "11h–15h" },
        },
      ],
      "RENDER",
    );
    expect(out.text).toContain("Não localizei essa informação confirmada agora");
    expect(out.text).not.toContain("11h");
    expect(out.lines[0]?.kind).toBe("ABSTENTION");
  });
});
